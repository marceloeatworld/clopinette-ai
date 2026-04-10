import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createWebTool } from "./tools/web-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import {
  DEFAULT_MODEL,
  DELEGATE_MAX_DEPTH,
  DELEGATE_MAX_STEPS,
} from "./config/constants.js";
import type { ToolContext } from "./tools/registry.js";

/**
 * Async delegation via Cloudflare Workflows.
 *
 * Replaces the ephemeral `DelegateWorker` Durable Object. Benefits:
 * - Durable, retry-safe steps (inference retries on 429/529 without losing progress)
 * - No parent DO blocking — results are pushed back via RPC on `onDelegateComplete`
 * - Fault isolation — one workflow crash doesn't take down siblings in a batch
 * - Observable via `wrangler workflows instances list delegate-workflow`
 *
 * Pattern: hermes-agent `notify_on_complete` (NousResearch PR #5779).
 * The parent DO never polls; the workflow calls back when done and the result
 * is injected as a system message in the next parent turn.
 */
export interface DelegateWorkflowParams {
  id: string;             // Shared with the pending_delegates.id row in the parent DO
  goal: string;
  context?: string;
  depth: number;
  userId: string;         // Parent DO name
  sessionId: string;      // Parent session the result gets injected into
}

const DELEGATE_SYSTEM_PROMPT = `You are a focused research sub-agent. You have a STRICT budget of 2 tool calls.

Rules:
- Do exactly 1 web search. If snippets answer the question, respond immediately.
- Only read a URL if snippets genuinely lack detail. Read at most 1 URL.
- NEVER repeat a search with a different query variation. One search, then answer.
- NEVER make up information. If you can't find it, say so.

Provide a clear, concise summary of what you found.`;

interface InferenceOutcome {
  status: "success" | "error";
  summary: string;
  toolTrace: string[];
  tokensIn: number;
  tokensOut: number;
  durationSeconds: number;
}

export class DelegateWorkflow extends WorkflowEntrypoint<Env, DelegateWorkflowParams> {
  async run(event: WorkflowEvent<DelegateWorkflowParams>, step: WorkflowStep): Promise<InferenceOutcome> {
    const { id, goal, context, depth, userId, sessionId } = event.payload;

    // Depth guard — refuse sub-delegation beyond the max depth without spending any tokens
    if (depth >= DELEGATE_MAX_DEPTH) {
      const outcome: InferenceOutcome = {
        status: "error",
        summary: "Maximum delegation depth reached.",
        toolTrace: [],
        tokensIn: 0,
        tokensOut: 0,
        durationSeconds: 0,
      };
      await this.#notifyParent(step, id, sessionId, userId, outcome);
      return outcome;
    }

    // Step 1: run the LLM + tools in a durable, retry-safe step
    const outcome = await step.do(
      "run_inference",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      async () => this.#runInference(goal, context),
    );

    // Step 2: notify the parent DO via RPC — separate step so a failed notify retries
    // without re-running the expensive inference above
    await this.#notifyParent(step, id, sessionId, userId, outcome);

    return outcome;
  }

  async #runInference(goal: string, context?: string): Promise<InferenceOutcome> {
    const start = Date.now();
    const toolTrace: string[] = [];

    try {
      const model = createWorkersAI({ binding: this.env.AI })(DEFAULT_MODEL);

      // Stateless tool context — no SQLite, no R2 writes, no memory
      const minimalCtx: ToolContext = {
        sql: (() => []) as unknown as ToolContext["sql"],
        r2Memories: null as unknown as R2Bucket,
        r2Skills: null as unknown as R2Bucket,
        ai: this.env.AI,
        userId: "delegate",
        sessionId: "delegate",
        env: { WS_SIGNING_SECRET: this.env.WS_SIGNING_SECRET },
        cfAccountId: this.env.CF_ACCOUNT_ID,
        cfBrowserToken: this.env.CF_BROWSER_TOKEN,
        searxngUrl: this.env.SEARXNG_URL,
        braveApiKey: this.env.BRAVE_API_KEY,
        playwrightMcp: this.env.PlaywrightMCP,
      };

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

      // Dedup + trace wrapper
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

              const dedupKey = `${name}:${JSON.stringify(args)}`;
              const cached = dedupCache.get(dedupKey);
              if (cached && Date.now() - cached.ts < 2000) return cached.result;

              const result = await t.execute(args);
              dedupCache.set(dedupKey, { result, ts: Date.now() });
              stepCount++;

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

      return {
        status: "success",
        summary: result.text || "No response generated.",
        toolTrace,
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut: result.usage?.outputTokens ?? 0,
        durationSeconds: Math.round((Date.now() - start) / 1000),
      };
    } catch (err) {
      return {
        status: "error",
        summary: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
        toolTrace,
        tokensIn: 0,
        tokensOut: 0,
        durationSeconds: Math.round((Date.now() - start) / 1000),
      };
    }
  }

  async #notifyParent(
    step: WorkflowStep,
    id: string,
    sessionId: string,
    userId: string,
    outcome: InferenceOutcome,
  ): Promise<void> {
    await step.do(
      "notify_parent",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" },
      async () => {
        const stub = this.env.CLOPINETTE_AGENT.get(this.env.CLOPINETTE_AGENT.idFromName(userId));
        await stub.onDelegateComplete({
          id,
          sessionId,
          status: outcome.status,
          summary: outcome.summary,
          toolTrace: outcome.toolTrace,
          durationSeconds: outcome.durationSeconds,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
        });
      },
    );
  }
}
