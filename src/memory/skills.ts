import { scanForThreats } from "./security.js";

import type { SqlFn } from "../config/sql.js";
import type { Platform } from "../config/types.js";

/**
 * Layer 4: Skills Store — R2 for `SKILL.md` content, SQLite for compact metadata.
 *
 * The runtime keeps the prompt cheap by indexing only compact metadata in SQLite
 * while storing the full markdown document in R2.
 */

const FRONTMATTER_BOUNDARY = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const TOP_LEVEL_KEY = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const SUPPORTED_FRONTMATTER_KEYS = new Set([
  "name",
  "category",
  "description",
  "trigger",
  "triggerPattern",
  "platforms",
]);

export interface SkillFrontmatter {
  name?: string;
  category?: string;
  description?: string;
  trigger?: string;
  triggerPattern?: string;
  platforms?: string[];
}

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
  body: string;
  frontmatter: SkillFrontmatter;
}

interface ParsedSkillDocument {
  hasFrontmatter: boolean;
  frontmatter: SkillFrontmatter;
  body: string;
  rawFrontmatter: string | null;
}

interface ResolvedSkillMeta {
  name: string;
  category: string | null;
  description: string | null;
  triggerPattern: string | null;
  platforms: string[];
}

interface SkillWriteMeta {
  category?: string;
  description?: string;
  triggerPattern?: string;
  platforms?: string;
}

// ───────────────────────── Read ─────────────────────────

export function listSkills(sql: SqlFn, category?: string, platform?: Platform): SkillMeta[] {
  const rows = category
    ? sql<SkillMeta>`
        SELECT name, category, description, trigger_pattern as triggerPattern,
               platforms, created_at as createdAt, updated_at as updatedAt
        FROM skills WHERE category = ${category}
        ORDER BY name
      `
    : sql<SkillMeta>`
        SELECT name, category, description, trigger_pattern as triggerPattern,
               platforms, created_at as createdAt, updated_at as updatedAt
        FROM skills ORDER BY name
      `;
  return filterSkillsByPlatform(rows, platform);
}

export function searchSkills(sql: SqlFn, query: string, platform?: Platform): SkillMeta[] {
  const pattern = `%${query}%`;
  const rows = sql<SkillMeta>`
    SELECT name, category, description, trigger_pattern as triggerPattern,
           platforms, created_at as createdAt, updated_at as updatedAt
    FROM skills
    WHERE name LIKE ${pattern}
       OR description LIKE ${pattern}
       OR trigger_pattern LIKE ${pattern}
       OR category LIKE ${pattern}
    ORDER BY name
  `;
  return filterSkillsByPlatform(rows, platform);
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
  const parsed = parseSkillDocument(content);

  return {
    ...rows[0],
    content,
    body: parsed.body,
    frontmatter: {
      name,
      category: rows[0].category ?? parsed.frontmatter.category,
      description: rows[0].description ?? parsed.frontmatter.description,
      trigger: rows[0].triggerPattern ?? parsed.frontmatter.trigger,
      triggerPattern: rows[0].triggerPattern ?? parsed.frontmatter.triggerPattern,
      platforms: normalizePlatforms(rows[0].platforms ?? parsed.frontmatter.platforms),
    },
  };
}

/**
 * Compact prompt index — grouped by category and filtered by platform.
 */
export function getSkillsIndex(sql: SqlFn, platform?: Platform): string {
  const rows = listSkills(sql, undefined, platform);
  if (rows.length === 0) return "";

  const grouped = new Map<string, Array<{ name: string; description: string | null; triggerPattern: string | null }>>();
  for (const row of rows) {
    const category = row.category?.trim() || "general";
    const bucket = grouped.get(category) ?? [];
    bucket.push({
      name: row.name,
      description: row.description,
      triggerPattern: row.triggerPattern,
    });
    grouped.set(category, bucket);
  }

  const lines = [
    `## Skills Index (${rows.length})`,
    `Load a skill only when it clearly matches the task. Use the skills tool to view the full SKILL.md before following it.`,
  ];

  for (const category of Array.from(grouped.keys()).sort()) {
    lines.push(`### ${category}`);
    const entries = grouped.get(category) ?? [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = entry.description ? ` — ${truncate(entry.description, 120)}` : "";
      const trigger = entry.triggerPattern ? ` [trigger: ${truncate(entry.triggerPattern, 80)}]` : "";
      lines.push(`- ${entry.name}${desc}${trigger}`);
    }
  }

  return lines.join("\n");
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
  meta: SkillWriteMeta = {}
): Promise<SkillWriteResult> {
  if (!name || name.length > 100 || !/[a-zA-Z0-9]/.test(name)) {
    return { ok: false, error: "Skill name must be 1-100 chars and contain at least one alphanumeric character" };
  }

  const existing = sql`SELECT name FROM skills WHERE name = ${name}`;
  if (existing.length > 0) return { ok: false, error: `Skill "${name}" already exists` };

  const materialized = materializeSkillDocument(name, content, meta);
  if (!materialized.body.trim()) {
    return { ok: false, error: "Skill content must include instructions after the frontmatter" };
  }

  const threat = scanForThreats(materialized.content);
  if (threat) return { ok: false, error: `Blocked: ${threat}` };

  const persisted = resolveSkillMeta(name, materialized.frontmatter, materialized.body, meta);
  insertSkillRow(sql, persisted);
  await r2.put(r2SkillPath(userId, name), materialized.content);

  return { ok: true };
}

