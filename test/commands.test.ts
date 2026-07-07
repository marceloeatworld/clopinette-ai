import { describe, expect, it } from "vitest";
import { handleCommand } from "../src/commands.js";

function mockSql<T>(_strings: TemplateStringsArray, ..._values: unknown[]): T[] {
  return [];
}

function mockContext() {
  return {
    sql: mockSql,
    sessionId: "session-1",
    userId: "user-1",
    env: {} as Env,
  };
}

describe("commands", () => {
  it("/research rewrites to a complementary multi-angle delegate prompt", async () => {
    const result = await handleCommand("/research cloudflare browser run", mockContext());

    expect(result).not.toBeNull();
    expect(result && "handled" in result ? result.handled : false).toBe(false);

    const rewrite = (result as { rewriteAs: string }).rewriteAs;
    expect(rewrite).toContain("delegate({ tasks: [...] })");
    expect(rewrite).toContain("primary or official sources");
    expect(rewrite).toContain("recent developments, changelogs, or reporting");
    expect(rewrite).toContain("DO NOT call web/docs directly first - go straight to delegate.");
    expect(rewrite).toContain("After delegating, send only a brief in-progress note");
    expect(rewrite).toContain("Topic: cloudflare browser run");
  });

  it("/research without args returns usage text", async () => {
    const result = await handleCommand("/research", mockContext());

    expect(result).toEqual({
      text: "Usage: `/research <topic>` — launches 2-3 parallel sub-agents to research the topic from different angles, then synthesizes the findings.",
      handled: true,
    });
  });
});
