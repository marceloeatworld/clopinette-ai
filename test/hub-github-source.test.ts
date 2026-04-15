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
});
