import { describe, expect, it } from "vitest";
import { canReuseCachedSystemPrompt, getPromptCacheDay } from "../src/prompt-cache.js";

describe("prompt cache", () => {
  it("reuses same-day prompt cache when version matches", () => {
    const now = new Date("2026-04-15T09:00:00.000Z");
    expect(
      canReuseCachedSystemPrompt("prompt", "2026-04-15", 2, 2, now),
    ).toBe(true);
    expect(getPromptCacheDay(now)).toBe("2026-04-15");
  });

  it("invalidates cached prompts from another day or version", () => {
    const now = new Date("2026-04-15T09:00:00.000Z");
    expect(
      canReuseCachedSystemPrompt("prompt", "2025-04-15", 2, 2, now),
    ).toBe(false);
    expect(
      canReuseCachedSystemPrompt("prompt", "2026-04-15", 1, 2, now),
    ).toBe(false);
  });
});
