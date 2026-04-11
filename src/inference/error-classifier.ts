/**
 * Structured classification for model-call errors.
 *
 * Inspired by hermes-agent's `error_classifier.py`. Centralizes all provider
 * quirks in one place so the retry loop is testable and auditable, instead of
 * scattering `errMsg.includes("429")` checks throughout the pipeline.
 *
 * Every classification returns concrete recovery hints (`shouldFallback`,
 * `shouldCompress`, `shouldRotateCredential`, `retryAfterMs`) that the caller
 * consumes without re-parsing the error string.
 */

export type ErrorKind =
  | "rate_limit"        // 429, token bucket exhausted, org tier hit
  | "overloaded"        // 529, 503 — provider capacity issue
  | "billing"           // 402, expired card, trial over, insufficient credits
  | "context_overflow"  // prompt bigger than model's context window
  | "invalid_api_key"   // 401, revoked / rotated / malformed key
  | "model_not_found"   // provider renamed/retired the model id
  | "thinking_signature"// Anthropic extended-thinking signature mismatch
  | "timeout"           // upstream timeout, AbortError, fetch timeout
  | "network"           // DNS, TCP, TLS — transient infra
  | "unknown";          // catch-all — always falls back, never compresses

export interface ErrorClassification {
  kind: ErrorKind;
  /** True if the fallback model should be tried. */
  shouldFallback: boolean;
  /** True if the caller should compress/trim context before retrying. */
  shouldCompress: boolean;
  /** True if the user's credential is suspect and should be surfaced. */
  shouldRotateCredential: boolean;
  /** If the provider returned Retry-After, the parsed delay in ms. */
  retryAfterMs?: number;
  /** Short human hint used by log lines and audit entries. */
  hint: string;
}

/**
 * Best-effort extraction of a `Retry-After: N` header from the stringified error.
 * Providers sometimes embed it as part of the error body; we grab it so the
 * caller can honor it instead of guessing a backoff.
 */
function parseRetryAfter(msg: string): number | undefined {
  const match = msg.match(/retry[-_ ]?after[:\s"]+(\d+)/i);
  if (!match) return undefined;
  const seconds = parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Cap at 60s — if a provider asks for longer, the user is better served by the fallback
  return Math.min(seconds, 60) * 1000;
}

export function classifyError(err: unknown): ErrorClassification {
  const msg = err instanceof Error ? err.message : String(err ?? "");

  // Rate limit — most common BYOK failure mode
  if (/\b429\b/.test(msg) || /rate[-_ ]?limit/i.test(msg) || /too many requests/i.test(msg) || /quota exceeded/i.test(msg)) {
    return {
      kind: "rate_limit",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      retryAfterMs: parseRetryAfter(msg),
      hint: "Provider rate limit — falling back",
    };
  }

  // Overloaded / capacity — fall back without retrying the same provider
  if (/\b529\b/.test(msg) || /\b503\b/.test(msg) || /overloaded/i.test(msg) || /service unavailable/i.test(msg)) {
    return {
      kind: "overloaded",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Provider overloaded — falling back",
    };
  }

  // Context window — compressing may save the call, but fall back if it doesn't
  if (/context[-_ ]?length/i.test(msg) || /maximum context/i.test(msg) || /context window/i.test(msg)
      || /token[-_ ]?limit/i.test(msg) || /prompt is too long/i.test(msg) || /maximum tokens/i.test(msg)) {
    return {
      kind: "context_overflow",
      shouldFallback: true,
      shouldCompress: true,
      shouldRotateCredential: false,
      hint: "Context window exceeded — compress or fallback",
    };
  }

  // Billing — no amount of retry will fix this; fall back to the free Workers AI tier
  if (/\b402\b/.test(msg) || /billing/i.test(msg) || /payment required/i.test(msg)
      || /insufficient credits/i.test(msg) || /insufficient balance/i.test(msg)
      || /account suspended/i.test(msg) || /trial expired/i.test(msg)) {
    return {
      kind: "billing",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Billing issue — falling back to free tier",
    };
  }

  // Invalid / missing API key — surface to the user so they can rotate it
  if (/\b401\b/.test(msg) || /invalid[-_ ]?api[-_ ]?key/i.test(msg) || /unauthorized/i.test(msg)
      || /authentication failed/i.test(msg) || /invalid token/i.test(msg)) {
    return {
      kind: "invalid_api_key",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: true,
      hint: "API key invalid — falling back, user should rotate key",
    };
  }

  // Model was renamed / retired — fall back without suggesting a credential issue
  if (/model not found/i.test(msg) || /unknown model/i.test(msg) || /no such model/i.test(msg)
      || /model_not_found/i.test(msg) || /does not exist/i.test(msg)) {
    return {
      kind: "model_not_found",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Model id unknown to provider — falling back",
    };
  }

  // Anthropic extended-thinking signature mismatch (happens when cache state drifts)
  // Don't fall back — the next turn with a fresh cache usually fixes it.
  if (/thinking[-_ ]?signature/i.test(msg) || /thinking block/i.test(msg)) {
    return {
      kind: "thinking_signature",
      shouldFallback: false,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Anthropic extended-thinking mismatch — user should retry",
    };
  }

  // Timeouts — could be transient, fall back
  if (/timeout/i.test(msg) || /timed out/i.test(msg) || /ETIMEDOUT/i.test(msg) || /AbortError/i.test(msg)) {
    return {
      kind: "timeout",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Upstream timeout — falling back",
    };
  }

  // Generic network errors
  if (/ENOTFOUND/i.test(msg) || /ECONNREFUSED/i.test(msg) || /ECONNRESET/i.test(msg)
      || /fetch failed/i.test(msg) || /network (?:error|request failed)/i.test(msg)) {
    return {
      kind: "network",
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      hint: "Network error — falling back",
    };
  }

  // Default — unknown, still try the fallback (conservative)
  return {
    kind: "unknown",
    shouldFallback: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    hint: "Unknown model error — falling back",
  };
}
