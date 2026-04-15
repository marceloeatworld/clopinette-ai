import { describe, expect, it } from "vitest";
import { createSkill } from "../src/memory/skills.js";
import { installSkill } from "../src/hub/install.js";
import type { SqlFn } from "../src/config/sql.js";
import type { HubSkillBundle } from "../src/hub/types.js";

interface StoredSkillRow {
  name: string;
  category: string | null;
  description: string | null;
  triggerPattern: string | null;
  platforms: string | null;
}

function createFakeSql(): SqlFn {
  const skills = new Map<string, StoredSkillRow>();
  const hubInstalled = new Set<string>();

  return (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.join("?");

    if (query.includes("SELECT name FROM hub_installed WHERE name =")) {
      const name = String(values[0]);
      return hubInstalled.has(name) ? [{ name }] as T[] : [];
    }

    if (query.includes("SELECT name FROM skills WHERE name =")) {
      const name = String(values[0]);
      return skills.has(name) ? [{ name }] as T[] : [];
    }

    if (query.includes("INSERT INTO skills")) {
      const [name, category, description, triggerPattern, platforms] = values as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      skills.set(name, { name, category, description, triggerPattern, platforms });
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
      const current = skills.get(name);
      if (current) skills.set(name, { name, category, description, triggerPattern, platforms });
      return [];
    }

    if (query.includes("INSERT INTO hub_installed")) {
      hubInstalled.add(String(values[0]));
      return [];
    }

    if (query.includes("UPDATE hub_installed SET")) {
      hubInstalled.add(String(values[6]));
      return [];
    }

    if (query.includes("DELETE FROM skills WHERE name =")) {
      skills.delete(String(values[0]));
      return [];
    }

    if (query.includes("DELETE FROM hub_installed WHERE name =")) {
      hubInstalled.delete(String(values[0]));
      return [];
    }

    if (query.includes("INSERT INTO audit_log")) {
      return [];
    }

    if (query.includes("FROM skills WHERE name =")) {
      const row = skills.get(String(values[0]));
      return row ? [row] as T[] : [];
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
    return { text: async () => value };
  }

  async delete(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.store.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    const objects = Array.from(this.store.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }));
    return { objects };
  }
}

describe("hub install", () => {
  it("allows trusted red-team skills even when direct manual creation would be blocked", async () => {
    const sql = createFakeSql();
    const r2 = new FakeR2Bucket();
    const content = "# Godmode\n\nThis skill discusses system prompt injection and safety bypass testing.";

    const manual = await createSkill(
      sql,
      r2 as unknown as R2Bucket,
      "user-1",
      "godmode",
      content,
      { category: "security" },
    );
    expect(manual.ok).toBe(false);
    expect(manual.error).toContain("Blocked:");

    const bundle: HubSkillBundle = {
      meta: {
        name: "godmode",
        description: "Trusted red-team skill",
        source: "github",
        identifier: "NousResearch/hermes-agent/skills/red-teaming/godmode/SKILL.md",
        trustLevel: "trusted",
      },
      content,
      frontmatter: {},
      supportFiles: [],
    };

    const installed = await installSkill(
      sql,
      r2 as unknown as R2Bucket,
      "user-1",
      bundle,
    );
    expect(installed).toEqual({ ok: true, name: "godmode" });
  });
});
