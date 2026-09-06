import { z } from "zod";
import type { ToolContext } from "./registry.js";
import { searchSessionsGrouped } from "../memory/session-search.js";

export function createSessionSearchTool(ctx: ToolContext) {
  return {
    description:
      "Hybrid keyword + semantic search across past conversation sessions.\n" +
      "Combines FTS5 exact-match with Vectorize embedding similarity via RRF fusion.\n" +
      "Finds paraphrases and concept matches, not just keyword overlaps.\n" +
      "USE THIS PROACTIVELY when:\n" +
      "- The user says 'we did this before', 'remember when', 'last time'\n" +
      "- You want to check if you've solved a similar problem before\n" +
      "- The user references something from a previous session\n" +
      "- You need context that might have been discussed earlier\n" +
      "The semantic half handles synonyms and rephrased questions — one query is usually enough.",
    inputSchema: z.object({
      query: z.string().describe("Search query — natural language or keywords"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Max sessions to return (default 5)"),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      const sessions = await searchSessionsGrouped(ctx.sql, query, limit, {
        ai: ctx.ai,
        vectors: (ctx.env as Env).VECTORS,
        userId: ctx.userId,
      });
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
