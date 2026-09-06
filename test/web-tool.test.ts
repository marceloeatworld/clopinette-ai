import { afterEach, describe, expect, it, vi } from "vitest";

const { createWebTool } = await import("../src/tools/web-tool.js");

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("web tool diagnostics", () => {
  it("returns diagnostics without requiring Browser Run credentials", async () => {
    const tool = createWebTool("acct12345678");
    const result = await tool.execute({ action: "diagnostics" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Browser token: missing");
    expect((result as { diagnostics: { configured: { browserToken: boolean } } }).diagnostics.configured.browserToken).toBe(false);
  });

  it("allows search through SearXNG without CF_BROWSER_TOKEN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Cloudflare",
              url: "https://www.cloudflare.com/",
              content: "Connectivity cloud",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const tool = createWebTool("acct12345678", undefined, undefined, "https://search.example");
    const result = await tool.execute({ action: "search", query: "cloudflare" });

    expect(result.ok).toBe(true);
    expect((result as { engine: string }).engine).toBe("searxng");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
