import { z } from "zod";
import { DELEGATE_MAX_BATCH } from "../config/constants.js";
import type { ToolContext } from "./registry.js";

const taskSchema = z.object({
  goal: z.string().describe("Clear description of what the sub-agent should accomplish"),
  context: z.string().optional().describe("Relevant context from the current conversation"),
});

/**
 * Async delegation via Cloudflare Workflows.
 *
 * Pattern (hermes-agent notify_on_complete, NousResearch PR #5779):
 *   1. Create a Workflow instance per task (parallel batch with Promise.allSettled)
 *   2. INSERT a row into `pending_delegates` so the DO knows this task is running
 *   3. Return IMMEDIATELY with `{ status: "queued", ids }`
 *   4. The workflow runs in the background (inference + tools)
 *   5. On completion, the workflow calls `agent.onDelegateComplete(result)` via RPC
 *   6. The result is injected as a system message in the next parent turn
 *
 * The parent agent does NOT block. The user can keep chatting; delegate results
 * surface in context on their next message.
 */
export function createDelegateTool(ctx: ToolContext & { onToolProgress?: (name: string, preview: string) => void }) {
  const env = ctx.env as Env;
  const workflow = env.DELEGATE_WORKFLOW;
  if (!workflow) throw new Error("DELEGATE_WORKFLOW binding missing");

  return {
    description:
      "Delegate independent research tasks to async sub-agents that run in the background.\n" +
      "Returns IMMEDIATELY — the user can keep chatting while sub-agents work.\n" +
      "Results are automatically injected into the conversation when complete (next turn).\n" +
      "Sub-agents have web search + URL read only — no browser, no memory writes.\n" +
      "Use for: parallel research on 2-3 complementary angles, deep web research, gathering diverse info.\n" +
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

      const progress = ctx.onToolProgress;

      // Fault-isolated fan-out: use allSettled so one workflow creation failure
      // doesn't nuke the whole batch (fixes the Promise.all hazard we had before).
      const launches = await Promise.allSettled(
        taskList.map(async (task, i) => {
          const label = taskList.length > 1 ? `[${i + 1}/${taskList.length}]` : "";
          progress?.("delegate", `${label} Queueing: ${task.goal.slice(0, 60)}`);

          const id = crypto.randomUUID();

          // Pre-INSERT the pending row so the eventual onDelegateComplete has somewhere to UPDATE.
          // Doing this before workflow creation means the row exists even if create() races the callback.
          // platform + chat_id are captured here so the auto-resume that fires when the
          // last delegate of this session completes knows where to push the synthesized reply.
          ctx.sql`INSERT INTO pending_delegates (id, session_id, goal, context, status, platform, chat_id)
            VALUES (${id}, ${ctx.sessionId}, ${task.goal}, ${task.context ?? null}, 'queued', ${ctx.platform ?? null}, ${ctx.chatId ?? null})`;

          await workflow.create({
            id,
            params: {
              id,
              goal: task.goal,
              context: task.context,
              depth: 1,
              userId: ctx.userId,
              sessionId: ctx.sessionId,
            },
          });

          return { id, goal: task.goal };
        }),
      );

      const queued: Array<{ id: string; goal: string }> = [];
      const failed: Array<{ goal: string; error: string }> = [];
      for (let i = 0; i < launches.length; i++) {
        const launch = launches[i];
        if (launch.status === "fulfilled") {
          queued.push(launch.value);
        } else {
          failed.push({
            goal: taskList[i].goal,
            error: launch.reason instanceof Error ? launch.reason.message : String(launch.reason),
          });
        }
      }

      return {
        status: "queued" as const,
        queued: queued.map((q) => ({ id: q.id, goal: q.goal })),
        failed: failed.length > 0 ? failed : undefined,
        _note:
          "Sub-agents are running in the background. Their results will appear in your context " +
          "at the next user turn as system messages. Finish your current response and let the user " +
          "know research is in progress — they can keep chatting in the meantime.",
      };
    },
  };
}
