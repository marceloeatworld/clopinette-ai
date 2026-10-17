import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";

vi.mock("@cloudflare/codemode/ai", () => ({ createCodeTool: vi.fn(() => ({})) }));
vi.mock("@cloudflare/codemode", () => ({ DynamicWorkerExecutor: class {} }));

const { resolveTools } = await import("../src/tools/registry.js");
const { buildDelegateTools } = await import("../src/delegation.js");
const { createWebTool } = await import("../src/tools/web-tool.js");

const SESSION = "169c103a-4bf7-4c32-b9b4-858f788123c3";
const URL = "https://developers.cloudflare.com/workers/";
const PAGE = { title: "Workers", url: URL, excerpts: ["Workers run on Cloudflare's network."] };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function context(extra = {}) {
  return {
    sql: () => [], r2Memories: {} as R2Bucket, r2Skills: {} as R2Bucket, ai: {} as Ai,
    userId: "user", sessionId: SESSION, cfAccountId: "account",
    env: { WS_SIGNING_SECRET: "fixture" }, ...extra,
  };
}

// Exercise the real MCP SDK transport; only the network boundary is scripted.
function mcpFixture(options: { output?: unknown; isError?: boolean; status?: number; sse?: boolean; textOnly?: boolean } = {}) {
  const messages: any[] = [];
  const requests: Array<{ url: string; headers: Headers; method: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers, method: init?.method ?? "GET" });
    expect(url).toBe("https://search.parallel.ai/mcp");
    expect(headers.get("User-Agent")).toBe("clopinette-ai/0.1.0 (+https://github.com/marceloeatworld/clopinette-ai)");
    expect(headers.has("Authorization")).toBe(false);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    messages.push(message);
    if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
    let result: unknown;
    switch (message.method) {
      case "initialize": result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list": result = { tools: ["web_search", "web_fetch"].map((name) => ({
        name, inputSchema: { type: "object" },
        ...(!options.textOnly ? { outputSchema: { type: "object", properties: { results: { type: "array" } }, required: ["results"] } } : {}),
      })) }; break;
      case "tools/call":
        if (options.status) return new Response("Quota exceeded", { status: options.status });
        result = { content: [{ type: "text", text: JSON.stringify(options.output ?? { results: [PAGE] }) }],
          ...(!options.textOnly ? { structuredContent: options.output ?? { results: [PAGE] } } : {}),
          isError: options.isError ?? false };
        break;
      default: throw new Error(`Unexpected MCP method: ${message.method}`);
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    return options.sse
      ? new Response(`event: message\ndata: ${body}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : new Response(body, { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { messages, requests, fetchMock };
}

describe("Parallel web tool runtime", () => {
  it.each([undefined, {} as WorkerLoader])("dispatches no-key search and read through resolveTools (loader=%s)", async (loader) => {
    const fixture = mcpFixture();
    const web = resolveTools(context({ loader })).web;
    const search = await web.execute({ action: "search", query: "Cloudflare Workers docs", count: 1 });
    expect(search).toMatchObject({ ok: true, engine: "parallel", count: 1, results: [{ title: "Workers", url: URL, description: PAGE.excerpts[0] }] });
    const read = await web.execute({ action: "read", url: URL });
    expect(read).toMatchObject({ ok: true, url: URL, content: PAGE.excerpts[0] });
    expect(fixture.messages.filter((m) => m.method === "tools/call").map((m) => m.params)).toEqual([
      { name: "web_search", arguments: { objective: "Cloudflare Workers docs", search_queries: ["Cloudflare Workers docs"], session_id: SESSION } },
      { name: "web_fetch", arguments: { urls: [URL], full_content: true, session_id: SESSION } },
    ]);
    expect(fixture.messages.filter((m) => m.method === "tools/list")).toHaveLength(2);
  });

  it("feeds search results back to a scripted model through the SDK tool loop", async () => {
    mcpFixture();
    let turn = 0;
    const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      turn++;
      if (turn === 2) {
        const toolMessage = prompt.find((message) => message.role === "tool");
        expect(JSON.stringify(toolMessage)).toContain(PAGE.excerpts[0]);
        expect(JSON.stringify(toolMessage)).toContain(URL);
      }
      return {
        content: turn === 1
          ? [{ type: "tool-call", toolCallId: "search1", toolName: "web", input: JSON.stringify({ action: "search", query: "Cloudflare Workers docs" }) }]
          : [{ type: "text", text: `Workers documentation: ${URL}` }],
        finishReason: { unified: turn === 1 ? "tool-calls" : "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    } });
    const result = await generateText({ model, prompt: "Find Workers documentation", tools: { web: resolveTools(context()).web }, stopWhen: stepCountIs(2) });
    expect(result.text).toContain(URL);
    expect(turn).toBe(2);
  });

  it("uses the same keyless path for research delegates", async () => {
    const fixture = mcpFixture({ sse: true });
    const tools = buildDelegateTools({ cfAccountId: "account", sessionId: SESSION });
    expect(await tools.web.execute({ action: "search", query: "Workers docs" })).toMatchObject({ ok: true, engine: "parallel" });
    expect(fixture.requests.length).toBeGreaterThan(2);
  });

  it("validates advertised output schemas without eval in Workers", async () => {
    mcpFixture();
    vi.stubGlobal("Function", function () { throw new Error("Code generation is disabled in Workers"); });
    expect(await resolveTools(context()).web.execute({ action: "search", query: "Workers" })).toMatchObject({ ok: true, engine: "parallel" });
  });

  it("also consumes JSON text responses without structured content", async () => {
    mcpFixture({ textOnly: true });
    expect(await resolveTools(context()).web.execute({ action: "search", query: "Workers" })).toMatchObject({ ok: true, engine: "parallel" });
  });

  it.each(["search", "read"])("honors operator disable for %s, including explicit Parallel selection", async (action) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const tools = resolveTools(context({ env: { WS_SIGNING_SECRET: "fixture", PARALLEL_SEARCH_ENABLED: "false" } }));
    const result = await tools.web.execute({ action, query: "Workers", url: URL, engine: "parallel" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("disabled") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves configured provider precedence and never falls back to Parallel on failure", async () => {
    const fetchMock = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = resolveTools(context({ searxngUrl: "https://searx.example", braveApiKey: "fixture-brave-key", cfBrowserToken: "fixture-browser-key" }));
    expect(await tools.web.execute({ action: "search", query: "Workers" })).toMatchObject({ ok: false });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("https://searx.example/search"),
      expect.stringContaining("https://api.search.brave.com/"),
      expect.stringContaining("https://api.cloudflare.com/"),
    ]);
  });

  it("lets an explicit Parallel selection override configured providers", async () => {
    mcpFixture();
    const tools = resolveTools(context({ searxngUrl: "https://searx.example", braveApiKey: "fixture" }));
    expect(await tools.web.execute({ action: "search", query: "Workers", engine: "parallel" })).toMatchObject({ ok: true, engine: "parallel" });
  });

  it.each([{ status: 429 }, { status: 401 }, { isError: true }, { output: { results: [{ url: "file:///etc/passwd", excerpts: [] }] } }, { output: {} }])("returns an error without another provider for %j", async (options) => {
    const fixture = mcpFixture(options);
    const tools = resolveTools(context({ braveApiKey: "fixture" }));
    expect(await tools.web.execute({ action: "search", query: "Workers", engine: "parallel" })).toMatchObject({ ok: false });
    expect(fixture.messages.filter((m) => m.method === "tools/call")).toHaveLength(1);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.org", "invalid"])("rejects unsafe read URL %s before network access", async (url) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await resolveTools(context()).web.execute({ action: "read", url })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds page output and keeps browser-only operations gated", async () => {
    mcpFixture({ output: { results: [{ ...PAGE, full_content: "x".repeat(6000) }] } });
    const web = resolveTools(context()).web;
    expect(await web.execute({ action: "read", url: URL })).toMatchObject({ content: "x".repeat(5000) + "\n\n[...truncated]" });
    expect(await web.execute({ action: "scrape", url: URL })).toMatchObject({ ok: false, error: expect.stringContaining("CF_BROWSER_TOKEN") });
  });

  it("cancels an in-flight initialization", async () => {
    // The transport must receive the combined deadline and caller signal.
    let signal!: AbortSignal;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    })));
    const controller = new AbortController();
    const web = createWebTool("account", undefined);
    const request = web.execute({ action: "search", query: "Workers" }, { abortSignal: controller.signal });
    await ready;
    controller.abort(new Error("User cancelled"));
    await expect(request).rejects.toThrow("User cancelled");
    expect(signal.aborted).toBe(true);
  });

  it("cancels during a tool call after discovery", async () => {
    const fixture = mcpFixture();
    const implementation = fixture.fetchMock.getMockImplementation()!;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    fixture.fetchMock.mockImplementation(async (input, init) => {
      const message = init?.body && JSON.parse(String(init.body));
      if (message?.method !== "tools/call") return implementation(input, init);
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        started();
      });
    });
    const controller = new AbortController();
    const request = resolveTools(context()).web.execute({ action: "search", query: "Workers" }, { abortSignal: controller.signal });
    await ready;
    controller.abort(new Error("User cancelled tool"));
    await expect(request).rejects.toThrow("User cancelled tool");
  });

  it("uses a 15 second deadline for stalled MCP requests", async () => {
    // Replace only the native timer source so the real SDK and combined signal run.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      started();
    })));
    const request = resolveTools(context()).web.execute({ action: "search", query: "Workers" });
    await ready;
    expect(timeout).toHaveBeenCalledWith(15_000);
    deadline.abort(new DOMException("Timeout", "TimeoutError"));
    expect(await request).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("cancels a queued call without waiting for occupied connection slots", async () => {
    let started!: () => void;
    let requests = 0;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input, init) => new Promise((_resolve, reject) => {
      if (++requests === 2) started();
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    const web = resolveTools(context()).web;
    const first = new AbortController(), second = new AbortController(), queued = new AbortController();
    const a = web.execute({ action: "search", query: "one" }, { abortSignal: first.signal });
    const b = web.execute({ action: "search", query: "two" }, { abortSignal: second.signal });
    await ready;
    const c = web.execute({ action: "search", query: "three" }, { abortSignal: queued.signal });
    queued.abort(new Error("Queued call cancelled"));
    await expect(c).rejects.toThrow("Queued call cancelled");
    expect(requests).toBe(2);
    first.abort(new Error("First call cancelled")); second.abort(new Error("Second call cancelled"));
    await expect(a).rejects.toThrow("First call cancelled");
    await expect(b).rejects.toThrow("Second call cancelled");
  });
});
