import type { ModelMessage } from "ai";

/**
 * Anthropic prompt caching — system_and_3 strategy.
 *
 * Places cache_control breakpoints on the system prompt and the last 3 messages.
 * This tells Anthropic to cache these sections, reducing input token costs by ~75%
 * on multi-turn conversations.
 *
 * Only applies when the user is on a BYOK Anthropic provider (via AI Gateway).
 * Workers AI has its own prefix caching (session affinity).
 */

const CACHE_MARKER = { type: "ephemeral" as const };

/**
 * Check if the provider is Anthropic-based (benefits from explicit cache control).
 */
export function isAnthropicProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return provider.includes("anthropic") || provider.includes("claude");
}

/**
 * Apply Anthropic cache control breakpoints to messages.
 * Mutates messages in place for efficiency.
 *
 * Strategy: system + last 3 non-system messages (like Hermes system_and_3).
 * Maximum 4 breakpoints allowed by Anthropic.
 */
export function applyCacheControl(
  messages: ModelMessage[],
  _systemPrompt: string
): { messages: ModelMessage[]; providerOptions: unknown } {
  // For system prompt: use providerOptions to set cache control
  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
  };

  // Apply cache control to last 3 messages
  const nonSystem = messages
    .map((m, i) => ({ msg: m, idx: i }))
    .filter(({ msg }) => msg.role !== "system");

  const toMark = nonSystem.slice(-3);

  for (const { msg } of toMark) {
    if (typeof msg.content === "string") {
      // For string content, wrap in array with cache control on last block
      (msg as Record<string, unknown>).providerOptions = {
        anthropic: { cacheControl: CACHE_MARKER },
      };
    }
  }

  return { messages, providerOptions };
}
