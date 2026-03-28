import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { scanForThreats } from "../memory/security.js";

export function createNoteTool(ctx: ToolContext) {
  // Ensure table exists (idempotent — also created in agent.ts #initSchema)
  ctx.sql`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`;

  return {
    description:
      "Manage the user's personal notes.\n" +
      "USE IMMEDIATELY — call this tool BEFORE responding — when the user wants to save, note down, or bookmark something.\n" +
      "Detect intent in ANY language: note/save/remember/keep/bookmark/записать/noter/guardar/notieren/メモ etc.\n" +
      "When saving: call notes FIRST, then confirm briefly. Do NOT give advice about the note content unless asked.\n" +
      "Actions: save (new note), list (recent notes), delete (remove by id), edit (update by id), search (find notes by keyword).",
    inputSchema: z.object({
      action: z.enum(["save", "list", "delete", "edit", "search"]).describe("Action to perform"),
      content: z.string().optional().describe("Note content (for save/edit) or search query (for search)"),
      id: z.number().optional().describe("Note id (for delete/edit)"),
    }),
    execute: async (params: { action: string; content?: string; id?: number }) => {
      switch (params.action) {
        case "save": {
          if (!params.content?.trim()) return { ok: false, error: "content required" };
          const text = params.content.trim();
          if (text.length > 5000) return { ok: false, error: "Max 5000 chars" };
          const threat = scanForThreats(text);
          if (threat) return { ok: false, error: `Blocked: ${threat}` };
          ctx.sql`INSERT INTO notes (content, source) VALUES (${text}, 'chat')`;
          return { ok: true, message: "Note saved." };
        }
        case "list": {
          const rows = ctx.sql<{ id: number; content: string; created_at: string }>`
            SELECT id, content, created_at FROM notes ORDER BY created_at DESC LIMIT 20
          `;
          return {
            ok: true,
            notes: rows.map(r => ({
              id: r.id,
              content: r.content,
              createdAt: r.created_at,
            })),
          };
        }
        case "delete": {
          if (!params.id) return { ok: false, error: "id required for delete" };
          const exists = ctx.sql<{ id: number }>`SELECT id FROM notes WHERE id = ${params.id}`;
          if (exists.length === 0) return { ok: false, error: `Note #${params.id} not found` };
          ctx.sql`DELETE FROM notes WHERE id = ${params.id}`;
          return { ok: true, message: `Note #${params.id} deleted.` };
        }
        case "edit": {
          if (!params.id) return { ok: false, error: "id required for edit" };
          if (!params.content?.trim()) return { ok: false, error: "content required for edit" };
          const newText = params.content.trim();
          if (newText.length > 5000) return { ok: false, error: "Max 5000 chars" };
          const threat = scanForThreats(newText);
          if (threat) return { ok: false, error: `Blocked: ${threat}` };
          const row = ctx.sql<{ id: number }>`SELECT id FROM notes WHERE id = ${params.id}`;
          if (row.length === 0) return { ok: false, error: `Note #${params.id} not found` };
          ctx.sql`UPDATE notes SET content = ${newText}, updated_at = datetime('now') WHERE id = ${params.id}`;
          return { ok: true, message: `Note #${params.id} updated.` };
        }
        case "search": {
          if (!params.content?.trim()) return { ok: false, error: "search query required (pass in content)" };
          const query = `%${params.content.trim()}%`;
          const rows = ctx.sql<{ id: number; content: string; created_at: string }>`
            SELECT id, content, created_at FROM notes WHERE content LIKE ${query} ORDER BY created_at DESC LIMIT 10
          `;
          return {
            ok: true,
            notes: rows.map(r => ({
              id: r.id,
              content: r.content,
              createdAt: r.created_at,
            })),
          };
        }
        default:
          return { ok: false, error: `Unknown action: ${params.action}` };
      }
    },
  };
}
