import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AgentConfigRow, InferenceConfig } from "../config/types.js";
import { DEFAULT_MODEL } from "../config/constants.js";
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
  const modelId = modelOverride ?? config.model ?? DEFAULT_MODEL;

  if (config.apiKey && config.provider) {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/${config.provider}`,
    });
    return provider(modelId);
  }

  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(modelId, {
    ...(options?.sessionAffinity ? { sessionAffinity: options.sessionAffinity } : {}),
  });
}

/**
 * Load inference config from DO SQLite, decrypting API key if needed.
 * Shared between WebSocket (agent.ts) and Telegram (telegram.ts) paths.
 */
export async function loadInferenceConfig(
  sql: SqlFn,
  masterKey: string
): Promise<InferenceConfig> {
  const rows = sql<AgentConfigRow>`
    SELECT key, value, encrypted FROM agent_config
    WHERE key IN ('api_key', 'provider', 'model')
  `;

  const map = new Map(rows.map((r) => [r.key, r]));
  const modelRow = map.get("model");
  const providerRow = map.get("provider");
  const apiKeyRow = map.get("api_key");

  let apiKey: string | undefined;
  if (apiKeyRow && apiKeyRow.encrypted) {
    const mk = await deriveMasterKey(masterKey);
    apiKey = await decrypt(apiKeyRow.value, mk);
  } else if (apiKeyRow) {
    apiKey = apiKeyRow.value;
  }

  return {
    apiKey,
    provider: providerRow?.value,
    model: modelRow?.value ?? DEFAULT_MODEL,
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
    return { model: DEFAULT_MODEL };
  }
  // Primary was already Workers AI — no useful fallback
  return null;
}