export async function editSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string,
  content: string,
  meta: SkillWriteMeta = {}
): Promise<SkillWriteResult> {
  const existing = sql`SELECT name FROM skills WHERE name = ${name}`;
  if (existing.length === 0) return { ok: false, error: `Skill "${name}" not found` };

  const materialized = materializeSkillDocument(name, content, meta);
  if (!materialized.body.trim()) {
    return { ok: false, error: "Skill content must include instructions after the frontmatter" };
  }

  const threat = scanForThreats(materialized.content);
  if (threat) return { ok: false, error: `Blocked: ${threat}` };

  const persisted = resolveSkillMeta(name, materialized.frontmatter, materialized.body, meta);
  updateSkillRow(sql, name, persisted);
  await r2.put(r2SkillPath(userId, name), materialized.content);

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
  const materialized = materializeSkillDocument(name, updated, {});
  const persisted = resolveSkillMeta(name, materialized.frontmatter, materialized.body, {});
  updateSkillRow(sql, name, persisted);
  await r2.put(r2SkillPath(userId, name), materialized.content);

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

function filterSkillsByPlatform(rows: SkillMeta[], platform?: Platform): SkillMeta[] {
  if (!platform) return rows;
  return rows.filter((row) => matchesPlatform(row.platforms, platform));
}

function matchesPlatform(platformsValue: string | string[] | null | undefined, platform: Platform): boolean {
  const platforms = normalizePlatforms(platformsValue);
  return platforms.length === 0 || platforms.includes("all") || platforms.includes(platform);
}

function normalizePlatforms(value: string | string[] | null | undefined): string[] {
  if (!value) return ["all"];
  if (Array.isArray(value)) {
    const out = value.map((item) => item.trim()).filter(Boolean);
    return out.length > 0 ? out : ["all"];
  }

  const raw = value.trim();
  if (!raw) return ["all"];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const items = raw.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter(Boolean);
    return items.length > 0 ? items : ["all"];
  }
  if (raw.includes(",")) {
    const items = raw.split(",").map((item) => unquote(item.trim())).filter(Boolean);
    return items.length > 0 ? items : ["all"];
  }
  return [unquote(raw)];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function r2SkillPath(userId: string, name: string): string {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${safeUserId}/skills/${safeName}.md`;
}

function parseSkillDocument(content: string): ParsedSkillDocument {
  const trimmed = content.trim();
  const match = trimmed.match(FRONTMATTER_BOUNDARY);
  if (!match) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      body: trimmed,
      rawFrontmatter: null,
    };
  }

  return {
    hasFrontmatter: true,
    frontmatter: parseFrontmatterBlock(match[1]),
    body: match[2].trim(),
    rawFrontmatter: match[1],
  };
}

function parseFrontmatterBlock(block: string): SkillFrontmatter {
  const frontmatter: SkillFrontmatter = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(TOP_LEVEL_KEY);
    if (!match) continue;

    const [, key, restRaw] = match;
    if (!SUPPORTED_FRONTMATTER_KEYS.has(key)) continue;

    const rest = restRaw.trim();
    if ((key === "platforms") && !rest) {
      const platforms: string[] = [];
      let j = i + 1;
      while (j < lines.length && !TOP_LEVEL_KEY.test(lines[j])) {
        const listItem = lines[j].match(/^\s*-\s*(.+?)\s*$/);
        if (listItem) platforms.push(unquote(listItem[1]));
        j++;
      }
      if (platforms.length > 0) frontmatter.platforms = platforms;
      i = j - 1;
      continue;
    }

    if (key === "platforms") {
      frontmatter.platforms = normalizePlatforms(rest);
      continue;
    }

    const value = unquote(rest);
    if (key === "triggerPattern") frontmatter.triggerPattern = value;
    else if (key === "trigger") frontmatter.trigger = value;
    else if (key === "name") frontmatter.name = value;
    else if (key === "category") frontmatter.category = value;
    else if (key === "description") frontmatter.description = value;
  }

  return frontmatter;
}

function resolveSkillMeta(
  name: string,
  frontmatter: SkillFrontmatter,
  body: string,
  meta: SkillWriteMeta
): ResolvedSkillMeta {
  return {
    name,
    category: normalizeNullable(meta.category ?? frontmatter.category),
    description: normalizeNullable(meta.description ?? frontmatter.description ?? inferDescription(body)),
    triggerPattern: normalizeNullable(meta.triggerPattern ?? frontmatter.triggerPattern ?? frontmatter.trigger),
    platforms: normalizePlatforms(meta.platforms ?? frontmatter.platforms),
  };
}

function inferDescription(body: string): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return null;
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function materializeSkillDocument(
  name: string,
  content: string,
  meta: SkillWriteMeta
): { content: string; body: string; frontmatter: SkillFrontmatter } {
  const parsed = parseSkillDocument(content);
  const resolved = resolveSkillMeta(name, parsed.frontmatter, parsed.body, meta);

  if (parsed.hasFrontmatter) {
    return {
      content: rewriteFrontmatter(content.trim(), resolved),
      body: parsed.body,
      frontmatter: {
        name,
        category: resolved.category ?? undefined,
        description: resolved.description ?? undefined,
        trigger: resolved.triggerPattern ?? undefined,
        triggerPattern: resolved.triggerPattern ?? undefined,
        platforms: resolved.platforms,
      },
    };
  }

  return {
    content: buildSkillFile(resolved, parsed.body),
    body: parsed.body,
    frontmatter: {
      name,
      category: resolved.category ?? undefined,
      description: resolved.description ?? undefined,
      trigger: resolved.triggerPattern ?? undefined,
      triggerPattern: resolved.triggerPattern ?? undefined,
      platforms: resolved.platforms,
    },
  };
}

function rewriteFrontmatter(content: string, meta: ResolvedSkillMeta): string {
  const match = content.match(FRONTMATTER_BOUNDARY);
  if (!match) return buildSkillFile(meta, content.trim());

  const originalLines = match[1].split(/\r?\n/);
  const body = match[2].trim();
  const rewritten: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];
    const topLevel = line.match(TOP_LEVEL_KEY);
    const key = topLevel?.[1];

    if (key && SUPPORTED_FRONTMATTER_KEYS.has(key)) {
      rewritten.push(serializeFrontmatterLine(key, meta));
      seen.add(key);
      i++;
      while (i < originalLines.length && !TOP_LEVEL_KEY.test(originalLines[i])) i++;
      i--;
      continue;
    }

    rewritten.push(line);
  }

  for (const key of ["name", "category", "description", "trigger", "platforms"]) {
    if (!seen.has(key)) rewritten.push(serializeFrontmatterLine(key, meta));
  }

  return `---\n${rewritten.filter(Boolean).join("\n")}\n---\n\n${body}`;
}

function serializeFrontmatterLine(key: string, meta: ResolvedSkillMeta): string {
  switch (key) {
    case "name":
      return `name: ${yamlEscape(meta.name)}`;
    case "category":
      return meta.category ? `category: ${yamlEscape(meta.category)}` : "";
    case "description":
      return meta.description ? `description: ${yamlEscape(meta.description)}` : "";
    case "trigger":
    case "triggerPattern":
      return meta.triggerPattern ? `trigger: ${yamlEscape(meta.triggerPattern)}` : "";
    case "platforms":
      return `platforms: [${meta.platforms.join(", ")}]`;
    default:
      return "";
  }
}

function buildSkillFile(meta: ResolvedSkillMeta, body: string): string {
  const frontmatter = [
    "---",
    `name: ${yamlEscape(meta.name)}`,
    meta.category ? `category: ${yamlEscape(meta.category)}` : null,
    meta.description ? `description: ${yamlEscape(meta.description)}` : null,
    meta.triggerPattern ? `trigger: ${yamlEscape(meta.triggerPattern)}` : null,
    `platforms: [${meta.platforms.join(", ")}]`,
    "---",
  ].filter(Boolean).join("\n");

  return `${frontmatter}\n\n${body.trim()}`;
}

function insertSkillRow(sql: SqlFn, meta: ResolvedSkillMeta): void {
  sql`INSERT INTO skills (name, category, description, trigger_pattern, platforms)
      VALUES (${meta.name}, ${meta.category}, ${meta.description},
              ${meta.triggerPattern}, ${meta.platforms.join(",")})`;
}

function updateSkillRow(sql: SqlFn, name: string, meta: ResolvedSkillMeta): void {
  sql`UPDATE skills
      SET category = ${meta.category},
          description = ${meta.description},
          trigger_pattern = ${meta.triggerPattern},
          platforms = ${meta.platforms.join(",")},
          updated_at = datetime('now')
      WHERE name = ${name}`;
}

/** Escape a YAML value — wrap in quotes if it contains special chars or newlines. */
function yamlEscape(val: string): string {
  if (/[\n:{}[\],&*?|>!'"%@`#]/.test(val) || val.trim() !== val) {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return val;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
