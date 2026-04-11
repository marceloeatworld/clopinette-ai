import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT } from "../config/constants.js";
import { getPromptMemory, updatePromptMemory } from "./prompt-memory.js";
import { createSkill, searchSkills, editSkill } from "./skills.js";
import { logAudit } from "../enterprise/audit.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Self-learning system — ported from hermes-agent.
 *
 * Every N conversation turns, a background review runs to:
 * 1. Extract user preferences/facts → save to MEMORY.md/USER.md
 * 2. Detect reusable workflows → create/update skills
 *
 * The review is NOT a separate agent — it's a single generateText call
 * with a structured prompt + tool-use simulation via JSON output.
 */

// ───────────────────────── Config ─────────────────────────

export const REVIEW_INTERVAL = 10; // every N turns
export const MIN_TURNS_BEFORE_REVIEW = 6; // minimum turns before first review

// ───────────────────────── Review Prompts (from hermes-agent) ─────────────────────────

function buildMemoryReviewPrompt(memoryState: MemoryState): string {
  return `Review the conversation above and consider saving to memory if appropriate.

${formatMemoryState(memoryState)}

TWO TARGETS — choose carefully:
- "user": who the user is — name, role, timezone, preferences, communication style, pet peeves, personal details
- "memory": your notes — environment facts, project conventions, tool quirks, lessons learned, workflow decisions

WHAT TO SAVE:
1. User corrected you or said "remember this" / "don't do that again" → save the correction
2. User shared a preference, habit, or personal detail (name, role, location) → save to "user"
3. You discovered an environment fact, convention, or API quirk → save to "memory"
4. A stable fact was established that will matter in future sessions → save to appropriate target

PRIORITY: User preferences and corrections > environment facts > procedural knowledge.
The most valuable memory prevents the user from having to repeat themselves.

SKIP: task progress, session outcomes, things easily re-discovered, raw data dumps, temporary state.
SKIP personality traits: Do NOT save anything about the agent's current personality, persona, speaking style, character name, or role-play traits (e.g. "speaks like a pirate", "calls itself Captain X", "uses nautical terms"). These come from a switchable preset and must NOT leak into permanent memory.

${memoryCompactionRules(memoryState)}

Respond with a JSON object:
{
  "memory_updates": [
    { "target": "memory" | "user", "action": "${memoryState.memoryPct >= COMPACT_THRESHOLD || memoryState.userPct >= COMPACT_THRESHOLD ? "add | compact" : "add"}", "content": "..." }
  ]
}

If nothing is worth saving, respond with: { "memory_updates": [] }
Only save genuinely useful information. No fluff.`;
}

const SKILL_REVIEW_PROMPT = `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings, or did the user expect or desire a different method or outcome?

Respond with a JSON object:
{
  "skill_actions": [
    {
      "action": "create" | "update",
      "name": "skill-name",
      "description": "one-line description",
      "content": "Full skill content with steps, pitfalls, verification",
      "category": "optional category"
    }
  ]
}

If nothing is worth saving, respond with: { "skill_actions": [] }
Only save if the approach is genuinely reusable. Skip simple one-offs.`;

// ───────────────────────── Memory State Helpers ─────────────────────────

interface MemoryState {
  memoryContent: string;
  memoryPct: number;
  userContent: string;
  userPct: number;
}

function getMemoryState(sql: SqlFn): MemoryState {
  const memoryContent = getPromptMemory(sql, "memory");
  const userContent = getPromptMemory(sql, "user");
  return {
    memoryContent,
    memoryPct: MEMORY_CHAR_LIMIT > 0 ? Math.round((memoryContent.length / MEMORY_CHAR_LIMIT) * 100) : 0,
    userContent,
    userPct: USER_CHAR_LIMIT > 0 ? Math.round((userContent.length / USER_CHAR_LIMIT) * 100) : 0,
  };
}

