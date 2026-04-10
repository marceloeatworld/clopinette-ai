import type { SqlFn } from "../config/sql.js";
import { searchSessions, type SearchResult } from "./session-search.js";

/**
 * Hybrid search over session history — keyword BM25 (FTS5) + semantic (Vectorize).
 *
 * Embedding model: `@cf/baai/bge-m3` (1024-d, multilingual, cosine similarity).
 * Isolation: metadata filter on `userId` (required — index is shared across users).
 * Fusion: Reciprocal Rank Fusion with k=60 (Cormack et al.).
 * Fallback: if Vectorize throws, we return FTS5 results alone — search degrades
 * gracefully instead of breaking the agent.
 */

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const RRF_K = 60;

interface BgeEmbeddingResponse {
  data: number[][];
}

/**
 * Produce a single 1024-d embedding for a text. Returns null on failure so the
 * caller can degrade to FTS5-only search.
 */
export async function embedText(ai: Ai, text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  try {
    const result = (await ai.run(EMBEDDING_MODEL, { text: [text] })) as BgeEmbeddingResponse;
    return result.data?.[0] ?? null;
  } catch (err) {
    console.warn("[vector] embed failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Upsert a single message vector. Fire-and-forget from the caller's POV
 * (the caller wraps in `ctx.waitUntil`). Errors are logged but not rethrown.
 */
export async function upsertMessageVector(
  ai: Ai,
  vectors: VectorizeIndex,
  params: {
    messageId: number;
    userId: string;
    sessionId: string;
    role: string;
    content: string;
  },
): Promise<void> {
  const { messageId, userId, sessionId, role, content } = params;
  const embedding = await embedText(ai, content);
  if (!embedding) return;
  try {
    await vectors.upsert([{
      id: `msg_${userId}_${messageId}`,
      values: embedding,
      metadata: { userId, sessionId, role, messageId },
    }]);
  } catch (err) {
    console.warn("[vector] upsert failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Delete every vector belonging to a user. Used by /wipe and the clerk user.deleted webhook.
 * Vectorize has no deleteByFilter, so we query by userId filter and batch-delete the ids.
 */
export async function deleteUserVectors(
  ai: Ai,
  vectors: VectorizeIndex,
  userId: string,
): Promise<{ deleted: number }> {
  let deleted = 0;
  try {
    // Dummy embedding for the query — we only care about the filter, not the similarity
    const dummy = new Array(1024).fill(0);
    dummy[0] = 1;
    let more = true;
    while (more) {
      const matches = await vectors.query(dummy, {
        topK: 100,
        filter: { userId },
        returnMetadata: false,
      });
      const ids = matches.matches.map((m) => m.id);
      if (ids.length === 0) { more = false; break; }
      await vectors.deleteByIds(ids);
      deleted += ids.length;
      if (ids.length < 100) more = false;
    }
  } catch (err) {
    console.warn("[vector] deleteUser failed:", err instanceof Error ? err.message : String(err));
  }
  // unused `ai` — kept in signature for symmetry; embedding isn't needed for deletion
  void ai;
  return { deleted };
}

/**
 * Reciprocal Rank Fusion — combines ranked lists into a single score.
 *
 * For each document that appears in at least one list, its fused score is
 *   sum over lists of 1 / (k + rank_in_list)
 * where `rank_in_list` is 1-indexed. k=60 is the value from the original RRF paper.
 * Documents that appear in multiple lists naturally rise to the top.
 */
function rrfFuse<T extends { id: number | string }>(
  lists: T[][],
  k = RRF_K,
): Array<{ doc: T; score: number }> {
  const scores = new Map<string, { doc: T; score: number }>();
  for (const list of lists) {
    list.forEach((doc, idx) => {
      const key = String(doc.id);
      const add = 1 / (k + idx + 1);
      const existing = scores.get(key);
      if (existing) existing.score += add;
      else scores.set(key, { doc, score: add });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/**
 * Hybrid keyword + semantic search over the user's session history.
 *
 * Runs FTS5 and Vectorize in parallel, fuses via RRF, then joins back to SQLite
 * to rehydrate full message rows. If Vectorize is unavailable or throws, we
 * silently fall back to FTS5-only results — search never fails hard.
 */
export async function searchSessionsHybrid(
  sql: SqlFn,
  ai: Ai,
  vectors: VectorizeIndex | undefined,
  userId: string,
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  const fts5Promise = Promise.resolve(searchSessions(sql, query, limit * 2));

  // If no Vectorize binding, return FTS5 alone — keeps local dev painless
  if (!vectors) return (await fts5Promise).slice(0, limit);

  const vectorPromise = (async (): Promise<SearchResult[]> => {
    try {
      const embedding = await embedText(ai, query);
      if (!embedding) return [];
      const matches = await vectors.query(embedding, {
        topK: limit * 2,
        filter: { userId },
        returnMetadata: "indexed",
      });
      if (matches.matches.length === 0) return [];

      // Rehydrate from SQLite using the messageId in metadata
      const messageIds = matches.matches
        .map((m) => (m.metadata as { messageId?: number } | undefined)?.messageId)
        .filter((id): id is number => typeof id === "number");
      if (messageIds.length === 0) return [];

      const placeholders = messageIds.map(() => "?").join(",");
      // SQL tagged template doesn't support dynamic IN lists, so build manually
      const rows: Array<{ id: number; session_id: string; role: string; content: string; created_at: string }> = [];
      for (const id of messageIds) {
        const row = sql<{ id: number; session_id: string; role: string; content: string; created_at: string }>`
          SELECT id, session_id, role, content, created_at FROM session_messages WHERE id = ${id}
        `;
        if (row[0]) rows.push(row[0]);
      }
      void placeholders;

      // Preserve Vectorize's similarity order
      const ordered = messageIds
        .map((id) => rows.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => !!r);

      return ordered.map((r, idx) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
        rank: idx, // RRF uses position in the list, not the raw similarity score
      }));
    } catch (err) {
      console.warn("[vector] query failed, falling back to FTS5:", err instanceof Error ? err.message : String(err));
      return [];
    }
  })();

  const [fts5, semantic] = await Promise.all([fts5Promise, vectorPromise]);

  // Fuse; if semantic came back empty (error or no hits), RRF degrades to FTS5 alone
  const fused = rrfFuse([fts5, semantic]);
  return fused.slice(0, limit).map(({ doc }) => doc);
}
