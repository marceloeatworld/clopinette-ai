import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentConfigRow, InferenceConfig, Platform } from "../config/types.js";
import { DEFAULT_MODEL, AUXILIARY_MODEL, isWorkersAiModel } from "../config/constants.js";
import { deriveMasterKey, decrypt } from "../crypto.js";

import type { SqlFn } from "../config/sql.js";

export type Plan = "trial" | "pro" | "byok" | undefined;

/**
 * Telemetry tagged onto every AI Gateway call via the `cf-aig-metadata` header.
 * Surfaces in the AI Gateway dashboard as per-user / per-session / per-purpose
 * cost and latency breakdowns without extra logging infrastructure.
 */
export type TelemetryContext = {
  userId?: string;
  sessionId?: string;
  platform?: Platform;
  purpose?: "primary" | "auxiliary" | "fallback" | "delegate" | "delegateAux" | "selfLearning";
};

function buildMetadataFetch(telemetry?: TelemetryContext): typeof fetch | undefined {
  if (!telemetry) return undefined;
  const metadata: Record<string, string> = {};
  if (telemetry.userId) metadata.userId = telemetry.userId;
  if (telemetry.sessionId) metadata.sessionId = telemetry.sessionId;
  if (telemetry.platform) metadata.platform = telemetry.platform;
  if (telemetry.purpose) metadata.purpose = telemetry.purpose;
  if (Object.keys(metadata).length === 0) return undefined;
  const header = JSON.stringify(metadata);
  const globalFetch = fetch;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cf-aig-metadata", header);
    return globalFetch(input as RequestInfo, { ...init, headers });
  };
}

/**
 * Thrown when a BYOK user would otherwise consume Workers AI.
 *
 * BYOK is the free-with-your-own-key plan: those users must NEVER touch the
 * Workers AI binding (which we pay for). Instead of silently falling back to
 * Gemma we raise this typed error so the pipeline can surface a clean
 * "Configure your provider" message and the user fixes their setup.
 */
export class PlanViolationError extends Error {
  readonly kind = "plan_violation";
  constructor(message: string) {
    super(message);
    this.name = "PlanViolationError";
  }
}

function isByok(plan: Plan): boolean {
  return plan === "byok";
}

/**
 * Create an AI SDK model from inference config.
 *
 * BYOK path: @ai-sdk/openai with AI Gateway baseURL swap.
 * Managed path: workers-ai-provider with Workers AI binding.
 *
 * @throws PlanViolationError when `plan === "byok"` and the config does not
 * resolve to a BYOK provider (no apiKey, no provider, or provider === workers-ai).
 */
export function createModel(
  config: InferenceConfig,
  env: { AI: Ai; CF_ACCOUNT_ID: string; CF_GATEWAY_ID: string },
  modelOverride?: string,
  options?: { sessionAffinity?: string; plan?: Plan; telemetry?: TelemetryContext }
): LanguageModel {
  const configuredModel = modelOverride ?? config.model ?? DEFAULT_MODEL;
  const plan = options?.plan;

  if (config.apiKey && config.provider && config.provider !== "workers-ai") {
    const customFetch = buildMetadataFetch(options?.telemetry);
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/${config.provider}`,
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return provider(configuredModel);
  }

  // No usable BYOK credentials at this point. BYOK plan is forbidden from
  // touching Workers AI — fail loudly so the pipeline can surface a clean error.
  if (isByok(plan)) {
    throw new PlanViolationError(
      "BYOK plan requires a configured provider with a valid API key. " +
      "Set provider, model, and api_key in Settings → Provider.",
    );
  }

  // trial / pro path: runtime safety — if the stored model belongs to a BYOK provider
  // (e.g. user deleted their key but provider/model entries remain), fall back to DEFAULT_MODEL.
  const workersAiModel = isWorkersAiModel(configuredModel) ? configuredModel : DEFAULT_MODEL;
  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(workersAiModel, {
    ...(options?.sessionAffinity ? { sessionAffinity: options.sessionAffinity } : {}),
  });
}

/**
 * Build the auxiliary model used by compression, self-learning, web summarization,
 * and browser snapshots. Returns the model + the model id (for usage tracking).
 *
 * - BYOK plan → auxiliary must come from a configured BYOK provider. Throws
 *   PlanViolationError if neither auxiliary nor primary BYOK config is usable.
 * - trial / pro → uses the configured auxiliary model when present, otherwise
 *   falls back to Workers AI Gemma (DEFAULT_MODEL).
 */
export function createAuxiliaryModel(
  config: InferenceConfig,
  env: { AI: Ai; CF_ACCOUNT_ID: string; CF_GATEWAY_ID: string },
  plan: Plan,
  telemetry?: TelemetryContext,
): { model: LanguageModel; modelId: string } {
  const auxProvider = config.auxiliaryProvider ?? config.provider;
  const auxApiKey = config.auxiliaryApiKey ?? config.apiKey;
  const auxModelId = config.auxiliaryModel ?? config.model;

  // BYOK auxiliary route — requires a real BYOK provider + key.
  if (auxApiKey && auxProvider && auxProvider !== "workers-ai") {
    const customFetch = buildMetadataFetch(telemetry);
    const provider = createOpenAI({
      apiKey: auxApiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/${auxProvider}`,
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return { model: provider(auxModelId), modelId: auxModelId };
  }

  if (isByok(plan)) {
    throw new PlanViolationError(
      "BYOK plan requires a configured auxiliary provider for compression and " +
      "background work. Set provider + api_key in Settings → Provider.",
    );
  }

  // trial / pro → free Workers AI auxiliary (Gemma).
  const modelId = isWorkersAiModel(auxModelId) ? auxModelId : AUXILIARY_MODEL;
  const workersai = createWorkersAI({ binding: env.AI });
  return { model: workersai(modelId), modelId };
}

