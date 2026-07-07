import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { updatePromptMemory, getPromptMemory } from "../memory/prompt-memory.js";

export function createMemoryTool(ctx: ToolContext) {
  return {
    description:
      "Save durable information to persistent memory that survives across sessions. " +
      "Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.\n\n" +
      "WHEN TO SAVE (do this proactively, don't wait to be asked):\n" +
      "- User corrects you or says 'remember this' / 'don't do that again'\n" +
      "- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n" +
      "- You discover something about the environment (OS, installed tools, project structure)\n" +
      "- You learn a convention, API quirk, or workflow specific to this user's setup\n" +
      "- You identify a stable fact that will be useful again in future sessions\n\n" +
      "PRIORITY: User preferences and corrections > environment facts > procedural knowledge. " +
      "The most valuable memory prevents the user from having to repeat themselves.\n\n" +
      "Do NOT save task progress, session outcomes, completed-work logs, or temporary state. " +
      "If you've solved a problem that could be needed later, save it as a skill instead.\n\n" +
      "TWO TARGETS:\n" +
      "- 'user': who the user is — name, role, preferences, communication style, pet peeves, personal details\n" +
      "- 'memory': your notes — environment facts, project conventions, tool quirks, lessons learned\n\n" +
      "SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.\n\n" +
      "Operations: 'read' to see current content, 'add' to append, 'replace' to swap text, 'remove' to delete.",
    inputSchema: z.object({
      type: z
        .enum(["memory", "user"])
        .describe("'memory' for MEMORY.md (world facts), 'user' for USER.md (user info)"),
      operation: z
        .enum(["read", "add", "replace", "remove"])
        .describe("What to do"),
      value: z
        .string()
        .optional()
        .describe("Text to add, or replacement text for 'replace'"),
      target: z
        .string()
        .optional()
        .describe("Text to find (required for 'replace' and 'remove')"),
    }),
    execute: async ({
      type,
      operation,
      value,
      target,
    }: {
      type: "memory" | "user";
      operation: "read" | "add" | "replace" | "remove";
      value?: string;
      target?: string;
    }) => {
      if (operation === "read") {
        const content = getPromptMemory(ctx.sql, type);
        return { ok: true, content: content || "(empty)" };
      }

      if (!value && operation !== "remove") {
        return { ok: false, error: "value is required for add/replace" };
      }

      const result = await updatePromptMemory(
        ctx.sql,
        ctx.r2Memories,
        ctx.userId,
        type,
        operation,
        value ?? "",
        target
      );
      return result;
    },
  };
}
