import type { Platform, AgentConfigRow } from "./config/types.js";
import {
  DEFAULT_AGENT_IDENTITY,
  MEMORY_GUIDANCE,
  CODEMODE_GUIDANCE,
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

  // [3] Skills index (compact — names + triggers)
  const skillsIndex = getSkillsIndex(ctx.sql);
  if (skillsIndex) {
    blocks.push(skillsIndex);
  }

  // [4] Memory guidance + codemode
  blocks.push(MEMORY_GUIDANCE);
  if (ctx.codemodeEnabled) {
    blocks.push(CODEMODE_GUIDANCE);
  }

  // [5] Platform hints
  const hint = PLATFORM_HINTS[ctx.platform];
  if (hint) {
    blocks.push(`## Platform\n${hint}`);
  }

  // [6] MEMORY.md snapshot (frozen at session start)
  const memoryContent = getPromptMemory(ctx.sql, "memory");
  if (memoryContent) {
    blocks.push(`## MEMORY.md\n${memoryContent}`);
  }

  // [7] USER.md snapshot (frozen at session start)
  const userContent = getPromptMemory(ctx.sql, "user");
  if (userContent) {
    blocks.push(`## USER.md\n${userContent}`);
  }

  // [8] Honcho context (optional)
  if (ctx.honchoContext) {
    blocks.push(`## Context (Honcho)\n${ctx.honchoContext}`);
  }

  // [9] Date + metadata (date-only, no timestamp — keeps prompt identical across turns for prefix caching)
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  blocks.push(
    `## Current Context\nDate: ${today}\nPlatform: ${ctx.platform}`
  );

  // [10] Active tool guidance — AUTHORITATIVE list of available tools.
  // This block is last and overrides any stale tool references in SOUL.md.
  const hasWeb = !!(ctx.env.CF_ACCOUNT_ID);

  const activeTools: string[] = [
    "memory — read/write persistent notes (MEMORY.md for world facts, USER.md for user info).",
    "history — full-text search across past conversation messages.",
    "skills — load, create, or update reusable skill guides (.md files).",
    "calendar — add, list, update, or delete calendar events with optional reminders. USE THIS when the user mentions dates, events, flights, meetings, deadlines.",
    "notes — manage the user's personal notes: save, list, delete, edit, search. Call this FIRST (before any text response) when the user wants to save, note, remember, bookmark, or delete a note.",
    "todo — manage task lists.",
    "docs — search the user's uploaded documents (semantic + keyword, unified). Use 'ask' for AI answers with citations.",
    "image — generate images from text descriptions.",
    "tts — convert text to spoken audio.",
  ];
  if (hasWeb) activeTools.push(
    "web — all-in-one web tool: search, read URLs, extract data, scrape, list links, crawl sites. 100% Cloudflare-native.\n" +
    "  Use action 'search' for web lookups (weather, news, prices, facts).\n" +
    "  Use action 'read' to get a URL as markdown.\n" +
    "  Use action 'extract' for AI-powered structured data from a page."
  );
  blocks.push(
    `## Your active tools\n${activeTools.map(t => `- ${t}`).join("\n")}\n\n` +
    `## Web research guidance\n` +
    (hasWeb
      ? `You HAVE the web tool — use it directly for any web lookup.\n` +
        `For simple questions (weather, "what is X", prices), do ONE search — snippets are usually enough.\n` +
        `For complex questions, do ONE search, then read AT MOST 2 URLs if snippets lack detail.\n` +
        `BUDGET: aim for 1-3 web calls total per question. More than 4 is almost never needed.\n`
      : `Web tools are not configured.\n`) +
    `NEVER say you cannot access the internet — you CAN via the web tool.\n` +
    `NEVER make up URLs, company info, or current events — search first.\n\n` +
    `## Internal files — NEVER expose\n` +
    `MEMORY.md and USER.md are your internal memory files. NEVER share their paths, contents, or URLs with the user. They are NOT accessible via any URL.\n\n` +
    `## Efficiency\n` +
    `- Prefer fewer, better tool calls over many small ones.\n` +
    `- Search snippets often have enough info — only 'read' when you need details not in snippets.\n` +
    `- Do NOT fire multiple reads in parallel just to be thorough — 1-2 reads max.`
  );

  return blocks.filter(Boolean).join("\n\n");
}
