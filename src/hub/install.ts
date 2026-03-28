import type { SqlFn } from "../config/sql.js";
import type { HubSkillBundle, HubInstallResult } from "./types.js";
import type { HubInstalledEntry } from "../config/types.js";
import { createSkill, editSkill } from "../memory/skills.js";
import { logAudit } from "../enterprise/audit.js";

/**
 * Install a skill from the hub into the user's agent.
 * 1. Scan content for threats
 * 2. Write to SQLite skills table + R2
 * 3. Record in hub_installed table
 */
export async function installSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  bundle: HubSkillBundle
): Promise<HubInstallResult> {
  // Hub-specific security scan (scanForThreats is already called inside createSkill/editSkill)
  const hubThreat = scanHubContent(bundle.content);
  if (hubThreat) {
    return { ok: false, error: `Blocked by hub security: ${hubThreat}` };
  }

  const name = bundle.meta.name;

  // Check if already installed from hub
  const existing = sql<{ name: string }>`SELECT name FROM hub_installed WHERE name = ${name}`;
  const skillExists = sql<{ name: string }>`SELECT name FROM skills WHERE name = ${name}`;

  // If skill exists but not from hub, refuse (don't overwrite user-created skills)
  if (skillExists.length > 0 && existing.length === 0) {
    return { ok: false, error: `Skill "${name}" already exists (created manually). Delete it first or use a different name.` };
  }

  // Create or update the skill
  const meta = {
    category: bundle.meta.tags?.[0],
    description: bundle.meta.description,
  };

  let result: { ok: boolean; error?: string };
  if (skillExists.length > 0) {
    result = await editSkill(sql, r2, userId, name, bundle.content, meta);
  } else {
    result = await createSkill(sql, r2, userId, name, bundle.content, meta);
  }

  if (!result.ok) return { ok: false, error: result.error };

  // Record in hub_installed
  const contentHash = await hashContent(bundle.content);
  const metadata = JSON.stringify({
    author: bundle.meta.author,
    license: bundle.meta.license,
    tags: bundle.meta.tags,
  });

  if (existing.length > 0) {
    sql`UPDATE hub_installed SET
      source = ${bundle.meta.source},
      identifier = ${bundle.meta.identifier},
      trust_level = ${bundle.meta.trustLevel},
      content_hash = ${contentHash},
      updated_at = datetime('now'),
      metadata = ${metadata}
    WHERE name = ${name}`;
  } else {
    sql`INSERT INTO hub_installed (name, source, identifier, trust_level, content_hash, metadata)
      VALUES (${name}, ${bundle.meta.source}, ${bundle.meta.identifier},
              ${bundle.meta.trustLevel}, ${contentHash}, ${metadata})`;
  }

  logAudit(sql, "hub.install", `${bundle.meta.source}:${bundle.meta.identifier}`);
  return { ok: true, name };
}

/**
 * Uninstall a hub-installed skill.
 */
export async function uninstallSkill(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const installed = sql<{ name: string }>`SELECT name FROM hub_installed WHERE name = ${name}`;
  if (installed.length === 0) {
    return { ok: false, error: `"${name}" is not a hub-installed skill` };
  }

  const { deleteSkill } = await import("../memory/skills.js");
  await deleteSkill(sql, r2, userId, name);
  sql`DELETE FROM hub_installed WHERE name = ${name}`;
  logAudit(sql, "hub.uninstall", name);

  return { ok: true };
}

/**
 * List hub-installed skills.
 */
export function listInstalled(sql: SqlFn): HubInstalledEntry[] {
  return sql<HubInstalledEntry>`
    SELECT name, source, identifier, trust_level as trustLevel,
           content_hash as contentHash, installed_at as installedAt,
           updated_at as updatedAt, metadata
    FROM hub_installed ORDER BY name
  `;
}

// ───────────────────────── Frontmatter parsing ─────────────────────────

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2].trim();

  // Simple YAML parser (key: value, one per line)
  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      const [, key, value] = kv;
      // Handle arrays: [item1, item2]
      if (value.startsWith("[") && value.endsWith("]")) {
        frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim());
      } else {
        frontmatter[key] = value.trim();
      }
    }
  }

  return { frontmatter, body };
}

// ───────────────────────── Hub-specific security ─────────────────────────

/**
 * Extended security scan for hub-installed skills.
 * Checks for patterns that are dangerous in skill instructions.
 */
function scanHubContent(content: string): string | null {
  const patterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /override\s+(the\s+)?system/i, label: "attempts to override system prompt" },
    { pattern: /forget\s+(all|everything|your)/i, label: "attempts to reset agent memory" },
    { pattern: /new\s+instructions?\s*:/i, label: "attempts to inject new instructions" },
    { pattern: /https?:\/\/[^\s]*\.(exe|bat|sh|ps1|cmd)\b/i, label: "links to executable files" },
    { pattern: /eval\s*\(|Function\s*\(/i, label: "contains code execution patterns" },
  ];

  for (const { pattern, label } of patterns) {
    if (pattern.test(content)) return label;
  }

  return null;
}

// ───────────────────────── Daily Update Check ─────────────────────────

export interface SkillUpdateResult {
  checked: number;
  updated: number;
  errors: string[];
}

/**
 * Check all hub-installed GitHub skills for updates.
 * Compares stored content_hash with current GitHub content.
 * Only updates skills whose source is "github".
 */
export async function checkSkillUpdates(
  sql: SqlFn,
  r2: R2Bucket,
  userId: string,
): Promise<SkillUpdateResult> {
  const result: SkillUpdateResult = { checked: 0, updated: 0, errors: [] };

  const installed = sql<{ name: string; source: string; identifier: string; content_hash: string | null }>`
    SELECT name, source, identifier, content_hash FROM hub_installed WHERE source = 'github'
  `;
  if (installed.length === 0) return result;

  const { GitHubSource } = await import("./github-source.js");
  const gh = new GitHubSource();

  for (const skill of installed) {
    result.checked++;
    try {
      const bundle = await gh.fetch(skill.identifier);
      if (!bundle) continue;

      const newHash = await hashContent(bundle.content);
      if (newHash === skill.content_hash) continue;

      // Content changed — re-install (reuses the full install flow with security scans)
      const installResult = await installSkill(sql, r2, userId, bundle);
      if (installResult.ok) {
        result.updated++;
        logAudit(sql, "hub.auto-update", `${skill.name} (hash changed)`);
      } else if (installResult.error) {
        result.errors.push(`${skill.name}: ${installResult.error}`);
      }
    } catch (err) {
      result.errors.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ───────────────────────── Helpers ─────────────────────────

async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
