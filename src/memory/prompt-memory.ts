import type { PromptMemoryRow } from "../config/types.js";
import { MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT } from "../config/constants.js";
import { scanForThreats } from "./security.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Layer 1: Prompt Memory — MEMORY.md and USER.md
 *
 * Stored in DO SQLite `prompt_memory` table.
 * Backed up to R2 on every write.
 * Frozen at session start (reads return snapshot, writes take effect next session).
 */

export function getPromptMemory(
  sql: SqlFn,
  type: "memory" | "user"
): string {
  const rows = sql<PromptMemoryRow>`
    SELECT content FROM prompt_memory WHERE type = ${type}
  `;
  return rows[0]?.content ?? "";
}

export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
  content: string;
  usage?: string;
}

export async function updatePromptMemory(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  type: "memory" | "user",
  operation: "add" | "replace" | "remove",
  value: string,
  target?: string
): Promise<MemoryWriteResult> {
  // Security scan
  if (operation !== "remove") {
    const threat = scanForThreats(value);
    if (threat) {
      return { ok: false, error: `Blocked: ${threat}`, content: "" };
    }
  }

  const current = getPromptMemory(sql, type);
  const limit = type === "memory" ? MEMORY_CHAR_LIMIT : USER_CHAR_LIMIT;
  const usageStr = (content: string) => {
    const pct = limit > 0 ? Math.round((content.length / limit) * 100) : 0;
    return `${pct}% — ${content.length.toLocaleString()}/${limit.toLocaleString()} chars`;
  };
  let updated: string;

  switch (operation) {
    case "add": {
      // Duplicate detection
      if (current.includes(value.trim())) {
        return { ok: true, content: current, usage: usageStr(current) };
      }
      const separator = current ? "\n" : "";
      updated = current + separator + value;
      break;
    }
    case "replace": {
      if (!target) {
        return { ok: false, error: "replace requires a target string", content: current };
      }
      if (!current.includes(target)) {
        return { ok: false, error: "target string not found in memory", content: current };
      }
      updated = current.replace(target, value);
      break;
    }
    case "remove": {
      if (!target && !value) {
        return { ok: false, error: "remove requires a value or target", content: current };
      }
      const toRemove = target ?? value;
      if (!current.includes(toRemove)) {
        return { ok: false, error: "string not found in memory", content: current };
      }
      updated = current
        .replace(toRemove, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      break;
    }
  }

  // Enforce char limit
  if (updated.length > limit) {
    return {
      ok: false,
      error: `Memory at ${usageStr(current)}. Adding ${value.length} chars would exceed the limit. Replace or remove existing entries first.`,
      content: current,
      usage: usageStr(current),
    };
  }

  // Write to SQLite
  sql`UPDATE prompt_memory SET content = ${updated}, updated_at = datetime('now')
      WHERE type = ${type}`;

  // Backup to R2 (sanitize userId to prevent path traversal)
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const r2Path = `${safeUserId}/${type === "memory" ? "MEMORY" : "USER"}.md`;
  await r2.put(r2Path, updated);

  return { ok: true, content: updated, usage: usageStr(updated) };
}
