import { z } from "zod";
import type { ToolContext } from "./registry.js";

interface TodoRow {
  id: number;
  text: string;
  done: number;
  created_at: string;
}

export function createTodoTool(ctx: ToolContext) {
  // Ensure table exists (idempotent, lightweight)
  ctx.sql`CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`;

  return {
    description:
      "Manage the user's personal todo list.\n" +
      "USE when the user asks to track tasks, reminders, or action items.\n" +
      "Actions: list (show all), add (new item), done (mark complete), remove (delete).",
    inputSchema: z.object({
      action: z.enum(["list", "add", "done", "remove"]).describe("Action to perform"),
      text: z.string().optional().describe("Todo text (for add)"),
      id: z.number().optional().describe("Todo ID (for done/remove)"),
    }),
    execute: async (params: { action: string; text?: string; id?: number }) => {
      switch (params.action) {
        case "list": {
          const rows = ctx.sql<TodoRow>`SELECT * FROM todos ORDER BY done ASC, id DESC LIMIT 200`;
          return {
            ok: true,
            todos: rows.map((r) => ({
              id: r.id,
              text: r.text,
              done: !!r.done,
              createdAt: r.created_at,
            })),
          };
        }
        case "add": {
          if (!params.text) return { ok: false, error: "text required" };
          const count = ctx.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM todos WHERE done = 0`;
          if ((count[0]?.cnt ?? 0) >= 100) return { ok: false, error: "Todo list is full (100 active items max). Complete or remove some first." };
          ctx.sql`INSERT INTO todos (text) VALUES (${params.text})`;
          return { ok: true, message: `Added: ${params.text}` };
        }
        case "done": {
          if (!params.id) return { ok: false, error: "id required" };
          ctx.sql`UPDATE todos SET done = 1 WHERE id = ${params.id}`;
          return { ok: true, message: `Marked #${params.id} as done` };
        }
        case "remove": {
          if (!params.id) return { ok: false, error: "id required" };
          ctx.sql`DELETE FROM todos WHERE id = ${params.id}`;
          return { ok: true, message: `Removed #${params.id}` };
        }
        default:
          return { ok: false, error: `Unknown action: ${params.action}` };
      }
    },
  };
}
