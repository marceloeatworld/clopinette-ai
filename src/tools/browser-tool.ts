import { z } from "zod";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ToolContext } from "./registry.js";
import type { BrowserRunInfo, McpToolResult } from "../playwright-mcp.js";

/**
 * Interactive browser tool — drives the PlaywrightMCP DO over Durable Object RPC.
 * Lets the LLM navigate, click, type, take screenshots on real web pages.
 *
 * Session: one PlaywrightMCP DO per userId, each owning its own Browser Run
 * session. Every successful action returns `browserRun.sessionId`; `navigate`,
 * `live_view`, `diagnostics` and `request_human` also return a Live View URL
 * so an operator can watch or take over (login, MFA, CAPTCHA) without
 * hunting for the session with wrangler.
 *
 * Upgrade: LLM summarization for large snapshots (>8K chars, like Hermes).
 */

const MAX_SNAPSHOT_LENGTH = 12000;
const SNAPSHOT_SUMMARIZE_THRESHOLD = 8000;
const RPC_TIMEOUT = 30_000;

interface BrowserToolSession {
  lastAction?: string;
  lastKnownUrl?: string;
  lastTouchedAt?: string;
  browserRun?: BrowserRunInfo;
}

/** RPC surface of the PlaywrightMCP DO (see src/playwright-mcp.ts). */
interface PlaywrightMcpStub {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  getBrowserRunInfo(options?: { liveView?: boolean; expiresInMs?: number }): Promise<BrowserRunInfo>;
}

// Per-user tool state (lazy init, isolate-local)
const sessions = new Map<string, BrowserToolSession>();

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

/** Actions that get a fresh Live View URL attached to their result. */
const LIVE_VIEW_ACTIONS = new Set(["navigate"]);

