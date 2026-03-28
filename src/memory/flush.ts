import { updatePromptMemory } from "./prompt-memory.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Layer 3: Memory Flush — save important info before context compression.
 *
 * Called before compression kicks in. An auxiliary (cheap) model summarizes
 * what's worth keeping from the conversation middle, and we attempt to
 * write it into prompt memory if there's room.
 *
 * Writes now route through updatePromptMemory for:
 * - Security scanning (prompt injection detection)
 * - R2 backup (MEMORY.md / USER.md)
 * - Duplicate detection
 * - Proper char-limit enforcement
 */

export const FLUSH_SYSTEM_PROMPT = `You are a memory extraction assistant.
Given a conversation excerpt, extract important facts worth remembering.
Focus on: user preferences, decisions made, facts learned, problems solved.
Return a concise bullet list (one line per fact, starting with "- ").
If nothing is worth saving, return exactly "NOTHING".
Do NOT include conversational filler or obvious context.
Do NOT extract personality/persona traits (speaking style, character names, role-play behavior, catchphrases). These come from a switchable preset and are NOT facts about the user or the world.`;

export interface FlushResult {
  memoryAdded: string | null;
  userAdded: string | null;
}

/**
 * Attempt to flush extracted facts into prompt memory.
 * Each bullet point is added individually for dedup and char-limit safety.
 * Routes through updatePromptMemory for security scan + R2 backup.
 */
export async function flushToMemory(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  extractedMemory: string | null,
  extractedUser: string | null
): Promise<FlushResult> {
  const result: FlushResult = { memoryAdded: null, userAdded: null };

  if (extractedMemory && extractedMemory !== "NOTHING") {
    const added = await flushBullets(sql, r2, userId, "memory", extractedMemory);
    if (added) result.memoryAdded = added;
  }
  if (extractedUser && extractedUser !== "NOTHING") {
    const added = await flushBullets(sql, r2, userId, "user", extractedUser);
    if (added) result.userAdded = added;
  }

  return result;
}

/**
 * Split flush text into bullet points and add each individually.
 * Stops on first char-limit error (no room for more).
 */
async function flushBullets(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  type: "memory" | "user",
  text: string
): Promise<string | null> {
  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length >= 5);

  if (lines.length === 0) return null;

  const added: string[] = [];
  for (const line of lines) {
    const entry = `- ${line}`;
    const res = await updatePromptMemory(sql, r2, userId, type, "add", entry);
    if (!res.ok) break; // char limit reached — stop
    added.push(line);
  }

  return added.length > 0 ? added.join("; ") : null;
}
