import { z } from "zod";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ToolContext } from "./registry.js";

/**
 * Interactive browser tool — proxy to PlaywrightMCP DO.
 * Lets the LLM navigate, click, type, take screenshots on real web pages.
 *
 * Communication: JSON-RPC over HTTP (MCP Streamable HTTP protocol)
 * Session: one PlaywrightMCP DO per userId (isolated browser sessions)
 *
 * Upgrade: LLM summarization for large snapshots (>8K chars, like Hermes).
 */

const MAX_SNAPSHOT_LENGTH = 12000;
const SNAPSHOT_SUMMARIZE_THRESHOLD = 8000;
const MCP_TIMEOUT = 30_000;

// MCP session state per userId (lazy init)
const sessions = new Map<string, { sessionId: string | null; msgId: number }>();

// Action -> MCP tool name mapping
const ACTION_MAP: Record<string, string> = {
  navigate: "browser_navigate",
  snapshot: "browser_snapshot",
  click: "browser_click",
  type: "browser_type",
  screenshot: "browser_take_screenshot",
  select: "browser_select_option",
  press_key: "browser_press_key",
  wait: "browser_wait_for",
  handle_dialog: "browser_handle_dialog",
  go_back: "browser_navigate_back",
  close: "browser_close",
};

export function createBrowserTool(ctx: ToolContext) {
  return {
    description:
      "Interactive web browser. Navigate to URLs, see page content (snapshot), click elements, " +
      "fill forms, take screenshots. Use 'snapshot' after navigation to see what's on the page. " +
      "Elements are identified by 'ref' numbers from the snapshot.",
    inputSchema: z.object({
      action: z.enum([
        "navigate", "snapshot", "click", "type", "screenshot",
        "select", "press_key", "wait", "handle_dialog", "go_back", "close",
      ]).describe("Browser action to perform"),
      url: z.string().optional().describe("URL to navigate to (for 'navigate')"),
      ref: z.string().optional().describe("Element ref number from snapshot (for click/type/select)"),
      element: z.string().optional().describe("Description of the element (for click/type/select)"),
      text: z.string().optional().describe("Text to type (for 'type') or to wait for (for 'wait')"),
      submit: z.coerce.boolean().optional().describe("Press Enter after typing (for 'type')"),
      key: z.string().optional().describe("Key to press (for 'press_key', e.g. 'Enter', 'Tab')"),
      values: z.string().optional().describe("JSON array of values (for 'select')"),
      time: z.coerce.number().optional().describe("Seconds to wait (for 'wait')"),
      accept: z.coerce.boolean().optional().describe("Accept or dismiss dialog (for 'handle_dialog')"),
      promptText: z.string().optional().describe("Text for prompt dialog (for 'handle_dialog')"),
    }),
    execute: async (params: {
      action: string;
      url?: string;
      ref?: string;
      element?: string;
      text?: string;
      submit?: boolean;
      key?: string;
      values?: string;
      time?: number;
      accept?: boolean;
      promptText?: string;
    }) => {
      if (!ctx.playwrightMcp) {
        return { ok: false, error: "Browser not available. PlaywrightMCP binding not configured." };
      }

      const mcpToolName = ACTION_MAP[params.action];
      if (!mcpToolName) {
        return { ok: false, error: `Unknown action: ${params.action}` };
      }

      // Build MCP tool arguments
      const args: Record<string, unknown> = {};
      if (params.action === "navigate") {
        if (!params.url) return { ok: false, error: "url required for navigate" };
        args.url = params.url;
      } else if (params.action === "click") {
        if (!params.ref) return { ok: false, error: "ref required for click" };
        args.ref = params.ref;
        if (params.element) args.element = params.element;
      } else if (params.action === "type") {
        if (!params.ref || !params.text) return { ok: false, error: "ref and text required for type" };
        args.ref = params.ref;
        if (params.element) args.element = params.element;
        args.text = params.text;
        if (params.submit) args.submit = true;
      } else if (params.action === "select") {
        if (!params.ref || !params.values) return { ok: false, error: "ref and values required for select" };
        args.ref = params.ref;
        if (params.element) args.element = params.element;
        try { args.values = JSON.parse(params.values); } catch { args.values = [params.values]; }
      } else if (params.action === "press_key") {
        if (!params.key) return { ok: false, error: "key required for press_key" };
        args.key = params.key;
      } else if (params.action === "wait") {
        if (params.time) args.time = params.time;
        if (params.text) args.text = params.text;
      } else if (params.action === "handle_dialog") {
        if (params.accept === undefined) return { ok: false, error: "accept required for handle_dialog" };
        args.accept = params.accept;
        if (params.promptText) args.promptText = params.promptText;
      }

      try {
        const result = await callMcpTool(ctx, mcpToolName, args);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Browser error: ${msg}` };
      }
    },
  };
}

// ───────────────────────── MCP JSON-RPC Client ─────────────────────────

async function callMcpTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const ns = ctx.playwrightMcp!;
  const id = ns.idFromName(ctx.userId);
  const stub = ns.get(id);

  // Ensure MCP session is initialized
  let session = sessions.get(ctx.userId);
  if (!session) {
    session = { sessionId: null, msgId: 0 };
    sessions.set(ctx.userId, session);
    await initMcpSession(stub, session);
  }

  // Call the MCP tool
  session.msgId++;
  const request: McpJsonRpc = {
    jsonrpc: "2.0",
    id: session.msgId,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const resp = await fetchMcp(stub, session, request);

  if (resp.error) {
    // Session might be stale — retry with fresh session
    if (resp.error.code === -32600 || resp.error.message?.includes("session")) {
      session.sessionId = null;
      await initMcpSession(stub, session);
      session.msgId++;
      request.id = session.msgId;
      const retry = await fetchMcp(stub, session, request);
      if (retry.error) return { ok: false, error: retry.error.message };
      return parseToolResult(retry.result, ctx.auxModel);
    }
    return { ok: false, error: resp.error.message };
  }

  return parseToolResult(resp.result, ctx.auxModel);
}

async function initMcpSession(
  stub: DurableObjectStub,
  session: { sessionId: string | null; msgId: number }
): Promise<void> {
  // Initialize
  const initResp = await stub.fetch(new Request("https://mcp/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ClopinetteAgent", version: "1.0.0" },
      },
    }),
  }));

  // Store session ID from response header
  const sid = initResp.headers.get("mcp-session-id");
  if (sid) session.sessionId = sid;

  // Parse response (could be SSE or JSON)
  await parseResponse(initResp);

  // Send initialized notification
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (session.sessionId) headers["mcp-session-id"] = session.sessionId;

  await stub.fetch(new Request("https://mcp/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  }));
}

async function fetchMcp(
  stub: DurableObjectStub,
  session: { sessionId: string | null; msgId: number },
  request: McpJsonRpc
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (session.sessionId) headers["mcp-session-id"] = session.sessionId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT);

  try {
    const resp = await stub.fetch(new Request("https://mcp/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    }));

    // Update session ID if returned
    const sid = resp.headers.get("mcp-session-id");
    if (sid) session.sessionId = sid;

    return parseResponse(resp);
  } finally {
    clearTimeout(timeout);
  }
}

// ───────────────────────── Response parsing ─────────────────────────

async function parseResponse(resp: Response): Promise<McpResponse> {
  const contentType = resp.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    // Parse SSE — extract the last JSON-RPC message
    const text = await resp.text();
    const lines = text.split("\n");
    let lastData = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }
    if (lastData) {
      try { return JSON.parse(lastData); } catch { /* fall through */ }
    }
    return {};
  }

  // Regular JSON
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

async function parseToolResult(
  result: unknown,
  auxModel?: LanguageModel,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!result || typeof result !== "object") {
    return { ok: true, content: "(no content)" };
  }

  const r = result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

  if (r.isError) {
    const errText = r.content?.map(c => c.text).filter(Boolean).join("\n") ?? "Unknown error";
    return { ok: false, error: errText };
  }

  const parts: string[] = [];
  for (const item of r.content ?? []) {
    if (item.type === "text" && item.text) {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push("[Screenshot captured]");
    }
  }

  let content = parts.join("\n");

  // LLM summarize large snapshots (like Hermes browser_snapshot summarization).
  // Uses the pre-built auxiliary model from the pipeline (BYOK-aware — never
  // touches Workers AI for BYOK users).
  if (auxModel && content.length > SNAPSHOT_SUMMARIZE_THRESHOLD) {
    try {
      const { text } = await generateText({
        model: auxModel,
        system:
          "You are summarizing a browser accessibility snapshot. Extract the key page structure, " +
          "interactive elements (buttons, links, inputs with their ref IDs like @e5), and visible text content. " +
          "Preserve ref IDs exactly — the user needs them to click/type. Be concise but complete.",
        prompt: `SNAPSHOT (${content.length} chars):\n${content.slice(0, 30_000)}`,
        maxRetries: 1,
      });
      if (text) {
        content = text.length > MAX_SNAPSHOT_LENGTH
          ? text.slice(0, MAX_SNAPSHOT_LENGTH) + "\n\n[...summary truncated]"
          : text;
        return { ok: true, content };
      }
    } catch { /* fall through to truncation */ }
  }

  // Fallback: truncate
  if (content.length > MAX_SNAPSHOT_LENGTH) {
    content = content.slice(0, MAX_SNAPSHOT_LENGTH) + "\n\n[...truncated]";
  }

  return { ok: true, content: content || "(empty response)" };
}

// ───────────────────────── Types ─────────────────────────

interface McpJsonRpc {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}
