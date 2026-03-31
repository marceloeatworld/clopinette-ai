import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createWebTool } from "./tools/web-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import {
  DEFAULT_MODEL,
  DELEGATE_MAX_DEPTH,
  DELEGATE_MAX_STEPS,
} from "./config/constants.js";
import type { DelegateResult } from "./config/types.js";
import type { ToolContext } from "./tools/registry.js";

interface DelegateRequest {
  goal: string;
  context?: string;
  depth: number;
}

const DELEGATE_SYSTEM_PROMPT = `You are a focused research sub-agent. You have a STRICT budget of 2 tool calls.

Rules:
- Do exactly 1 web search. If snippets answer the question, respond immediately.
- Only read a URL if snippets genuinely lack detail. Read at most 1 URL.
- NEVER repeat a search with a different query variation. One search, then answer.
- NEVER make up information. If you can't find it, say so.

Provide a clear, concise summary of what you found.`;

/**
 * Lightweight ephemeral DO for delegated sub-tasks.
 * No SQLite, no lifecycle hooks, no memory — just inference + stateless tools.
 */
export class DelegateWorker extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { goal, context, depth } = await request.json<DelegateRequest>();

    if (depth >= DELEGATE_MAX_DEPTH) {
      return Response.json({
        status: "error",
        summary: "Maximum delegation depth reached.",
        toolTrace: [],
        duration: 0,
        tokens: { input: 0, output: 0 },
      } satisfies DelegateResult);
    }

    const start = Date.now();
    const toolTrace: string[] = [];

    try {
      const model = createWorkersAI({ binding: this.env.AI })(DEFAULT_MODEL);

      // Build minimal stateless tools — no sql, no r2 writes
      const minimalCtx: ToolContext = {
        sql: (() => []) as unknown as ToolContext["sql"],
        r2Memories: null as unknown as R2Bucket,
        r2Skills: null as unknown as R2Bucket,
        ai: this.env.AI,
        userId: "delegate",
        sessionId: "delegate",
        env: { WS_SIGNING_SECRET: "" },
        cfAccountId: this.env.CF_ACCOUNT_ID,
        cfBrowserToken: this.env.CF_BROWSER_TOKEN,
        searxngUrl: this.env.SEARXNG_URL,
        braveApiKey: this.env.BRAVE_API_KEY,
        playwrightMcp: this.env.PlaywrightMCP,
      };

      // Only stateless tools — no sql, no r2 writes.
      // docs omitted: requires R2 bucket + SQLite, both null in delegate context.
      const tools: Record<string, unknown> = {
        web: createWebTool(
          minimalCtx.cfAccountId,
          minimalCtx.cfBrowserToken,
          minimalCtx.ai,
          minimalCtx.searxngUrl,
          minimalCtx.braveApiKey,
        ),
        ...(minimalCtx.playwrightMcp ? { browser: createBrowserTool(minimalCtx) } : {}),
      };

      // Wrap tools: trace + dedup + budget pressure
      const dedupCache = new Map<string, { result: unknown; ts: number }>();
      let stepCount = 0;
      const tracedTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => {
          const t = tool as { description: string; inputSchema: unknown; execute: (args: unknown) => Promise<unknown> };
          return [name, {
            ...t,
            execute: async (args: unknown) => {
              const preview = (args as Record<string, unknown>)?.query
                ?? (args as Record<string, unknown>)?.action ?? "";
              toolTrace.push(`${name}(${String(preview).slice(0, 60)})`);

              // Dedup: same tool+args within 5s → cached result
              const dedupKey = `${name}:${JSON.stringify(args)}`;
              const cached = dedupCache.get(dedupKey);
              if (cached && Date.now() - cached.ts < 5000) return cached.result;

              const result = await t.execute(args);
              dedupCache.set(dedupKey, { result, ts: Date.now() });
              stepCount++;

              // Budget pressure for sub-agents (fires after step 2 of 3)
              const pct = stepCount / DELEGATE_MAX_STEPS;
              if (pct >= 0.5 && typeof result === "object" && result !== null) {
                return { ...result, _budget: "CRITICAL: You have used most of your steps. Respond NOW with what you have." };
              }
              return result;
            },
          }];
        }),
      );

      const systemPrompt = [
        DELEGATE_SYSTEM_PROMPT,
        `\nYOUR TASK:\n${goal}`,
        context ? `\nCONTEXT:\n${context}` : "",
      ].join("");

      const result = await generateText({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: goal }],
        tools: tracedTools as Parameters<typeof generateText>[0]["tools"],
        stopWhen: stepCountIs(DELEGATE_MAX_STEPS),
        maxRetries: 1,
      });

      const duration = Math.round((Date.now() - start) / 1000);

      return Response.json({
        status: "success",
        summary: result.text || "No response generated.",
        toolTrace,
        duration,
        tokens: {
          input: result.usage?.inputTokens ?? 0,
          output: result.usage?.outputTokens ?? 0,
        },
      } satisfies DelegateResult);
    } catch (err) {
      const duration = Math.round((Date.now() - start) / 1000);
      return Response.json({
        status: "error",
        summary: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
        toolTrace,
        duration,
        tokens: { input: 0, output: 0 },
      } satisfies DelegateResult);
    }
  }
}
