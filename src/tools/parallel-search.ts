import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "clopinette-ai/0.1.0 (+https://github.com/marceloeatworld/clopinette-ai)";
const TIMEOUT_MS = 15_000;

const pageSchema = z.object({
  url: z.url().refine((url) => /^https?:\/\//i.test(url)),
  title: z.string().nullish(),
  excerpts: z.array(z.string()),
  full_content: z.string().nullish(),
});
const responseSchema = z.object({ results: z.array(pageSchema) });

/** One bounded MCP connection per operation; no credentials or browser session. */
export async function callParallel(
  action: "search" | "read",
  value: string,
  sessionId: string,
  count: number,
  abortSignal?: AbortSignal,
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(abortSignal ? [abortSignal] : []),
  ]);
  const client = new Client({ name: "clopinette-ai", version: "0.1.0" }, {
    // The SDK's default AJV compiler requires eval, unavailable in Workers.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { "User-Agent": USER_AGENT } },
    fetch: (input, init) => fetch(input, {
      ...init,
      // Also bound initialize/discovery, which precede callTool's request options.
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      redirect: "error",
    }),
  });
  try {
    signal.throwIfAborted();
    await client.connect(transport);
    const name = action === "search" ? "web_search" : "web_fetch";
    const tools = await client.listTools({}, { signal, timeout: TIMEOUT_MS });
    if (!tools.tools.some((tool) => tool.name === name)) {
      throw new Error("Required Parallel MCP tool is unavailable");
    }
    const result = await client.callTool({
      name,
      arguments: action === "search"
        ? { objective: value, search_queries: [value], session_id: sessionId }
        : { urls: [value], full_content: true, session_id: sessionId },
    }, undefined, { signal, timeout: TIMEOUT_MS });
    if (result.isError) throw new Error("Parallel returned a tool error; try again later");
    const text = Array.isArray(result.content)
      ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : "";
    const data = responseSchema.parse(result.structuredContent ?? JSON.parse(text));
    if (action === "search") {
      const results = data.results.slice(0, count).map((page) => ({
        title: page.title ?? page.url,
        url: page.url,
        description: page.excerpts.join("\n").slice(0, 5000),
      }));
      return { ok: true, engine: "parallel", query: value, results, count: results.length };
    }
    const page = data.results[0];
    if (!page) throw new Error("Parallel could not fetch this URL");
    const content = page.full_content ?? page.excerpts.join("\n");
    return {
      ok: true, engine: "parallel", url: page.url,
      content: content.slice(0, 5000) + (content.length > 5000 ? "\n\n[...truncated]" : ""),
    };
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason;
    return {
      ok: false,
      error: signal.aborted ? "Parallel request timed out. Try again later."
        : "Parallel request failed. The service may be unavailable or rate limited; try again later.",
    };
  } finally {
    await client.close().catch(() => {});
  }
}
