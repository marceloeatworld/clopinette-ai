import { z } from "zod";
import { DELEGATE_MAX_BATCH } from "../config/constants.js";
import { trackAuxiliaryUsage } from "../pipeline.js";
import type { DelegateResult } from "../config/types.js";
import type { ToolContext } from "./registry.js";

const taskSchema = z.object({
  goal: z.string().describe("Clear description of what the sub-agent should accomplish"),
  context: z.string().optional().describe("Relevant context from the current conversation"),
});

export function createDelegateTool(ctx: ToolContext & { onToolProgress?: (name: string, preview: string) => void }) {
  const env = ctx.env as Env;
  const ns = env.DELEGATE_WORKER;
  if (!ns) throw new Error("DELEGATE_WORKER binding missing");

  return {
    description:
      "Delegate independent research tasks to sub-agents that run in parallel.\n" +
      "Sub-agents have web search and browser — they cannot write to memory.\n" +
      "Use for: parallel research on 2-3 topics, deep web research, gathering diverse info.\n" +
      "Do NOT delegate simple lookups — use web or docs directly.",
    inputSchema: z.object({
      goal: z.string().optional().describe("Single task: what the sub-agent should accomplish"),
      context: z.string().optional().describe("Relevant context from the current conversation"),
      tasks: z.array(taskSchema).max(DELEGATE_MAX_BATCH).optional()
        .describe("Batch mode: up to 3 parallel sub-tasks (overrides goal/context)"),
    }).refine(
      (d) => d.goal || (d.tasks && d.tasks.length > 0),
      { message: "Provide either 'goal' (single) or 'tasks' (batch)" },
    ),
    execute: async (params: { goal?: string; context?: string; tasks?: { goal: string; context?: string }[] }) => {
      const taskList = params.tasks?.length
        ? params.tasks
        : [{ goal: params.goal!, context: params.context }];

      const start = Date.now();
      const progress = ctx.onToolProgress;

      const promises = taskList.map(async (task, i) => {
        const label = taskList.length > 1 ? `[${i + 1}/${taskList.length}]` : "";
        progress?.("delegate", `${label} Starting: ${task.goal.slice(0, 60)}`);

        const id = ns.newUniqueId();
        const stub = ns.get(id);
        const res = await stub.fetch(new Request("https://delegate/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: task.goal, context: task.context ?? "", depth: 1 }),
        }));
        const result = await res.json<DelegateResult>();

        // Relay child tool trace as progress
        if (progress && result.toolTrace.length > 0) {
          progress("delegate", `${label} Done (${result.toolTrace.join(", ")})`);
        }

        return result;
      });

      const results = await Promise.all(promises);
      const totalDuration = Math.round((Date.now() - start) / 1000);

      // Track token usage for all sub-agents
      for (const r of results) {
        if (r.tokens.input > 0 || r.tokens.output > 0) {
          trackAuxiliaryUsage(
            ctx.sql, ctx.sessionId,
            r.tokens.input, r.tokens.output,
            "delegate-worker", env, ctx.userId, ctx.queueTask,
          );
        }
      }

      return {
        results: results.map((r, i) => ({
          task: taskList[i].goal,
          status: r.status,
          summary: r.summary,
          tools_used: r.toolTrace,
          duration: `${r.duration}s`,
        })),
        total_duration: `${totalDuration}s`,
        sub_agents: results.length,
        _note: "Research complete. Use these summaries directly — do NOT re-search the same topics.",
      };
    },
  };
}
