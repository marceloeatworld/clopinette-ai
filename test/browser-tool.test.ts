import { describe, expect, it } from "vitest";

const { createBrowserTool } = await import("../src/tools/browser-tool.js");

function mockCtx() {
  return {
    userId: "test-user",
    sessionId: "test-session",
    playwrightMcp: undefined,
    auxModel: undefined,
  } as unknown as Parameters<typeof createBrowserTool>[0];
}

describe("browser tool observability", () => {
  it("returns diagnostics even when the browser binding is unavailable", async () => {
    const tool = createBrowserTool(mockCtx());
    const result = await tool.execute({ action: "diagnostics" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("wrangler browser list");
    expect((result as { diagnostics: { liveView: { supportedByBrowserRun: boolean } } }).diagnostics.liveView.supportedByBrowserRun).toBe(true);
  });

  it("returns a structured human handoff without requiring the browser binding", async () => {
    const tool = createBrowserTool(mockCtx());
    const result = await tool.execute({
      action: "request_human",
      reason: "MFA code required",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("MFA code required");
    expect((result as { handoff: { steps: string[] } }).handoff.steps[0]).toContain("wrangler browser list");
  });
});