function formatMemoryState(s: MemoryState): string {
  const parts: string[] = [];
  if (s.memoryContent) {
    parts.push(`Current MEMORY.md (${s.memoryPct}% of ${MEMORY_CHAR_LIMIT} chars):\n${s.memoryContent}`);
  } else {
    parts.push(`Current MEMORY.md: (empty)`);
  }
  if (s.userContent) {
    parts.push(`Current USER.md (${s.userPct}% of ${USER_CHAR_LIMIT} chars):\n${s.userContent}`);
  } else {
    parts.push(`Current USER.md: (empty)`);
  }
  return parts.join("\n\n");
}

const COMPACT_THRESHOLD = 80; // percent

function memoryCompactionRules(s: MemoryState): string {
  const needsCompact = s.memoryPct >= COMPACT_THRESHOLD || s.userPct >= COMPACT_THRESHOLD;
  if (!needsCompact) return "";

  const targets: string[] = [];
  if (s.memoryPct >= COMPACT_THRESHOLD) targets.push(`"memory" (${s.memoryPct}% full)`);
  if (s.userPct >= COMPACT_THRESHOLD) targets.push(`"user" (${s.userPct}% full)`);

  return `IMPORTANT: ${targets.join(" and ")} is near capacity. You can use action "compact" instead of "add":
- "compact": produce the FULL updated content for that target, merging new facts in while compacting existing ones
- Merge duplicate or closely related facts into single entries
- Remove facts clearly contradicted or superseded by the conversation
- Keep all still-relevant facts — do NOT drop useful information
- The compacted content MUST fit within the char limit`;
}

function buildCombinedReviewPrompt(memoryState: MemoryState): string {
  return `Review the conversation above and consider two things:

${formatMemoryState(memoryState)}

**Memory** (two targets — choose carefully):
- "user": who the user is — name, role, timezone, preferences, communication style, pet peeves, personal details
- "memory": your notes — environment facts, project conventions, tool quirks, lessons learned
Save when: user corrects you, shares preferences/personal details (→ "user"), or you discover environment facts/conventions (→ "memory"). Skip task progress, temporary state, things easily re-discovered. The most valuable memory prevents the user from having to repeat themselves.
NEVER save personality/persona traits: speaking style, character names, role-play behavior, catchphrases — these come from a switchable preset and must NOT be stored as permanent facts.

**Skills**: Was a non-trivial approach used that required trial and error, experiential findings, or course corrections? If a relevant skill already exists, update it. Otherwise, create a new one if reusable.

${memoryCompactionRules(memoryState)}

Respond with a JSON object:
{
  "memory_updates": [
    { "target": "memory" | "user", "action": "${memoryState.memoryPct >= COMPACT_THRESHOLD || memoryState.userPct >= COMPACT_THRESHOLD ? "add | compact" : "add"}", "content": "..." }
  ],
  "skill_actions": [
    {
      "action": "create" | "update",
      "name": "skill-name",
      "description": "one-line description",
      "content": "...",
      "category": "optional"
    }
  ]
}

Only act if there's something genuinely worth saving. If nothing stands out, respond with: { "memory_updates": [], "skill_actions": [] }`;
}

// ───────────────────────── Review Execution ─────────────────────────

interface ReviewResult {
  memoryActions: number;
  skillActions: number;
  errors: string[];
  tokensIn: number;
  tokensOut: number;
}

/**
 * Run a background self-learning review.
 * Called after every REVIEW_INTERVAL turns.
 *
 * The caller provides a pre-built `model` (from createAuxiliaryModel) so that
 * BYOK users review against their own provider, never against Workers AI.
 */
