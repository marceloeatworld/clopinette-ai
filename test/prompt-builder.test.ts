import { describe, it, expect } from "vitest";
import { buildCurrentContextBlock, buildSystemPrompt, getCurrentPromptDate } from "../src/prompt-builder.js";

// Mock SQL function that returns empty for all queries
function mockSql<T>(_strings: TemplateStringsArray, ..._values: unknown[]): T[] {
  return [];
}

// Minimal mock env for prompt builder
const mockEnv = {
  CF_ACCOUNT_ID: "test-account",
  CF_BROWSER_TOKEN: "test-token",
} as unknown as Env;

describe("prompt builder", () => {
  it("assembles system prompt with required blocks", async () => {
    const prompt = await buildSystemPrompt({
      platform: "websocket",
      sql: mockSql,
      env: mockEnv,
    });

    // [0] Identity
    expect(prompt).toContain("Clopinette");
    // [4] Memory guidance
    expect(prompt).toContain("Memory System");
    expect(prompt).toContain("5-layer");
    // [5] Platform hint
    expect(prompt).toContain("Markdown is fully supported");
    // [9] Date
    expect(prompt).toContain("Date:");
    expect(prompt).toContain("Platform: websocket");
  });

  it("includes Telegram platform hint", async () => {
    const prompt = await buildSystemPrompt({
      platform: "telegram",
      sql: mockSql,
      env: mockEnv,
    });

    expect(prompt).toContain("Telegram");
    expect(prompt).toContain("4096");
    expect(prompt).toContain("Platform: telegram");
  });

  it("includes SOUL.md when configured", async () => {
    const soulSql = <T>(strings: TemplateStringsArray, ..._values: unknown[]): T[] => {
      const query = strings[0];
      if (query.includes("soul_md")) {
        return [{ value: "You are a pirate. Always say Arrr!" }] as T[];
      }
      return [];
    };

    const prompt = await buildSystemPrompt({
      platform: "api",
      sql: soulSql,
      env: mockEnv,
    });

    expect(prompt).toContain("pirate");
    expect(prompt).toContain("Arrr");
  });

  it("includes Honcho context when provided", async () => {
    const prompt = await buildSystemPrompt({
      platform: "websocket",
      sql: mockSql,
      env: mockEnv,
      honchoContext: "User prefers concise responses.",
    });

    expect(prompt).toContain("Context (Honcho)");
    expect(prompt).toContain("concise responses");
  });

  it("formats the current context block with a stable date", () => {
    const now = new Date("2026-04-15T12:34:56.000Z");
    expect(getCurrentPromptDate(now)).toBe("2026-04-15");
    expect(buildCurrentContextBlock("discord", now)).toBe(
      "## Current Context\nDate: 2026-04-15\nPlatform: discord",
    );
  });
});
