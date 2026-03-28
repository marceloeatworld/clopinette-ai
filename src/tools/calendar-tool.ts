import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { scanForThreats } from "../memory/security.js";

export function createCalendarTool(ctx: ToolContext) {
  // Ensure table exists (idempotent — also created in agent.ts #initSchema)
  ctx.sql`CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER DEFAULT 0,
    location TEXT,
    reminder_minutes INTEGER,
    reminder_delivered INTEGER DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`;

  return {
    description:
      "Manage the user's calendar events and appointments.\n" +
      "USE THIS when the user mentions a date, meeting, appointment, deadline, or event.\n" +
      "Detect intent in ANY language: rdv/meeting/rendez-vous/appointment/reunión/Termin/予定 etc.\n" +
      "Parse dates naturally — the current date is in your system prompt.\n" +
      "Actions: create, upcoming, list, update, delete.",
    inputSchema: z.object({
      action: z.enum(["create", "upcoming", "list", "update", "delete"]),
      title: z.string().optional().describe("Event title (required for create)"),
      startAt: z.string().optional().describe("Start datetime in ISO 8601 (e.g. 2026-03-20T20:00:00). Required for create."),
      endAt: z.string().optional().describe("End datetime in ISO 8601"),
      allDay: z.boolean().optional().describe("True for all-day events"),
      location: z.string().optional().describe("Event location"),
      description: z.string().optional().describe("Event description or notes"),
      reminderMinutes: z.number().optional().describe("Reminder N minutes before (e.g. 15, 30, 60). Null = no reminder."),
      id: z.string().optional().describe("Event ID (required for update/delete)"),
      from: z.string().optional().describe("Start date filter for list (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date filter for list (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max events to return"),
    }),
    execute: async (params: {
      action: string; title?: string; startAt?: string; endAt?: string;
      allDay?: boolean; location?: string; description?: string;
      reminderMinutes?: number; id?: string; from?: string; to?: string; limit?: number;
    }) => {
      switch (params.action) {
        case "create": {
          if (!params.title?.trim()) return { ok: false, error: "title required" };
          if (!params.startAt) return { ok: false, error: "startAt required (ISO 8601)" };
          if (isNaN(new Date(params.startAt).getTime())) return { ok: false, error: "startAt must be a valid ISO 8601 date" };
          if (params.endAt && isNaN(new Date(params.endAt).getTime())) return { ok: false, error: "endAt must be a valid ISO 8601 date" };
          if (params.reminderMinutes != null && (params.reminderMinutes < 0 || !Number.isInteger(params.reminderMinutes))) return { ok: false, error: "reminderMinutes must be a positive integer" };
          // Security scan on text fields
          for (const text of [params.title, params.description, params.location].filter(Boolean) as string[]) {
            const threat = scanForThreats(text);
            if (threat) return { ok: false, error: `Blocked: ${threat}` };
          }
          const id = crypto.randomUUID();
          ctx.sql`INSERT INTO calendar_events (id, title, description, start_at, end_at, all_day, location, reminder_minutes, source)
            VALUES (${id}, ${params.title.trim()}, ${params.description ?? null}, ${params.startAt},
                    ${params.endAt ?? null}, ${params.allDay ? 1 : 0}, ${params.location ?? null},
                    ${params.reminderMinutes ?? null}, 'chat')`;
          const result: Record<string, unknown> = {
            ok: true, id, title: params.title.trim(), startAt: params.startAt,
            message: "Event created.",
          };
          if (params.reminderMinutes != null) {
            result.reminder = `${params.reminderMinutes} minutes before`;
          }
          return result;
        }
        case "upcoming": {
          const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
          const rows = ctx.sql<{ id: string; title: string; start_at: string; end_at: string | null; location: string | null; all_day: number; reminder_minutes: number | null }>`
            SELECT id, title, start_at, end_at, location, all_day, reminder_minutes
            FROM calendar_events WHERE start_at >= datetime('now')
            ORDER BY start_at ASC LIMIT ${limit}
          `;
          return {
            ok: true,
            events: rows.map(r => ({
              id: r.id, title: r.title, startAt: r.start_at, endAt: r.end_at,
              location: r.location, allDay: !!r.all_day,
              reminder: r.reminder_minutes != null ? `${r.reminder_minutes}min` : null,
            })),
          };
        }
        case "list": {
          const from = params.from ?? new Date().toISOString().slice(0, 10);
          const to = params.to ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
          const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
          const rows = ctx.sql<{ id: string; title: string; start_at: string; end_at: string | null; location: string | null; all_day: number; description: string | null }>`
            SELECT id, title, start_at, end_at, location, all_day, description
            FROM calendar_events WHERE start_at >= ${from} AND start_at <= ${to + "T23:59:59"}
            ORDER BY start_at ASC LIMIT ${limit}
          `;
          return {
            ok: true,
            events: rows.map(r => ({
              id: r.id, title: r.title, startAt: r.start_at, endAt: r.end_at,
              location: r.location, allDay: !!r.all_day, description: r.description,
            })),
          };
        }
        case "update": {
          if (!params.id) return { ok: false, error: "id required for update" };
          const existing = ctx.sql<{ id: string }>`SELECT id FROM calendar_events WHERE id = ${params.id}`;
          if (existing.length === 0) return { ok: false, error: "Event not found" };
          if (params.title !== undefined) ctx.sql`UPDATE calendar_events SET title = ${params.title.trim()} WHERE id = ${params.id}`;
          if (params.startAt !== undefined) ctx.sql`UPDATE calendar_events SET start_at = ${params.startAt} WHERE id = ${params.id}`;
          if (params.endAt !== undefined) ctx.sql`UPDATE calendar_events SET end_at = ${params.endAt} WHERE id = ${params.id}`;
          if (params.allDay !== undefined) ctx.sql`UPDATE calendar_events SET all_day = ${params.allDay ? 1 : 0} WHERE id = ${params.id}`;
          if (params.location !== undefined) ctx.sql`UPDATE calendar_events SET location = ${params.location} WHERE id = ${params.id}`;
          if (params.description !== undefined) ctx.sql`UPDATE calendar_events SET description = ${params.description} WHERE id = ${params.id}`;
          if (params.reminderMinutes !== undefined) ctx.sql`UPDATE calendar_events SET reminder_minutes = ${params.reminderMinutes}, reminder_delivered = 0 WHERE id = ${params.id}`;
          ctx.sql`UPDATE calendar_events SET updated_at = datetime('now') WHERE id = ${params.id}`;
          return { ok: true, message: "Event updated." };
        }
        case "delete": {
          if (!params.id) return { ok: false, error: "id required for delete" };
          const existing = ctx.sql<{ id: string }>`SELECT id FROM calendar_events WHERE id = ${params.id}`;
          if (existing.length === 0) return { ok: false, error: "Event not found" };
          ctx.sql`DELETE FROM calendar_events WHERE id = ${params.id}`;
          return { ok: true, message: "Event deleted." };
        }
        default:
          return { ok: false, error: `Unknown action: ${params.action}` };
      }
    },
  };
}
