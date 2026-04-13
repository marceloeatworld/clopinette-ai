/**
 * Pricing table — USD per 1M tokens.
 *
 * Keyed on the raw model id as stored in `sessions.model`. Values are
 * approximate and may lag provider changes — the estimate shown to users
 * includes `PRICING_UPDATED_AT` so they know the freshness of the numbers.
 *
 * Workers AI models are normalized from CF's neuron-based pricing to an
 * equivalent $/1M-tokens rate for comparability.
 *
 * Usage:
 *   import { estimateCost } from "./pricing.js";
 *   const usd = estimateCost(row.model, row.inputTokens, row.outputTokens);
 */

export const PRICING_UPDATED_AT = "2026-04-11";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Conservative default when a model isn't in the table — keeps estimates meaningful. */
const DEFAULT_PRICING: ModelPricing = { inputPer1M: 0.5, outputPer1M: 1.5 };

const PRICING: Record<string, ModelPricing> = {
  // ── Cloudflare Workers AI ──────────────────────────────────────────────
  "@cf/moonshotai/kimi-k2.5":               { inputPer1M: 0.50, outputPer1M: 2.00 },
  "@cf/google/gemma-4-26b-a4b-it":          { inputPer1M: 0.10, outputPer1M: 0.40 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputPer1M: 0.29, outputPer1M: 2.25 },
  "@cf/qwen/qwen-3-8b":                     { inputPer1M: 0.05, outputPer1M: 0.20 },
  "@cf/openai/whisper-large-v3-turbo":      { inputPer1M: 0.00, outputPer1M: 0.00 }, // neuron-billed

  // ── OpenAI ─────────────────────────────────────────────────────────────
  "gpt-5":         { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-5-mini":    { inputPer1M: 0.25,  outputPer1M: 1.00 },
  "gpt-5-nano":    { inputPer1M: 0.05,  outputPer1M: 0.40 },
  "gpt-4o":        { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-4o-mini":   { inputPer1M: 0.15,  outputPer1M: 0.60 },
  "o3":            { inputPer1M: 10.00, outputPer1M: 40.00 },
  "o3-mini":       { inputPer1M: 1.10,  outputPer1M: 4.40 },

  // ── Anthropic ──────────────────────────────────────────────────────────
  "claude-opus-4-6":         { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-sonnet-4-6":       { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-sonnet-4-5":       { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-haiku-4-5":        { inputPer1M: 1.00,  outputPer1M: 5.00 },
  "claude-haiku-4-5-20251001": { inputPer1M: 1.00, outputPer1M: 5.00 },

  // ── Google ─────────────────────────────────────────────────────────────
  "gemini-2.5-pro":   { inputPer1M: 1.25,  outputPer1M: 10.00 },
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.30 },

  // ── Groq ───────────────────────────────────────────────────────────────
  "llama-3.3-70b-versatile":       { inputPer1M: 0.59, outputPer1M: 0.79 },
  "llama-3.1-8b-instant":          { inputPer1M: 0.05, outputPer1M: 0.08 },
  "deepseek-r1-distill-llama-70b": { inputPer1M: 0.75, outputPer1M: 0.99 },

  // ── DeepSeek ───────────────────────────────────────────────────────────
  "deepseek-chat":     { inputPer1M: 0.27, outputPer1M: 1.10 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },

  // ── xAI ────────────────────────────────────────────────────────────────
  "grok-4":      { inputPer1M: 3.00, outputPer1M: 15.00 },
  "grok-4-mini": { inputPer1M: 0.30, outputPer1M: 0.50 },

  // ── Mistral ────────────────────────────────────────────────────────────
  "mistral-large-latest": { inputPer1M: 2.00, outputPer1M: 6.00 },
  "mistral-small-latest": { inputPer1M: 0.20, outputPer1M: 0.60 },

  // ── Internal / synthetic rows produced by the pipeline ────────────────
  "delegate-workflow": { inputPer1M: 0.50, outputPer1M: 2.00 }, // legacy synthetic row from older delegate tracking
};

/** Look up pricing for a model id, with graceful fallback. */
function lookup(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model];
  // Strip provider prefix and retry (e.g. `anthropic/claude-…`)
  const slash = model.lastIndexOf("/");
  if (slash >= 0 && PRICING[model.slice(slash + 1)]) return PRICING[model.slice(slash + 1)];
  return DEFAULT_PRICING;
}

/** Estimate the USD cost of a call given the raw token counts. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = lookup(model);
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}

/** Whether the table has an exact match for a model id (used by `/insights` to warn on defaults). */
export function isKnownModel(model: string): boolean {
  if (PRICING[model]) return true;
  const slash = model.lastIndexOf("/");
  return slash >= 0 && !!PRICING[model.slice(slash + 1)];
}
