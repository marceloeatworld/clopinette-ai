/**
 * Secret redaction for logs, tool outputs, and persisted messages.
 *
 * Defense in depth: even if a tool result or an error message accidentally
 * surfaces an API key, we scrub it before it reaches logs, SQLite storage,
 * or the model's next-turn context.
 *
 * Inspired by hermes-agent's `redact.py`. Patterns cover the major providers
 * Clopinette interacts with (Workers AI / OpenAI / Anthropic / Google /
 * Groq / xAI / Mistral / DeepSeek / HuggingFace / Replicate / Cohere /
 * GitHub / Slack / Stripe / Telegram / Discord / Cloudflare).
 *
 * The enable flag is a module-local const initialized at load time — there
 * is no runtime setter, so a prompt-injection cannot disable redaction by
 * manipulating the agent's own globals.
 */

/** Snapshot-frozen at module load. No setter, no runtime override. */
const ENABLED = true;

/** Mask format: keep first 6 and last 4 characters, replace the middle with `…`. */
function mask(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

interface SecretPattern {
  name: string;
  re: RegExp;
}

/**
 * Regex patterns matching known API-key formats.
 * Each regex MUST use the `g` flag so `.replace()` scrubs all occurrences in one pass.
 * Ordering matters: more specific prefixes must come before generic ones
 * (e.g. `sk-ant-` before `sk-` so Anthropic keys aren't mis-masked as OpenAI).
 */
const PATTERNS: SecretPattern[] = [
  // Anthropic — must come before OpenAI's sk- prefix
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,200}\b/g },
  // OpenAI (project + legacy)
  { name: "openai-project", re: /\bsk-proj-[A-Za-z0-9_-]{20,200}\b/g },
  { name: "openai", re: /\bsk-[A-Za-z0-9_-]{20,200}\b/g },
  // Groq
  { name: "groq", re: /\bgsk_[A-Za-z0-9]{30,200}\b/g },
  // Google Generative AI
  { name: "google-genai", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // xAI (Grok)
  { name: "xai", re: /\bxai-[A-Za-z0-9]{40,200}\b/g },
  // DeepSeek — follows OpenAI-like scheme (already caught by openai pattern, kept for clarity)
  // Perplexity
  { name: "perplexity", re: /\bpplx-[A-Za-z0-9]{30,120}\b/g },
  // HuggingFace
  { name: "huggingface", re: /\bhf_[A-Za-z0-9]{30,200}\b/g },
  // Replicate
  { name: "replicate", re: /\br8_[A-Za-z0-9]{30,80}\b/g },
  // Cohere
  { name: "cohere", re: /\bco-[A-Za-z0-9]{30,80}\b/g },
  // GitHub
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{30,80}\b/g },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{30,80}\b/g },
  { name: "github-user", re: /\bghu_[A-Za-z0-9]{30,80}\b/g },
  { name: "github-server", re: /\bghs_[A-Za-z0-9]{30,80}\b/g },
  { name: "github-refresh", re: /\bghr_[A-Za-z0-9]{30,80}\b/g },
  // Slack
  { name: "slack", re: /\bxox[bparos]-[A-Za-z0-9-]{10,200}\b/g },
  // Stripe
  { name: "stripe-secret-live", re: /\bsk_live_[A-Za-z0-9]{20,200}\b/g },
  { name: "stripe-secret-test", re: /\bsk_test_[A-Za-z0-9]{20,200}\b/g },
  { name: "stripe-publishable-live", re: /\bpk_live_[A-Za-z0-9]{20,200}\b/g },
  { name: "stripe-publishable-test", re: /\bpk_test_[A-Za-z0-9]{20,200}\b/g },
  { name: "stripe-webhook", re: /\bwhsec_[A-Za-z0-9]{30,200}\b/g },
  // AWS
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Discord bot tokens — MFA.xxx, regular, and new format
  { name: "discord-bot", re: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g },
  // Telegram bot tokens
  { name: "telegram-bot", re: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g },
  // Generic Bearer tokens (only when prefixed with "Bearer ")
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9_.\-=]{20,300}/g },
];

/**
 * Scrub API keys and bearer tokens from arbitrary text.
 * Safe to call on logs, tool outputs, error messages, and messages persisted to SQLite.
 * Returns the original string if redaction is disabled or no secrets are found.
 */
export function redact(text: string): string {
  if (!ENABLED || !text) return text;
  let out = text;
  for (const { re } of PATTERNS) {
    out = out.replace(re, mask);
  }
  return out;
}

/**
 * Redact a value that might be a string, an Error, or an arbitrary object.
 * Used by wrappers around `console.warn/error` and audit log details.
 */
export function redactValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Error) return redact(value.message);
  if (typeof value === "string") return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return redact(String(value));
  }
}
