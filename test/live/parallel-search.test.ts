import { afterEach, expect, it, vi } from "vitest";
import { buildDelegateTools } from "../../src/delegation.js";

afterEach(() => { vi.unstubAllGlobals(); });

// Explicit opt-in: this makes real requests and consumes the anonymous quota.
it.skipIf(process.env.RUN_PARALLEL_LIVE !== "1")("searches and reads through the research toolset without credentials", async () => {
  const nativeFetch = globalThis.fetch;
  const responses: string[] = [];
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://search.parallel.ai/mcp");
    const headers = new Headers(init?.headers);
    expect(headers.get("User-Agent")).toBe("clopinette-ai/0.1.0 (+https://github.com/marceloeatworld/clopinette-ai)");
    expect(headers.has("Authorization")).toBe(false);
    const message = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (message?.method) methods.push(message.method);
    const response = await nativeFetch(input, init);
    if (message?.method === "tools/call") responses.push(await response.clone().text());
    return response;
  });

  // No env keys, saved configuration, or browser credentials enter this toolset.
  const tools = buildDelegateTools({ cfAccountId: "", sessionId: crypto.randomUUID() });
  const search = await tools.web.execute({ action: "search", query: "Cloudflare Workers official documentation", count: 2 });
  if (!search.ok) console.error("Anonymous MCP response:", responses.join("\n"));
  expect(search).toMatchObject({ ok: true, engine: "parallel" });
  expect(search.results?.length).toBeGreaterThan(0);
  const url = search.results![0].url;
  expect(url).toMatch(/^https?:\/\//);
  const read = await tools.web.execute({ action: "read", url });
  if (!read.ok) console.error("Anonymous MCP response:", responses.join("\n"));
  expect(read).toMatchObject({ ok: true, engine: "parallel" });
  expect(read.content?.length).toBeGreaterThan(0);
  expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
  console.log(JSON.stringify({ searchCount: search.count, url, readCharacters: read.content?.length, methods }));
}, 40_000);
