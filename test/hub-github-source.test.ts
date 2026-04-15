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
  });
});
