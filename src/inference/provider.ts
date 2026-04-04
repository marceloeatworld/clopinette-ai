import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentConfigRow, InferenceConfig } from "../config/types.js";
import { DEFAULT_MODEL, AUXILIARY_MODEL, isWorkersAiModel } from "../config/constants.js";
import { deriveMasterKey, decrypt } from "../crypto.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Create an AI SDK model from inference config.
 *
 * BYOK path: @ai-sdk/openai with AI Gateway baseURL swap.
 * Managed path: workers-ai-provider with Workers AI binding.
 */
export function createModel(
  config: InferenceConfig,
  env: { AI: Ai; CF_ACCOUNT_ID: string; CF_GATEWAY_ID: string },
  modelOverride?: string,
  options?: { sessionAffinity?: string }
): LanguageModel {
  const configuredModel = modelOverride ?? config.model ?? DEFAULT_MODEL;

  if (config.apiKey && config.provider && config.provider !== "workers-ai") {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/${config.provider}`,
    });
    return provider(configuredModel);
  }

  // Workers AI path: runtime safety — if the stored model belongs to a BYOK provider
  // (e.g. user deleted their key but provider/model entries remain), fall back to DEFAULT_MODEL
  // rather than asking the AI binding for a model it cannot serve.
  const workersAiModel = isWorkersAiModel(configuredModel) ? configuredModel : DEFAULT_MODEL;
  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(workersAiModel, {
    ...(options?.sessionAffinity ? { sessionAffinity: options.sessionAffinity } : {}),
  });
}

/**
 * Load inference config from DO SQLite, decrypting API key if needed.
 * Shared between WebSocket (agent.ts) and Telegram (telegram.ts) paths.
 *
 * Per-provider schema with legacy fallbacks:
 *   api_key: api_key:{provider} → legacy api_key
 *   model:   model:{provider}   → legacy model → DEFAULT_MODEL
 */
export async function loadInferenceConfig(
  sql: SqlFn,
  masterKey: string
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
 * Falls back to Workers AI (free, always available) with the default model.
 */
export async function loadFallbackConfig(
  sql: SqlFn,
  env: { AI: Ai; CF_ACCOUNT_ID: string; CF_GATEWAY_ID: string; MASTER_KEY: string }
): Promise<InferenceConfig | null> {
  // If primary was BYOK, fallback to Workers AI default
  const primary = await loadInferenceConfig(sql, env.MASTER_KEY);
  if (primary.apiKey) {
    // Primary was BYOK — fall back to free Workers AI
    return { model: DEFAULT_MODEL, auxiliaryModel: AUXILIARY_MODEL };
  }
  // Primary was already Workers AI — no useful fallback
  return null;
}