export function createBrowserTool(ctx: ToolContext) {
  return {
    description:
      "Interactive web browser. Navigate to URLs, see page content (snapshot), click elements, " +
      "fill forms, take screenshots. Use 'snapshot' after navigation to see what's on the page. " +
      "Elements are identified by 'ref' numbers from the snapshot. " +
      "Results carry browserRun.sessionId and, after navigate or 'live_view', browserRun.liveViewUrl " +
      "(a link a human can open to watch or take over the browser). " +
      "Use 'diagnostics' for operator guidance, or 'request_human' " +
      "when login, MFA, CAPTCHA, or sensitive data entry blocks automation.",
    inputSchema: z.object({
      action: z.enum([
        "navigate", "snapshot", "click", "type", "screenshot",
        "select", "press_key", "wait", "handle_dialog", "go_back", "close",
        "live_view", "diagnostics", "request_human",
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
      reason: z.string().optional().describe("Why human intervention is needed (for 'request_human')"),
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
      reason?: string;
    }) => {
      const session = getBrowserSession(ctx.userId);
      const stub = getStub(ctx);

      if (params.action === "diagnostics") {
        await refreshBrowserRun(stub, session, true);
        return buildBrowserDiagnostics(session);
      }

      if (params.action === "request_human") {
        await refreshBrowserRun(stub, session, true);
        return buildHumanHandoff(session, params.reason);
      }

      if (!stub) {
        return { ok: false, error: "Browser not available. PlaywrightMCP binding not configured." };
      }

      if (params.action === "live_view") {
        await refreshBrowserRun(stub, session, true);
        if (!session.browserRun?.sessionId) {
          return { ok: false, error: "No browser session yet. Navigate to a page first, then request live_view." };
        }
        return {
          ok: true,
          content: session.browserRun.liveViewUrl
            ? `Live View: ${session.browserRun.liveViewUrl} (valid until ${session.browserRun.liveViewExpiresAt}). Browser Run session ${session.browserRun.sessionId}.`
            : `Browser Run session ${session.browserRun.sessionId}. Live View unavailable: ${session.browserRun.error ?? "unknown error"}.`,
          browserRun: session.browserRun,
        };
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
        const raw = await withTimeout(stub.callTool(mcpToolName, args), RPC_TIMEOUT, `browser ${params.action}`);
        const result = await parseToolResult(raw, ctx.auxModel);
        if (!result.ok) return result;

        session.lastAction = params.action;
        session.lastTouchedAt = new Date().toISOString();
        if (params.action === "close") {
          session.lastKnownUrl = undefined;
          session.browserRun = undefined;
          return result;
        }
        if (params.action === "navigate" && params.url) session.lastKnownUrl = params.url;

        // Attach Browser Run info: session id on every action, Live View URL on navigate
        await refreshBrowserRun(stub, session, LIVE_VIEW_ACTIONS.has(params.action));
        return session.browserRun ? { ...result, browserRun: session.browserRun } : result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Browser error: ${msg}` };
      }
    },
  };
}

// ───────────────────────── DO RPC helpers ─────────────────────────

function getStub(ctx: ToolContext): PlaywrightMcpStub | null {
  if (!ctx.playwrightMcp) return null;
  const id = ctx.playwrightMcp.idFromName(ctx.userId);
  return ctx.playwrightMcp.get(id) as unknown as PlaywrightMcpStub;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Best-effort refresh of the Browser Run session id (+ Live View URL). Never throws. */
async function refreshBrowserRun(stub: PlaywrightMcpStub | null, session: BrowserToolSession, liveView: boolean): Promise<void> {
  if (!stub) return;
  try {
    const info = await withTimeout(stub.getBrowserRunInfo({ liveView }), 10_000, "browser session lookup");
    // Keep a still-valid Live View URL when this refresh did not request a new one
    const previous = session.browserRun;
    if (!liveView && previous?.liveViewUrl && previous.sessionId === info.sessionId
        && previous.liveViewExpiresAt && Date.parse(previous.liveViewExpiresAt) > Date.now()) {
      info.liveViewUrl = previous.liveViewUrl;
      info.liveViewExpiresAt = previous.liveViewExpiresAt;
    }
    session.browserRun = info;
  } catch (err) {
    session.browserRun = {
      sessionId: session.browserRun?.sessionId ?? null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ───────────────────────── Response parsing ─────────────────────────

async function parseToolResult(
  result: unknown,
  auxModel?: LanguageModel,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!result || typeof result !== "object") {
    return { ok: true, content: "(no content)" };
  }

  const r = result as McpToolResult;

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

// ───────────────────────── Session state + operator views ─────────────────────────

function getBrowserSession(userId: string): BrowserToolSession {
  let session = sessions.get(userId);
  if (!session) {
    session = {};
    sessions.set(userId, session);
  }
  return session;
}

function describeLiveView(run: BrowserRunInfo | undefined): string[] {
  if (run?.liveViewUrl) {
    return [
      `Live View: ${run.liveViewUrl}`,
      `Valid until: ${run.liveViewExpiresAt}`,
      `Or: wrangler browser view ${run.sessionId}`,
    ];
  }
  if (run?.sessionId) {
    return [
      `Browser Run session: ${run.sessionId}`,
      `Open it with: wrangler browser view ${run.sessionId}`,
      ...(run.error ? [`Live View unavailable: ${run.error}`] : []),
    ];
  }
  return [
    "No active browser session yet (navigate first).",
    "Fallback: run `wrangler browser list`, then `wrangler browser view <SESSION_ID>`.",
  ];
}

function buildBrowserDiagnostics(session: BrowserToolSession) {
  const run = session.browserRun;
  const diagnostics = {
    transport: "durable-object-rpc",
    lastAction: session.lastAction,
    lastKnownUrl: session.lastKnownUrl,
    lastTouchedAt: session.lastTouchedAt,
    browserRun: run ?? { sessionId: null },
    liveView: {
      supportedByBrowserRun: true,
      browserRunSessionIdExposed: true,
      note:
        "browserRun.sessionId is returned on every successful action; browserRun.liveViewUrl on navigate, live_view, diagnostics and request_human (CDP Cloudflare.getLiveView, tab mode).",
      commands: [
        "wrangler browser list",
        `wrangler browser view ${run?.sessionId ?? "<SESSION_ID>"}`,
      ],
    },
    humanInTheLoop: {
      supportedByBrowserRun: true,
      recommendedFor: ["login", "MFA", "CAPTCHA", "sensitive form entry"],
      resumeHint:
        "After the human finishes in Live View, tell the agent to continue from the current page state.",
    },
    sessionRecording: {
      supportedByBrowserRun: true,
      enabledInThisWrapper: false,
      note:
        "Browser Run Session Recordings require launching the browser with recording:true, which the Playwright MCP context factory does not expose yet.",
    },
  };

  const lines = [
    "Browser diagnostics ready.",
    `Transport: ${diagnostics.transport}`,
    `Last action: ${diagnostics.lastAction ?? "unknown"}`,
    `Last URL: ${diagnostics.lastKnownUrl ?? "unknown"}`,
    ...describeLiveView(run),
    "Operator flow: open the Live View link (or `wrangler browser list` + `wrangler browser view <SESSION_ID>`), complete the blocking step, then resume the agent.",
    "Session recordings are supported by Browser Run, but not configurable through the current MCP wrapper.",
  ];

  return { ok: true, content: lines.join("\n"), diagnostics };
}

function buildHumanHandoff(session: BrowserToolSession, reason?: string) {
  const run = session.browserRun;
  const steps = run?.liveViewUrl
    ? [
        `Open the Live View link: ${run.liveViewUrl} (or \`wrangler browser list\` then \`wrangler browser view ${run.sessionId}\`).`,
        "Complete the blocking step in Live View.",
        "Return to chat and tell the agent to continue.",
      ]
    : [
        `Run \`wrangler browser list\` (or use the Browser Run dashboard) and open ${run?.sessionId ? `session ${run.sessionId}` : "the matching active session"} with \`wrangler browser view <SESSION_ID>\`.`,
        "Complete the blocking step in Live View.",
        "Return to chat and tell the agent to continue.",
      ];

  const handoff = {
    reason: reason ?? "Browser automation needs a human operator.",
    lastKnownUrl: session.lastKnownUrl,
    browserRun: run ?? { sessionId: null },
    steps,
    note:
      "Use this for login, MFA, CAPTCHA, approval prompts, or any sensitive form entry you do not want to automate.",
  };

  const lines = [
    "Human browser handoff requested.",
    `Reason: ${handoff.reason}`,
    `Last URL: ${handoff.lastKnownUrl ?? "unknown"}`,
    ...describeLiveView(run),
    "Next steps:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ];

  return { ok: true, content: lines.join("\n"), handoff };
}
