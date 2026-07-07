import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubSource } from "../src/hub/github-source.js";

const originalFetch = globalThis.fetch;

describe("hub github source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("lists nested Hermes skills from trusted repos", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      tree: [
        { path: "skills/apple/apple-notes/SKILL.md", type: "blob" },
        { path: "skills/mlops/training/unsloth/SKILL.md", type: "blob" },
        { path: "skills/.hidden/secret/SKILL.md", type: "blob" },
        { path: "skills/README.md", type: "blob" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    const gh = new GitHubSource();
    const skills = await gh.listRepoSkills(
      "NousResearch",
      "hermes-agent",
      "skills",
      "trusted",
      "hermes",
      "Hermes Agent",
    );

    expect(skills.map((skill) => skill.name)).toEqual(["apple-notes", "unsloth"]);

    expect(skills[0]).toMatchObject({
      collection: "hermes",
      collectionLabel: "Hermes Agent",
      tags: ["apple"],
    });

    expect(skills[1]).toMatchObject({
      tags: ["mlops", "training"],
    });
  });

  it("fetches a GitHub skill using the directory name when frontmatter has no name", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/main?recursive=1")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/apple/apple-notes/SKILL.md", type: "blob" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/contents/")) {
        return new Response(`---
description: Test skill without explicit name
---

# Hello

Content`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const gh = new GitHubSource();
    const bundle = await gh.fetch("NousResearch/hermes-agent/skills/apple/apple-notes/SKILL.md");

    expect(bundle).not.toBeNull();
    expect(bundle?.meta).toMatchObject({
      name: "apple-notes",
      description: "Test skill without explicit name",
      source: "github",
    });
    expect(bundle?.supportFiles).toEqual([]);
  });

  it("fetches text support files that live next to the skill", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/main?recursive=1")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/red-teaming/godmode/SKILL.md", type: "blob" },
            { path: "skills/red-teaming/godmode/scripts/parseltongue.py", type: "blob" },
            { path: "skills/red-teaming/godmode/templates/prefill.json", type: "blob" },
            { path: "skills/red-teaming/godmode/image.png", type: "blob" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/contents/skills/red-teaming/godmode/SKILL.md")) {
        return new Response("---\nname: godmode\n---\n\n# Godmode", { status: 200 });
      }
      if (url.includes("/contents/skills/red-teaming/godmode/scripts/parseltongue.py")) {
        return new Response("print('parseltongue')", { status: 200 });
      }
      if (url.includes("/contents/skills/red-teaming/godmode/templates/prefill.json")) {
        return new Response("{\"ok\":true}", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const gh = new GitHubSource();
    const bundle = await gh.fetch("NousResearch/hermes-agent/skills/red-teaming/godmode/SKILL.md");

    expect(bundle?.supportFiles).toEqual([
      { path: "scripts/parseltongue.py", content: "print('parseltongue')" },
      { path: "templates/prefill.json", content: "{\"ok\":true}" },
    ]);
  });
});