/**
 * Load inference config from DO SQLite, decrypting API key if needed.
 * Shared between WebSocket (agent.ts) and Telegram (telegram.ts) paths.
 *
 * Per-provider schema with legacy fallbacks:
 *   api_key: api_key:{provider} → legacy api_key
 *   model:   model:{provider}   → legacy model → DEFAULT_MODEL
 *
 * @throws PlanViolationError when `plan === "byok"` and the loaded config does
 * not produce a usable BYOK provider — keeps BYOK users off the Workers AI bill.
 */
export async function loadInferenceConfig(
  sql: SqlFn,
  masterKey: string,
  plan?: Plan,
): Promise<InferenceConfig> {
  const rows = sql<AgentConfigRow>`
    SELECT key, value, encrypted FROM agent_config
    WHERE key IN ('api_key', 'provider', 'model', 'auxiliary_provider')
       OR key LIKE 'api_key:%' OR key LIKE 'model:%' OR key LIKE 'auxiliary_model:%'
  `;

  const map = new Map(rows.map((r) => [r.key, r]));
  const provider = map.get("provider")?.value;
  const auxiliaryProviderStored = map.get("auxiliary_provider")?.value;

  // Prefer per-provider key; fall back to legacy single api_key
  const apiKeyRow = (provider ? map.get(`api_key:${provider}`) : undefined) ?? map.get("api_key");

  // Prefer per-provider model; fall back to legacy single model; finally DEFAULT_MODEL
  const modelRow = (provider ? map.get(`model:${provider}`) : undefined) ?? map.get("model");
  const model = modelRow?.value ?? DEFAULT_MODEL;

  // Effective auxiliary provider: explicit config, or falls back to primary
  const auxiliaryProvider = auxiliaryProviderStored ?? provider;

  // Auxiliary model: auxiliary_model:{auxiliaryProvider} if set, else smart default
  const auxiliaryConfigured = auxiliaryProvider ? map.get(`auxiliary_model:${auxiliaryProvider}`)?.value : undefined;
  let auxiliaryModel: string;
  if (auxiliaryConfigured) {
    auxiliaryModel = auxiliaryConfigured;
  } else if (!auxiliaryProvider || auxiliaryProvider === "workers-ai") {
    auxiliaryModel = AUXILIARY_MODEL;
  } else {
    auxiliaryModel = model; // BYOK fallback — reuse primary model to avoid misrouting
  }

  // Resolve credentials for both primary and auxiliary providers (may share if same provider)
  const mk = await deriveMasterKey(masterKey);
  const decryptRow = async (row: AgentConfigRow | undefined): Promise<string | undefined> => {
    if (!row) return undefined;
    if (row.encrypted) return decrypt(row.value, mk);
    return row.value;
  };
  const apiKey = await decryptRow(apiKeyRow);
  // Auxiliary key: same as primary if providers match, otherwise load api_key:{auxiliaryProvider}
  let auxiliaryApiKey: string | undefined;
  if (auxiliaryProvider && auxiliaryProvider !== "workers-ai") {
    if (auxiliaryProvider === provider) {
      auxiliaryApiKey = apiKey;
    } else {
      auxiliaryApiKey = await decryptRow(map.get(`api_key:${auxiliaryProvider}`));
    }
  }

  // BYOK gate: a BYOK user must have a real provider + key. Otherwise the
  // pipeline would happily fall back to Workers AI on the next createModel call,
  // which is exactly the leak we want to close.
  if (isByok(plan)) {
    if (!provider || provider === "workers-ai" || !apiKey) {
      throw new PlanViolationError(
        "BYOK plan requires provider, model, and api_key to be set. " +
        "Open Settings → Provider and add a BYOK provider with a valid key.",
      );
    }
  }

  return {
    apiKey,
    provider,
    model,
    auxiliaryProvider: auxiliaryProviderStored,
    auxiliaryApiKey,
    auxiliaryModel,
  };
}

/**
 * Load fallback model config — used when the primary model fails.
 *
 * - trial/pro: falls back to Workers AI Gemma (free, always available).
 * - byok: returns null. We never silently move BYOK traffic to Workers AI;
 *   the pipeline surfaces the original provider error instead.
 */
export async function loadFallbackConfig(
  sql: SqlFn,
  env: { AI: Ai; CF_ACCOUNT_ID: string; CF_GATEWAY_ID: string; MASTER_KEY: string },
  plan?: Plan,
): Promise<InferenceConfig | null> {
  if (isByok(plan)) return null;

  const primary = await loadInferenceConfig(sql, env.MASTER_KEY, plan);
  if (primary.apiKey) {
    // Primary was BYOK on a non-BYOK plan (pro user) — fall back to free Workers AI
    return { model: DEFAULT_MODEL, auxiliaryModel: AUXILIARY_MODEL };
  }
  // Primary was already Workers AI — no useful fallback
  return null;
}
