import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { FLUSH_SYSTEM_PROMPT } from "./memory/flush.js";
import { flushToMemory, splitFlushSections } from "./memory/flush.js";

import type { SqlFn } from "./config/sql.js";

/**
 * Context compression with memory flush — Hermes-inspired structured approach.
 *
 * Improvements over the original:
 * 1. Pre-pruning: old tool results > 200 chars are cleared before LLM call (free tokens)
 * 2. Structured summary template (Goal/Progress/Decisions/Next Steps/Files)
 * 3. Iterative updates: 2nd+ compression merges into existing summary
 * 4. Tool pair integrity: orphaned tool results are removed
 * 5. Parallel flush + summarize (from previous iteration)
 */

const KEEP_RECENT = 8; // slightly more than before (was 6)

/** Old tool outputs beyond this length are truncated before summarization (step 0 pre-prune). */
const TOOL_RESULT_PRUNE_CHARS = 200;

const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION] Earlier turns were compacted to save space. " +
  "The summary below describes work already completed. " +
  "Files and state may already reflect these changes.\n\n";

const SUMMARIZE_SYSTEM = `Summarize this conversation excerpt using this EXACT structure:

## Goal
What the user is trying to accomplish (1-2 sentences)

## Progress
- Done: what was completed
- In progress: what is currently being worked on
- Blocked: any blockers (if none, omit)

## Key Decisions
Bullet list of decisions made and their rationale

## Relevant Files
List any file paths, URLs, or resources mentioned

## Next Steps
What should happen next

## Critical Context
Any other important context (user preferences, constraints, warnings)

Be concise. Omit empty sections. Max 600 words.`;

const ITERATIVE_SUMMARIZE_SYSTEM = `Update this existing conversation summary with new turns.
Keep the same structure (Goal/Progress/Decisions/Files/Next Steps/Context).
Move completed items from "In progress" to "Done". Update "Next Steps".
Remove outdated info superseded by new turns. Max 600 words.`;

export interface CompressionResult {
  compressed: ModelMessage[];
  flushResult: { memoryAdded: string | null; userAdded: string | null };
  originalCount: number;
  compressedCount: number;
  auxTokensIn: number;
  auxTokensOut: number;
}

/** The iterative summary is persisted in the DO's agent_config (per user by
 * construction) instead of isolate memory: DO hibernation would otherwise drop
 * a mid-session summary and lose the evicted context from later summaries. */
const SUMMARY_CONFIG_KEY = "_compression_summary";

function readPreviousSummary(sql: SqlFn): string | null {
  const rows = sql<{ value: string }>`SELECT value FROM agent_config WHERE key = ${SUMMARY_CONFIG_KEY}`;
  return rows[0]?.value ?? null;
}

function writePreviousSummary(sql: SqlFn, summary: string | null): void {
  if (summary === null) {
    sql`DELETE FROM agent_config WHERE key = ${SUMMARY_CONFIG_KEY}`;
  } else {
    sql`INSERT OR REPLACE INTO agent_config (key, value, encrypted, updated_at)
      VALUES (${SUMMARY_CONFIG_KEY}, ${summary}, 0, datetime('now'))`;
  }
}

/** Reset compression state on session change — prevents cross-session summary leaks */
export function resetCompressionState(sql: SqlFn): void {
  writePreviousSummary(sql, null);
}

export async function compressContext(
  messages: ModelMessage[],
  model: LanguageModel,
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  threshold: number = 40,
): Promise<CompressionResult | null> {
  if (messages.length <= threshold) return null;

  // Split: keep first + last N, compress the middle
  const first = messages[0];
  const recent = messages.slice(-KEEP_RECENT);
  const middle = messages.slice(1, -KEEP_RECENT);

  if (middle.length < 4) return null;

  // Step 0b: Remove orphaned tool messages from middle
  const cleanMiddle = sanitizeToolPairs(middle);

  // Step 0: Pre-prune old tool results (free tokens, no LLM needed).
  // Like Hermes: cap old tool output at 200 chars. Without this, a single large
  // crawl/search dump eats the whole 12KB summarization window and the summary
  // misses most of the actual conversation.
  const middleText = cleanMiddle
    .map((m) => {
      const role = m.role;
      let content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
      if (role === "tool" && content.length > TOOL_RESULT_PRUNE_CHARS) {
        content = content.slice(0, TOOL_RESULT_PRUNE_CHARS) + " [...tool result pruned]";
      }
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  // Step 1 + 2: Flush + Summarize in PARALLEL
  const cappedMiddle = middleText.slice(0, 12000); // increased from 8000
  let flushResult = { memoryAdded: null as string | null, userAdded: null as string | null };
  let summary: string;

  const previousSummary = readPreviousSummary(sql);
  const summarizeSystem = previousSummary ? ITERATIVE_SUMMARIZE_SYSTEM : SUMMARIZE_SYSTEM;
  const summarizePrompt = previousSummary
    ? `Existing summary:\n${previousSummary}\n\n---\n\nNew turns to integrate:\n${cappedMiddle}`
    : cappedMiddle;

  const [flushRes, summaryRes] = await Promise.allSettled([
    generateText({ model, system: FLUSH_SYSTEM_PROMPT, prompt: cappedMiddle }),
    generateText({ model, system: summarizeSystem, prompt: summarizePrompt }),
  ]);

  let auxTokensIn = 0, auxTokensOut = 0;

  if (flushRes.status === "fulfilled") {
    auxTokensIn += flushRes.value.usage?.inputTokens ?? 0;
    auxTokensOut += flushRes.value.usage?.outputTokens ?? 0;
    try {
      const sections = splitFlushSections(flushRes.value.text);
      flushResult = await flushToMemory(sql, r2, userId, sections.memory, sections.user);
    } catch (e) { console.warn("Memory flush failed:", e); }
  }

  if (summaryRes.status === "fulfilled") {
    auxTokensIn += summaryRes.value.usage?.inputTokens ?? 0;
    auxTokensOut += summaryRes.value.usage?.outputTokens ?? 0;
    summary = summaryRes.value.text;
    writePreviousSummary(sql, summary);
  } else {
    summary = `[Conversation summary unavailable — ${middle.length} messages compressed]`;
    writePreviousSummary(sql, null); // Clear stale summary to prevent cross-session contamination
  }

  const syntheticMessage: ModelMessage = {
    role: "assistant",
    content: `${SUMMARY_PREFIX}${summary}`,
  };

  const compressed = [first, syntheticMessage, ...recent];

  return {
    compressed,
    flushResult,
    originalCount: messages.length,
    compressedCount: compressed.length,
    auxTokensIn,
    auxTokensOut,
  };
}

/**
 * Remove orphaned tool messages from the middle section.
 * Keeps tool messages that have a preceding assistant message with tool_calls,
 * drops standalone tool messages that would cause API errors.
 */
function sanitizeToolPairs(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  let lastAssistantHadTools = false;

  for (const m of messages) {
    if (m.role === "assistant") {
      // Check if this assistant message contains tool calls
      const parts = Array.isArray(m.content) ? m.content : [];
      lastAssistantHadTools = parts.some((p: unknown) =>
        typeof p === "object" && p !== null && "type" in p && (p as { type: string }).type === "tool-call"
      );
      result.push(m);
    } else if (m.role === "tool") {
      // Only keep tool results if the previous assistant had tool calls
      if (lastAssistantHadTools) {
        result.push(m);
      }
    } else {
      lastAssistantHadTools = false;
      result.push(m);
    }
  }
  return result;
}
