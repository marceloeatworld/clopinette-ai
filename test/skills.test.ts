import { describe, it, expect } from "vitest";
import {
  createSkill,
  getSkill,
  getSkillsIndex,
} from "../src/memory/skills.js";

import type { SqlFn } from "../src/config/sql.js";

interface StoredSkillRow {
  name: string;
  category: string | null;
  description: string | null;
  triggerPattern: string | null;
  platforms: string | null;
  createdAt: string;
  updatedAt: string;
}

function createFakeSql(): SqlFn {
  const rows = new Map<string, StoredSkillRow>();
  const now = "2026-04-15 12:00:00";

  return (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.join("?");

    if (query.includes("SELECT name FROM skills WHERE name =")) {
      const name = String(values[0]);
      return rows.has(name) ? [{ name }] as T[] : [];
    }

    if (query.includes("INSERT INTO skills")) {
      const [name, category, description, triggerPattern, platforms] = values as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      rows.set(name, {
        name,
        category,
        description,
        triggerPattern,
        platforms,
        createdAt: now,
        updatedAt: now,
      });
      return [];
    }

    if (query.includes("UPDATE skills")) {
      const [category, description, triggerPattern, platforms, name] = values as [
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ];
      const current = rows.get(name);
      if (current) {
        rows.set(name, {
          ...current,
          category,
          description,
          triggerPattern,
          platforms,
          updatedAt: now,
        });
      }
      return [];
    }

    if (query.includes("DELETE FROM skills WHERE name =")) {
      rows.delete(String(values[0]));
      return [];
    }

    if (query.includes("FROM skills WHERE name =")) {
      const row = rows.get(String(values[0]));
      return row ? [row] as T[] : [];
    }

    if (query.includes("FROM skills WHERE category =")) {
      const category = String(values[0]);
      return Array.from(rows.values())
        .filter((row) => row.category === category)
        .sort((a, b) => a.name.localeCompare(b.name)) as T[];
    }

    if (query.includes("FROM skills ORDER BY name")) {
      return Array.from(rows.values())
        .sort((a, b) => a.name.localeCompare(b.name)) as T[];
    }

    throw new Error(`Unhandled SQL in test: ${query}`);
  }) as SqlFn;
}

class FakeR2Bucket {
  store = new Map<string, string>();

  async put(key: string, value: string) {
    this.store.set(key, value);
  }

  async get(key: string) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value,
    };
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}

describe("skills memory store", () => {
  it("preserves an existing SKILL.md without double frontmatter and exposes parsed fields", async () => {
    const sql = createFakeSql();
    const r2 = new FakeR2Bucket();
    const fullSkill = [
      "---",
      "name: imported-skill",
      "description: Existing imported skill",
      "platforms: [websocket, telegram]",
      "metadata:",
      "  hermes:",
      "    tags: [cloudflare]",
      "---",
      "",
      "# Procedure",
      "Run the check and verify the output.",
    ].join("\n");

    const result = await createSkill(
      sql,
      r2 as unknown as R2Bucket,
      "user-1",
      "imported-skill",
      fullSkill,
      {}
    );

    expect(result.ok).toBe(true);

    const stored = r2.store.get("user-1/skills/imported-skill.md");
    expect(stored).toBeDefined();
    expect(stored?.match(/^---$/gm)?.length).toBe(2);
    expect(stored).toContain("metadata:");

    const skill = await getSkill(sql, r2 as unknown as R2Bucket, "user-1", "imported-skill");
    expect(skill?.body).toContain("Run the check and verify the output.");
    expect(skill?.frontmatter.description).toBe("Existing imported skill");
    expect(skill?.frontmatter.platforms).toEqual(["websocket", "telegram"]);
  });

  it("builds a grouped compact index and hides platform-incompatible skills", async () => {
    const sql = createFakeSql();
    const r2 = new FakeR2Bucket();

    await createSkill(
      sql,
      r2 as unknown as R2Bucket,
      "user-1",
      "arxiv-helper",
      "Search papers and summarize the key findings.",
      {
        category: "research",
        description: "Search arXiv papers",
      }
    );

    await createSkill(
      sql,
      r2 as unknown as R2Bucket,
      "user-1",
      "telegram-mod-helper",
      "Moderate a Telegram group.",
      {
        category: "ops",
        description: "Telegram-only moderation helper",
        platforms: "[telegram]",
      }
    );

    const index = getSkillsIndex(sql, "websocket");

    expect(index).toContain("## Skills Index (1)");
    expect(index).toContain("### research");
    expect(index).toContain("arxiv-helper");
    expect(index).not.toContain("telegram-mod-helper");
  });
});
