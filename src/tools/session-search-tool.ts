import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { searchSessionsGrouped } from "../memory/session-search.js";

export function createSessionSearchTool(ctx: ToolContext) {
  return {
    description:
      "Search across past conversation sessions using full-text search.\n" +
      "Results are grouped by session with surrounding context.\n" +
      "USE THIS PROACTIVELY when:\n" +
      "- The user says 'we did this before', 'remember when', 'last time'\n" +
      "- You want to check if you've solved a similar problem before\n" +
      "- The user references something from a previous session\n" +
      "- You need context that might have been discussed earlier\n" +
      "Search syntax: use keywords joined with spaces for broad recall. " +
      "IMPORTANT: Try multiple keyword variations if first search returns nothing.",
    inputSchema: z.object({
      query: z.string().describe("Search query — keywords or phrases to find"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Max sessions to return (default 5)"),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      const sessions = searchSessionsGrouped(ctx.sql, query, limit);
      if (sessions.length === 0) {
        return { ok: true, sessions: [], message: "No matching sessions found." };
      }
      return {
        ok: true,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          date: s.date,
          matches: s.matches,
        })),
      };
    },
  };
}
