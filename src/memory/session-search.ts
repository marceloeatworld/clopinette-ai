import { SQL_MAX_CONTENT_LENGTH } from "../config/constants.js";
import type { SessionMessageRow } from "../config/types.js";
import { upsertMessageVector, searchSessionsHybrid } from "./vector-search.js";
import { redact } from "../enterprise/redact.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Layer 2: Session Search — FTS5 + Vectorize hybrid episodic recall.
 *
 * Messages are mirrored to `session_messages` on every turn. FTS5 triggers
 * keep the keyword index in sync automatically. When a Vectorize binding is
 * available, we also embed each message (fire-and-forget via `waitUntil`)
 * and upsert it into the vector index for semantic recall.
 */

export interface MirrorVectorCtx {
  ai: Ai;
  vectors: VectorizeIndex;
  userId: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

export function mirrorMessage(
  sql: SqlFn,
  sessionId: string,
  role: "user" | "assistant" | "tool" | "system",
  content: string,
  toolCallId?: string,
  toolName?: string,
  vectorCtx?: MirrorVectorCtx,
): void {
  // Secret-redact before anything else — if a tool result or an LLM response
  // contains an API key (whether by accident or by injection), we scrub it
  // before it ever touches SQLite, FTS5, or Vectorize.
  const scrubbed = redact(content);

  // Truncate to stay under 100KB SQL statement limit
  const truncated =
    scrubbed.length > SQL_MAX_CONTENT_LENGTH
      ? scrubbed.slice(0, SQL_MAX_CONTENT_LENGTH) + "\n[truncated]"
      : scrubbed;

  sql`INSERT INTO session_messages (session_id, role, content, tool_call_id, tool_name)
      VALUES (${sessionId}, ${role}, ${truncated}, ${toolCallId ?? null}, ${toolName ?? null})`;

  if (vectorCtx) {
    const inserted = sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    const messageId = inserted[0]?.id;
    if (messageId && messageId > 0) {
      vectorCtx.waitUntil(
        upsertMessageVector(vectorCtx.ai, vectorCtx.vectors, {
          messageId,
          userId: vectorCtx.userId,
          sessionId,
          role,
          content: truncated,
        }),
      );
    }
  }
}

export interface SearchResult {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  rank: number;
}

/**
 * Full-text search across all session messages.
 * Uses FTS5 MATCH with BM25 ranking.
 */
export function searchSessions(
  sql: SqlFn,
  query: string,
  limit = 10
): SearchResult[] {
  // Sanitize query for FTS5 — escape special chars and wrap in quotes if needed
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) return [];

  const rows = sql<{
    id: number;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
    rank: number;
  }>`
    SELECT
      sm.id, sm.session_id, sm.role, sm.content, sm.created_at,
      rank
    FROM session_messages_fts
    JOIN session_messages sm ON sm.id = session_messages_fts.rowid
    WHERE session_messages_fts MATCH ${sanitized}
    ORDER BY rank
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    rank: r.rank,
  }));
}

// ───────────────────────── Grouped Search ─────────────────────────

export interface GroupedMatch {
  role: string;
  content: string;
  date: string;
}

export interface GroupedSearchResult {
  sessionId: string;
  title: string | null;
  date: string;
  matches: GroupedMatch[];
}

export interface GroupedSearchCtx {
  ai: Ai;
  vectors: VectorizeIndex | undefined;
  userId: string;
}

/**
 * Search with results grouped by session and enriched with ±1 context messages.
 * Uses hybrid FTS5 + Vectorize RRF when a vector context is provided, otherwise
 * falls back to FTS5 only.
 */
export async function searchSessionsGrouped(
  sql: SqlFn,
  query: string,
  limit = 5,
  vectorCtx?: GroupedSearchCtx,
): Promise<GroupedSearchResult[]> {
  const raw = vectorCtx
    ? await searchSessionsHybrid(sql, vectorCtx.ai, vectorCtx.vectors, vectorCtx.userId, query, limit * 3)
    : searchSessions(sql, query, limit * 3);
  if (raw.length === 0) return [];

  // Group by session, track best rank per session
  const grouped = new Map<string, { hits: SearchResult[]; bestRank: number }>();
  for (const r of raw) {
    const g = grouped.get(r.sessionId) ?? { hits: [], bestRank: Infinity };
    g.hits.push(r);
    g.bestRank = Math.min(g.bestRank, r.rank);
    grouped.set(r.sessionId, g);
  }

  // Sort sessions by best match, take top N
  const sorted = [...grouped.entries()]
    .sort(([, a], [, b]) => a.bestRank - b.bestRank)
    .slice(0, limit);

  return sorted.map(([sessionId, { hits }]) => {
    // Get session metadata
    const sessionRows = sql<{ summary: string | null; started_at: string }>`
      SELECT summary, started_at FROM sessions WHERE id = ${sessionId}
    `;

    // Load ±1 context messages around each hit, dedup by id
    const seen = new Set<number>();
    const contextMessages: GroupedMatch[] = [];

    for (const hit of hits.slice(0, 3)) { // max 3 hits per session
      const neighbors = sql<{ id: number; role: string; content: string; created_at: string }>`
        SELECT id, role, content, created_at FROM session_messages
        WHERE session_id = ${sessionId} AND id BETWEEN ${hit.id - 1} AND ${hit.id + 1}
        ORDER BY id
      `;
      for (const n of neighbors) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        contextMessages.push({
          role: n.role,
          content: n.content.slice(0, 400),
          date: n.created_at,
        });
      }
    }

    return {
      sessionId,
      title: sessionRows[0]?.summary ?? null,
      date: sessionRows[0]?.started_at ?? hits[0].createdAt,
      matches: contextMessages,
    };
  });
}

/**
 * Get recent messages from a specific session.
 */
export function getSessionMessages(
  sql: SqlFn,
  sessionId: string,
  limit = 50
): SessionMessageRow[] {
  return sql<SessionMessageRow>`
    SELECT * FROM session_messages
    WHERE session_id = ${sessionId}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps each word in quotes to prevent FTS5 syntax errors.
 */
function sanitizeFts5Query(query: string): string {
  // Use Unicode-aware regex: \p{L} matches letters in any script (French é, Cyrillic, etc.)
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" ");
}
