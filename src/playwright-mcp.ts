import { env } from "cloudflare:workers";
import { createMcpAgent } from "@cloudflare/playwright-mcp";

/**
 * Playwright MCP Durable Object.
 *
 * Exposes browser automation tools via MCP protocol.
 * The LLM can connect and control a real headless Chromium browser.
 *
 * Connect via:
 *   - SSE: /mcp/sse
 *   - Streamable HTTP: /mcp
 */
export const PlaywrightMCP = createMcpAgent(
  (env as unknown as Env).BROWSER,
  { capabilities: ["core", "tabs", "wait", "files"] }
);
