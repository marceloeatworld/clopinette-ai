import { scanForThreats } from "./security.js";

import type { SqlFn } from "../config/sql.js";

/**
 * Layer 4: Skills Store — R2 for .md content, SQLite for metadata index.
 *
 * Skills use the agentskills.io format:
 * ---
 * name: skill-name
 * category: category
 * description: one-line description
 * trigger: when to activate
 * platforms: [all]
 * ---
 * Content...
 */

export interface SkillMeta {
  name: string;
  category: string | null;
  description: string | null;
  triggerPattern: string | null;
  platforms: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillFull extends SkillMeta {
  content: string;
}

// ───────────────────────── Read ─────────────────────────

export function listSkills(sql: SqlFn, category?: string): SkillMeta[] {
  if (category) {
    return sql<SkillMeta>`
      SELECT name, category, description, trigger_pattern as triggerPattern,
             platforms, created_at as createdAt, updated_at as updatedAt
      FROM skills WHERE category = ${category}
      ORDER BY name
    `;
  }
  return sql<SkillMeta>`
    SELECT name, category, description, trigger_pattern as triggerPattern,
           platforms, created_at as createdAt, updated_at as updatedAt
    FROM skills ORDER BY name
  `;
}

export function searchSkills(sql: SqlFn, query: string): SkillMeta[] {
  const pattern = `%${query}%`;
  return sql<SkillMeta>`
    SELECT name, category, description, trigger_pattern as triggerPattern,
           platforms, created_at as createdAt, updated_at as updatedAt
    FROM skills
    WHERE name LIKE ${pattern}
       OR description LIKE ${pattern}
       OR trigger_pattern LIKE ${pattern}
       OR category LIKE ${pattern}
    ORDER BY name
  `;
}

export async function getSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string
): Promise<SkillFull | null> {
  const rows = sql<SkillMeta>`
    SELECT name, category, description, trigger_pattern as triggerPattern,
           platforms, created_at as createdAt, updated_at as updatedAt
    FROM skills WHERE name = ${name}
  `;
  if (rows.length === 0) return null;

  const obj = await r2.get(r2SkillPath(userId, name));
  const content = obj ? await obj.text() : "";

  return { ...rows[0], content };
}

/**
 * Compact index for prompt assembly — names + triggers only.
 */
export function getSkillsIndex(sql: SqlFn): string {
  const rows = sql<{ name: string; trigger_pattern: string | null; description: string | null }>`
    SELECT name, trigger_pattern, description FROM skills ORDER BY name
  `;
  if (rows.length === 0) return "";

  const lines = rows.map((r) => {
    const trigger = r.trigger_pattern ? ` [trigger: ${r.trigger_pattern}]` : "";
    const desc = r.description ? ` — ${r.description}` : "";
    return `- ${r.name}${desc}${trigger}`;
  });
  return `## Available Skills (${rows.length})\n${lines.join("\n")}`;
}

// ───────────────────────── Write ─────────────────────────

export interface SkillWriteResult {
  ok: boolean;
  error?: string;
}

export async function createSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string,
  content: string,
  meta: { category?: string; description?: string; triggerPattern?: string; platforms?: string }
): Promise<SkillWriteResult> {
  if (!name || name.length > 100 || !/[a-zA-Z0-9]/.test(name)) {
    return { ok: false, error: "Skill name must be 1-100 chars and contain at least one alphanumeric character" };
  }
  const threat = scanForThreats(content);
  if (threat) return { ok: false, error: `Blocked: ${threat}` };

  // Check if exists
  const existing = sql`SELECT name FROM skills WHERE name = ${name}`;
  if (existing.length > 0) return { ok: false, error: `Skill "${name}" already exists` };

  sql`INSERT INTO skills (name, category, description, trigger_pattern, platforms)
      VALUES (${name}, ${meta.category ?? null}, ${meta.description ?? null},
              ${meta.triggerPattern ?? null}, ${meta.platforms ?? null})`;

  const fullContent = buildSkillFile(name, content, meta);
  await r2.put(r2SkillPath(userId, name), fullContent);

  return { ok: true };
}

export async function editSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string,
  content: string,
  meta?: { category?: string; description?: string; triggerPattern?: string; platforms?: string }
): Promise<SkillWriteResult> {
  const threat = scanForThreats(content);
  if (threat) return { ok: false, error: `Blocked: ${threat}` };

  const existing = sql`SELECT name FROM skills WHERE name = ${name}`;
  if (existing.length === 0) return { ok: false, error: `Skill "${name}" not found` };

  if (meta) {
    if (meta.category !== undefined)
      sql`UPDATE skills SET category = ${meta.category}, updated_at = datetime('now') WHERE name = ${name}`;
    if (meta.description !== undefined)
      sql`UPDATE skills SET description = ${meta.description}, updated_at = datetime('now') WHERE name = ${name}`;
    if (meta.triggerPattern !== undefined)
      sql`UPDATE skills SET trigger_pattern = ${meta.triggerPattern}, updated_at = datetime('now') WHERE name = ${name}`;
    if (meta.platforms !== undefined)
      sql`UPDATE skills SET platforms = ${meta.platforms}, updated_at = datetime('now') WHERE name = ${name}`;
  }

  const fullContent = buildSkillFile(name, content, meta);
  await r2.put(r2SkillPath(userId, name), fullContent);

  return { ok: true };
}

export async function patchSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string,
  find: string,
  replace: string
): Promise<SkillWriteResult> {
  const threat = scanForThreats(replace);
  if (threat) return { ok: false, error: `Blocked: ${threat}` };

  const obj = await r2.get(r2SkillPath(userId, name));
  if (!obj) return { ok: false, error: `Skill "${name}" not found in R2` };

  const current = await obj.text();
  if (!current.includes(find)) {
    return { ok: false, error: "find string not found in skill content" };
  }

  const updated = current.replaceAll(find, replace);
  await r2.put(r2SkillPath(userId, name), updated);

  sql`UPDATE skills SET updated_at = datetime('now') WHERE name = ${name}`;

  return { ok: true };
}

export async function deleteSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string
): Promise<SkillWriteResult> {
  const existing = sql`SELECT name FROM skills WHERE name = ${name}`;
  if (existing.length === 0) return { ok: false, error: `Skill "${name}" not found` };

  sql`DELETE FROM skills WHERE name = ${name}`;
  await r2.delete(r2SkillPath(userId, name));
  return { ok: true };
}

// ───────────────────────── Helpers ─────────────────────────

function r2SkillPath(userId: string, name: string): string {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${safeUserId}/skills/${safeName}.md`;
}

/** Escape a YAML value — wrap in quotes if it contains special chars or newlines. */
function yamlEscape(val: string): string {
  if (/[\n:{}[\],&*?|>!'"%@`#]/.test(val) || val.trim() !== val) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return val;
}

function buildSkillFile(
  name: string,
  content: string,
  meta?: { category?: string; description?: string; triggerPattern?: string; platforms?: string }
): string {
  const frontmatter = [
    "---",
    `name: ${yamlEscape(name)}`,
    meta?.category ? `category: ${yamlEscape(meta.category)}` : null,
    meta?.description ? `description: ${yamlEscape(meta.description)}` : null,
    meta?.triggerPattern ? `trigger: ${yamlEscape(meta.triggerPattern)}` : null,
    meta?.platforms ? `platforms: ${meta.platforms}` : "platforms: [all]",
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  return `${frontmatter}\n\n${content}`;
}
