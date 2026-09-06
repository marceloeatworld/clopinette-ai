import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";
import { endpointURLString } from "@cloudflare/playwright";
import type { Page } from "@cloudflare/playwright";
// The package only exports createMcpAgent, which builds ONE module-level MCP
// connection (= one browser) shared by every DO instance in the isolate and
// hides it in a closure. We need one connection per user DO and direct access
// to the browser for Browser Run session id + Live View, so we reach the
// internal factory. Same file the public entry point imports — esbuild bundles
// a single copy.
// @ts-expect-error internal entry point, no type declarations shipped
import { createConnection as createConnectionUntyped } from "../node_modules/@cloudflare/playwright-mcp/lib/esm/src/index.js";

/**
 * Playwright MCP Durable Object — one per user (idFromName(userId)).
 *
 * Two ways in:
 *   - RPC (`callTool`, `getBrowserRunInfo`) from the core worker's browser tool.
 *   - MCP over HTTP at `/mcp` for external clients, via `PlaywrightMCP.serve()`
 *     in index.ts (the DO itself only speaks the SDK's WebSocket transport).
 */

const CAPABILITIES = ["core", "tabs", "wait", "files"] as const;
const BROWSER = (env as unknown as Env).BROWSER;

/** Default Live View URL lifetime. Browser Run caps it at 1 hour. */
const LIVE_VIEW_TTL_MS = 15 * 60_000;

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface BrowserRunInfo {
  /** Browser Run (Browser Rendering) session id — `wrangler browser view <id>`. Null until a page is open. */
  sessionId: string | null;
  /** Current page URL, when a tab is open. */
  pageUrl?: string;
  /** Live View URL for the current tab (human handoff: login, MFA, CAPTCHA). */
  liveViewUrl?: string;
  liveViewExpiresAt?: string;
  /** Set when the session id or Live View could not be resolved. */
  error?: string;
}

interface McpTool {
  schema: { name: string; inputSchema: { parse(value: unknown): unknown } };
  clearsModalState?: string;
}

interface McpContext {
  tools: McpTool[];
  tabs(): Array<{ page: Page }>;
  modalStates(): Array<{ type: string }>;
  modalStatesMarkdown(): string[];
  run(tool: McpTool, params: unknown): Promise<McpToolResult>;
}

interface McpConnection {
  server: unknown;
  context: McpContext;
  close(): Promise<void>;
}

const createConnection = createConnectionUntyped as (config: {
  capabilities: string[];
  browser: { cdpEndpoint: string };
}) => Promise<McpConnection>;

const Base = createMcpAgent(BROWSER, { capabilities: [...CAPABILITIES] });
// Base has a protected constructor, so InstanceType<> is rejected; prototype works.
type BaseInstance = (typeof Base)["prototype"];

function errorResult(...messages: string[]): McpToolResult {
  return { content: [{ type: "text", text: messages.join("\n") }], isError: true };
}

export class PlaywrightMCP extends Base {
  server: BaseInstance["server"];
  #connection: Promise<McpConnection>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Per-instance connection: this DO's browser is this user's browser.
    this.#connection = createConnection({
      capabilities: [...CAPABILITIES],
      browser: { cdpEndpoint: endpointURLString(BROWSER) },
    });
    this.server = this.#connection.then((c) => c.server) as BaseInstance["server"];
  }

  async init(): Promise<void> {}

  /** Run one Playwright MCP tool in-process (same checks as the MCP CallTool handler). */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const { context } = await this.#connection;
    const tool = context.tools.find((t) => t.schema.name === name);
    if (!tool) return errorResult(`Tool "${name}" not found`);

    const modalStates = context.modalStates().map((s) => s.type);
    if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState)) {
      return errorResult(
        `The tool "${name}" can only be used when there is related modal state present.`,
        ...context.modalStatesMarkdown(),
      );
    }
    if (!tool.clearsModalState && modalStates.length) {
      return errorResult(`Tool "${name}" does not handle the modal state.`, ...context.modalStatesMarkdown());
    }
    try {
      return await context.run(tool, args);
    } catch (err) {
      return errorResult(String(err));
    }
  }

  /**
   * Browser Run session id of this DO's browser, plus a Live View URL on demand
   * (CDP `Cloudflare.getLiveView` on the current tab).
   */
  async getBrowserRunInfo(options?: { liveView?: boolean; expiresInMs?: number }): Promise<BrowserRunInfo> {
    const { context } = await this.#connection;
    const tabs = context.tabs();
    if (tabs.length === 0) return { sessionId: null };

    const page = tabs[tabs.length - 1].page;
    const info: BrowserRunInfo = { sessionId: null };
    try {
      info.pageUrl = page.url();
      const browser = page.context().browser() as unknown as { sessionId?: () => string } | null;
      info.sessionId = browser?.sessionId?.() ?? null;
    } catch (err) {
      info.error = `Session lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (options?.liveView) {
      const expiresInMs = Math.min(Math.max(options.expiresInMs ?? LIVE_VIEW_TTL_MS, 60_000), 60 * 60_000);
      try {
        const cdp = await page.context().newCDPSession(page);
        const send = (cdp as unknown as {
          send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
        }).send.bind(cdp);
        const result = await send("Cloudflare.getLiveView", { mode: "tab", expiresInMs });
        await cdp.detach().catch(() => {});
        if (typeof result.devtoolsFrontendUrl === "string") {
          info.liveViewUrl = result.devtoolsFrontendUrl;
          info.liveViewExpiresAt = new Date(Date.now() + expiresInMs).toISOString();
        } else {
          info.error = "Live View not returned by Browser Run";
        }
      } catch (err) {
        info.error = `Live View failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return info;
  }
}
