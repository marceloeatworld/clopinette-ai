import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { getAgentByName } from "agents";
import {
  DELEGATE_MAX_DEPTH,
  DELEGATE_MAX_STEPS,
} from "./config/constants.js";
import {
  buildDelegateSystemPrompt,
  buildDelegateTools,
} from "./delegation.js";
import {
  createModel,
  createAuxiliaryModel,
  PlanViolationError,
} from "./inference/provider.js";

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

interface InferenceOutcome {
  status: "success" | "error";
  modelId: string;
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
        modelId: "",
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
      async () => this.#runInference(goal, context, userId, sessionId),
    );

    // Step 2: notify the parent DO via RPC — separate step so a failed notify retries
    // without re-running the expensive inference above
    await this.#notifyParent(step, id, sessionId, userId, outcome);

    return outcome;
  }

  async #runInference(
    goal: string,
    context: string | undefined,
    userId: string,
    sessionId: string,
  ): Promise<InferenceOutcome> {
    const start = Date.now();
    const toolTrace: string[] = [];
    let modelId = "";

    try {
      // Fetch the parent user's inference config + plan via RPC. The DO holds
      // the master key — only it can decrypt API keys. This keeps BYOK delegates
      // routed through the user's own provider instead of our Workers AI.
      // getAgentByName sets `.name` on the stub — without this, this.queue() in
      // onDelegateComplete throws "Attempting to read .name on ClopinetteAgent
      // before it was set" because cross-worker RPC bypasses the routing layer.
      const stub = await getAgentByName(this.env.CLOPINETTE_AGENT, userId);
      let model;
      let auxiliary;
      try {
        const { config, plan } = await stub.getInferenceConfigForDelegation();
        modelId = config.model;
        model = createModel(config, this.env, undefined, {
          plan,
          telemetry: { userId, sessionId, purpose: "delegate" },
        });
        auxiliary = createAuxiliaryModel(config, this.env, plan, {
          userId,
          sessionId,
          purpose: "delegateAux",
        });
      } catch (err) {
        if (err instanceof PlanViolationError) {
          return {
            status: "error",
            modelId,
            summary: `Delegation skipped — ${err.message}`,
            toolTrace,
            tokensIn: 0,
            tokensOut: 0,
            durationSeconds: Math.round((Date.now() - start) / 1000),
          };
        }
        throw err;
      }

      // Delegates stay retry-safe by using the web tool only: one search plus
      // at most one read. Interactive browser state is intentionally excluded.
      const tools: Record<string, unknown> = buildDelegateTools({
        cfAccountId: this.env.CF_ACCOUNT_ID,
        cfBrowserToken: this.env.CF_BROWSER_TOKEN,
        auxModel: auxiliary.model,
        searxngUrl: this.env.SEARXNG_URL,
        braveApiKey: this.env.BRAVE_API_KEY,
      });

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

              if (stepCount >= DELEGATE_MAX_STEPS - 1 && typeof result === "object" && result !== null) {
                return { ...result, _budget: "CRITICAL: You have used most of your steps. Respond NOW with what you have." };
              }
              return result;
            },
          }];
        }),
      );

      const systemPrompt = buildDelegateSystemPrompt(goal, context);

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
        modelId,
        summary: result.text || "No response generated.",
        toolTrace,
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut: result.usage?.outputTokens ?? 0,
        durationSeconds: Math.round((Date.now() - start) / 1000),
      };
    } catch (err) {
      return {
        status: "error",
        modelId,
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
        // getAgentByName instead of raw .get(idFromName) — required so that
        // this.name is set on the DO. The auto-resume scheduler in
        // onDelegateComplete uses this.queue() which depends on this.name.
        const stub = await getAgentByName(this.env.CLOPINETTE_AGENT, userId);
        await stub.onDelegateComplete({
          id,
          sessionId,
          status: outcome.status,
          modelId: outcome.modelId,
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