export async function runSelfLearningReview(
  conversationSummary: string,
  sql: SqlFn,
  model: LanguageModel,
  r2Memories: R2Bucket,
  r2Skills: R2Bucket,
  userId: string,
  options: { reviewMemory: boolean; reviewSkills: boolean }
): Promise<ReviewResult> {
  const result: ReviewResult = { memoryActions: 0, skillActions: 0, errors: [], tokensIn: 0, tokensOut: 0 };

  // Load current memory state for context-aware prompting
  const memoryState = getMemoryState(sql);

  // Choose prompt
  let prompt: string;
  if (options.reviewMemory && options.reviewSkills) {
    prompt = buildCombinedReviewPrompt(memoryState);
  } else if (options.reviewMemory) {
    prompt = buildMemoryReviewPrompt(memoryState);
  } else {
    prompt = SKILL_REVIEW_PROMPT;
  }

  try {
    const response = await generateText({
      model,
      system: "You are a self-learning review agent. Analyze the conversation and output JSON only.",
      prompt: `Conversation to review:\n\n${conversationSummary}\n\n---\n\n${prompt}`,
      maxRetries: 1,
    });

    result.tokensIn = response.usage?.inputTokens ?? 0;
    result.tokensOut = response.usage?.outputTokens ?? 0;

    // Parse JSON response
    const text = response.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return result; // No valid JSON — nothing to save
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      memory_updates?: Array<{ target: string; action: string; content: string }>;
      skill_actions?: Array<{
        action: string;
        name: string;
        description?: string;
        content?: string;
        category?: string;
      }>;
    };

    // Apply memory updates
    if (parsed.memory_updates) {
      for (const update of parsed.memory_updates) {
        if (!update.content || update.content.length < 5) continue;
        const target = (update.target === "user" ? "user" : "memory") as "memory" | "user";

        let writeResult;
        if (update.action === "compact") {
          // Full replacement — model produced a compacted version of the entire memory
          const current = getPromptMemory(sql, target);
          writeResult = await updatePromptMemory(
            sql, r2Memories, userId, target, "replace", update.content, current
          );
          if (writeResult.ok) {
            logAudit(sql, "memory.compact", `self-learning: ${target} — compacted to ${update.content.length} chars`);
          }
        } else {
          // Default: append
          writeResult = await updatePromptMemory(
            sql, r2Memories, userId, target, "add", update.content
          );
          if (writeResult.ok) {
            logAudit(sql, "memory.write", `self-learning: ${target} — ${update.content.slice(0, 80)}`);
          }
        }

        if (writeResult.ok) {
          result.memoryActions++;
        } else if (writeResult.error) {
          result.errors.push(writeResult.error);
        }
      }
    }

    // Apply skill actions
    if (parsed.skill_actions) {
      for (const action of parsed.skill_actions) {
        if (!action.name || !action.content) continue;

        if (action.action === "create") {
          const createResult = await createSkill(
            sql, r2Skills, userId, action.name, action.content,
            { description: action.description, category: action.category }
          );
          if (createResult.ok) {
            result.skillActions++;
            logAudit(sql, "skill.create", `self-learning: ${action.name}`);
          } else if (createResult.error) {
            // If skill exists, try to update instead
            if (createResult.error.includes("already exists")) {
              const editResult = await editSkill(
                sql, r2Skills, userId, action.name, action.content,
                { description: action.description, category: action.category }
              );
              if (editResult.ok) {
                result.skillActions++;
                logAudit(sql, "skill.edit", `self-learning: ${action.name}`);
              }
            } else {
              result.errors.push(createResult.error);
            }
          }
        } else if (action.action === "update") {
          // Exact match first, then fall back to fuzzy search
          const exact = sql<{ name: string }>`SELECT name FROM skills WHERE name = ${action.name}`;
          const targetName = exact.length > 0
            ? exact[0].name
            : searchSkills(sql, action.name)[0]?.name;
          if (targetName) {
            const editResult = await editSkill(
              sql, r2Skills, userId, targetName, action.content,
              { description: action.description, category: action.category }
            );
            if (editResult.ok) {
              result.skillActions++;
              logAudit(sql, "skill.edit", `self-learning: ${targetName}`);
            }
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/**
 * Build a conversation summary from recent messages for the review.
 * Keeps it concise to stay within model limits.
 */
export function buildConversationSummary(
  messages: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>
): string {
  const lines: string[] = [];
  for (const msg of messages.slice(-20)) { // last 20 messages max
    const role = msg.role;
    const text = (msg.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (text) {
      lines.push(`[${role}]: ${text.slice(0, 500)}`);
    }
  }
  return lines.join("\n\n");
}
