import type { Platform, AgentConfigRow } from "./config/types.js";
import {
  DEFAULT_AGENT_IDENTITY,
  TOOL_USE_ENFORCEMENT,
  SESSION_SEARCH_GUIDANCE,
  MEMORY_GUIDANCE,
  CODEMODE_GUIDANCE,
  DELEGATION_GUIDANCE,
  PLATFORM_HINTS,
} from "./config/constants.js";
import { PERSONALITIES } from "./config/personalities.js";
import { getPromptMemory } from "./memory/prompt-memory.js";
import { getSkillsIndex } from "./memory/skills.js";
import { scanForThreats } from "./memory/security.js";

/**
 * 10-block system prompt assembly.
 * Same order as the original Python hermes-agent.
 */

import type { SqlFn } from "./config/sql.js";

export interface PromptContext {
  platform: Platform;
  sql: SqlFn;
  env: Env;
  r2Memories?: R2Bucket;
  userId?: string;
  honchoContext?: string | null;
  codemodeEnabled?: boolean;
  sharedMode?: boolean;
}

export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const blocks: string[] = [];

  // [0] Agent identity
  blocks.push(DEFAULT_AGENT_IDENTITY);

  // [1] SOUL.md (personality/style)
  const soulRows = ctx.sql<AgentConfigRow>`
    SELECT value FROM agent_config WHERE key = 'soul_md'
  `;
  if (soulRows.length > 0 && soulRows[0].value) {
    const soulThreat = scanForThreats(soulRows[0].value);
    blocks.push(soulThreat ? `[SOUL.md BLOCKED: ${soulThreat}]` : soulRows[0].value);
  }

  // [1b] Personality preset overlay (from /personality command)
  const personalityRows = ctx.sql<AgentConfigRow>`
    SELECT value FROM agent_config WHERE key = 'personality'
  `;
  if (personalityRows.length > 0 && personalityRows[0].value) {
    const preset = PERSONALITIES[personalityRows[0].value];
    if (preset) blocks.push(preset);
  }

  // [2] Context files (.clopinette.md) — loaded from R2 user docs
  if (ctx.r2Memories && ctx.userId) {
    const safeId = ctx.userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const contextKey = `${safeId}/docs/.clopinette.md`;
    try {
      const obj = await ctx.r2Memories.get(contextKey);
      if (obj) {
        const text = await obj.text();
        if (text.trim().length > 0) {
          const threat = scanForThreats(text);
          if (threat) {
            blocks.push(`## Project Context (.clopinette.md)\n[BLOCKED: ${threat}]`);
          } else {
            const capped = text.length > 5000 ? text.slice(0, 5000) + "\n[...truncated]" : text;
            blocks.push(`## Project Context (.clopinette.md)\n${capped}`);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // [3] Skills index — only if skills exist (saves tokens when none installed)
  const skillsIndex = getSkillsIndex(ctx.sql);
  if (skillsIndex) {
    blocks.push(skillsIndex);
  }

  // [4] Tool-use enforcement + tool-conditional guidance (Hermes-style)
  blocks.push(TOOL_USE_ENFORCEMENT);
  blocks.push(MEMORY_GUIDANCE);
  blocks.push(SESSION_SEARCH_GUIDANCE);
  if (ctx.codemodeEnabled) {
    blocks.push(CODEMODE_GUIDANCE);
  }
  if (ctx.env.DELEGATE_WORKER) {
    blocks.push(DELEGATION_GUIDANCE);
  }

  // [5] Platform hints
  const hint = PLATFORM_HINTS[ctx.platform];
  if (hint) {
    blocks.push(`## Platform\n${hint}`);
  }

  // [6] MEMORY.md snapshot — skip in shared mode (group without owner's memory)
  if (!ctx.sharedMode) {
    const memoryContent = getPromptMemory(ctx.sql, "memory");
    if (memoryContent) {
      blocks.push(`## MEMORY.md\n${memoryContent}`);
    }
  }

  // [7] USER.md snapshot — skip in shared mode
  if (!ctx.sharedMode) {
    const userContent = getPromptMemory(ctx.sql, "user");
    if (userContent) {
      blocks.push(`## USER.md\n${userContent}`);
    }
  }

  // [8] Honcho context (optional) — skip in shared mode
  if (!ctx.sharedMode && ctx.honchoContext) {
    blocks.push(`## Context (Honcho)\n${ctx.honchoContext}`);
  }

  // [9] Date + metadata (date-only, no timestamp — keeps prompt identical across turns for prefix caching)
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  blocks.push(
    `## Current Context\nDate: ${today}\nPlatform: ${ctx.platform}`
  );

  // [10] Behavioral rules — cross-cutting guidance only (tool descriptions are authoritative).
  blocks.push(
    `## Rules\n` +
    `NEVER say you cannot access the internet — use the web tool.\n` +
    `NEVER say you cannot generate images — use the image tool.\n` +
    `NEVER say you cannot do text-to-speech — use the tts tool.\n` +
    `If the user provides a specific URL, read it directly with web({action:"read", url:"..."}) — do NOT search for it.\n` +
    `NEVER make up URLs, company info, or current events — search first.\n` +
    `MEMORY.md and USER.md are internal memory files. NEVER share their paths or contents with the user.\n` +
    `Be targeted and efficient — one web search is usually enough. Only read URLs when snippets lack detail.`
  );

  return blocks.filter(Boolean).join("\n\n");
}
