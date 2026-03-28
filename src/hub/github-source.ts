import type { SkillSource, HubSkillMeta, HubSkillBundle } from "./types.js";
import { parseFrontmatter } from "./install.js";

/**
 * GitHub source — fetch skills from any GitHub repo.
 * Uses the GitHub Contents API (no auth required for public repos, 60 req/hr limit).
 *
 * Identifier format: "owner/repo/path/to/skill-dir" or "owner/repo/path/to/SKILL.md"
 */

const GITHUB_API = "https://api.github.com";

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json", "User-Agent": "Clopinette" };
  if (token) h.Authorization = `token ${token}`;
  return h;
}

// Set via GitHubSource.setToken() — shared across all instances in the same isolate
let _githubToken: string | undefined;

// In-memory cache for repo indexes (persists for DO lifetime)
const repoIndexCache = new Map<string, { skills: HubSkillMeta[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function humanizeName(name: string): string {
  return name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export class GitHubSource implements SkillSource {
  id = "github";

  static setToken(token: string | undefined) { _githubToken = token; }

  /**
   * Search for SKILL.md files in a repo path.
   */
  async search(query: string, limit = 10): Promise<HubSkillMeta[]> {
    if (!query.trim()) return [];
    const q = encodeURIComponent(`${query} filename:SKILL.md`);
    const resp = await fetch(`${GITHUB_API}/search/code?q=${q}&per_page=${limit}`, {
      headers: githubHeaders(_githubToken),
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 429) {
        console.warn(`GitHub API rate limited (${resp.status})`);
      }
      return [];
    }

    const data = await resp.json<{
      items?: Array<{ repository: { full_name: string }; path: string; html_url: string }>;
    }>();

    return (data.items ?? []).map(item => ({
      name: item.path.split("/").slice(-2, -1)[0] || item.path,
      description: `From ${item.repository.full_name}`,
      source: "github",
      identifier: `${item.repository.full_name}/${item.path}`,
      trustLevel: "community" as const,
    }));
  }

  /**
   * Fetch a skill from GitHub.
   * identifier: "owner/repo/path/to/SKILL.md" or "owner/repo/path/to/skill-dir"
   */
  async fetch(identifier: string): Promise<HubSkillBundle | null> {
    const parts = identifier.split("/");
    if (parts.length < 3) return null;
    const owner = parts[0];
    const repo = parts[1];
    const path = parts.slice(2).join("/");

    const filePath = path.endsWith(".md") ? path : `${path}/SKILL.md`;
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`;
    const resp = await fetch(url, {
      headers: { ...githubHeaders(_githubToken), Accept: "application/vnd.github.v3.raw" },
    });

    if (!resp.ok) return null;

    const content = await resp.text();
    const { frontmatter, body } = parseFrontmatter(content);

    return {
      meta: {
        name: (frontmatter.name as string) || path.split("/").pop() || "unknown",
        description: (frontmatter.description as string) || "",
        source: "github",
        identifier,
        trustLevel: "community",
        author: (frontmatter.author as string) || `${owner}/${repo}`,
        license: frontmatter.license as string,
        tags: frontmatter.tags as string[],
      },
      content: body,
      frontmatter,
    };
  }

  /**
   * List all skills in a specific GitHub repo using the Git Trees API.
   * One API call per repo, cached for 10 minutes.
   */
  async listRepoSkills(
    owner: string,
    repo: string,
    basePath: string,
    trustLevel: "trusted" | "community" = "community",
  ): Promise<HubSkillMeta[]> {
    const cacheKey = `${owner}/${repo}/${basePath}`;
    const cached = repoIndexCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.skills;

    const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
      headers: githubHeaders(_githubToken),
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 429) {
        console.warn(`GitHub API rate limited listing ${owner}/${repo} (${resp.status})`);
      }
      return cached?.skills ?? [];
    }

    const data = await resp.json<{ tree?: Array<{ path: string; type: string }> }>();
    const prefix = basePath ? `${basePath}/` : "";

    const skills = (data.tree ?? [])
      .filter(f => f.path.endsWith("/SKILL.md"))
      .filter(f => {
        if (prefix && !f.path.startsWith(prefix)) return false;
        const rel = prefix ? f.path.slice(prefix.length) : f.path;
        // Only direct children: "name/SKILL.md" (2 segments)
        const segments = rel.split("/");
        return segments.length === 2 && !segments[0].startsWith(".");
      })
      .map(f => {
        const rel = prefix ? f.path.slice(prefix.length) : f.path;
        const name = rel.split("/")[0];
        return {
          name,
          description: `${humanizeName(name)} — ${owner}/${repo}`,
          source: "github" as const,
          identifier: `${owner}/${repo}/${f.path}`,
          trustLevel,
        };
      });

    repoIndexCache.set(cacheKey, { skills, ts: Date.now() });
    return skills;
  }
}
