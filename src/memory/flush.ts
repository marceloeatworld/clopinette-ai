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
Return two sections, each a concise bullet list (one line per fact, starting with "- "):

MEMORY:
Facts about the world, projects, decisions made, problems solved.

USER:
Facts about the user themselves: preferences, identity, context, constraints.

If a section has nothing worth saving, write exactly "NOTHING" under it.
Do NOT include conversational filler or obvious context.
Do NOT extract personality/persona traits (speaking style, character names, role-play behavior, catchphrases). These come from a switchable preset and are NOT facts about the user or the world.`;

/**
 * Split the aux model's flush output into its MEMORY / USER sections.
 * Output without section headers is treated as memory-only (legacy shape).
 */
export function splitFlushSections(text: string): { memory: string | null; user: string | null } {
  const userIdx = text.search(/^\s*USER\s*:/im);
  const memIdx = text.search(/^\s*MEMORY\s*:/im);
  if (userIdx === -1 && memIdx === -1) {
    const t = text.trim();
    return { memory: t && t !== "NOTHING" ? t : null, user: null };
  }
  const clean = (s: string): string | null => {
    const t = s.replace(/^\s*(MEMORY|USER)\s*:/i, "").trim();
    return t && t.toUpperCase() !== "NOTHING" ? t : null;
  };
  if (userIdx === -1) return { memory: clean(text.slice(memIdx)), user: null };
  if (memIdx === -1) return { memory: null, user: clean(text.slice(userIdx)) };
  return memIdx < userIdx
    ? { memory: clean(text.slice(memIdx, userIdx)), user: clean(text.slice(userIdx)) }
    : { memory: clean(text.slice(memIdx)), user: clean(text.slice(userIdx, memIdx)) };
}

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
