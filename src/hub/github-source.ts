import type { SkillSource, HubSkillMeta, HubSkillBundle } from "./types.js";
import { parseFrontmatter } from "./install.js";
import { TRUSTED_REPOS } from "./catalog.js";

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

function inferSkillNameFromPath(path: string): string {
  const withoutFile = path.replace(/\/SKILL\.md$/i, "");
  const segments = withoutFile.split("/").filter(Boolean);
  return segments[segments.length - 1] || path;
}

function stripBasePath(path: string, basePath: string): string {
  if (!basePath) return path;
  const prefix = `${basePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function derivePathTags(skillPath: string): string[] | undefined {
  const withoutFile = skillPath.replace(/\/SKILL\.md$/, "");
  const segments = withoutFile.split("/").filter(Boolean);
  if (segments.length <= 1) return undefined;
  return segments.slice(0, -1);
}

function findTrustedRepo(owner: string, repo: string, filePath: string) {
  return TRUSTED_REPOS.find((candidate) => {
    if (candidate.owner !== owner || candidate.repo !== repo) return false;
    if (!candidate.path) return true;
    return filePath === candidate.path || filePath.startsWith(`${candidate.path}/`);
  });
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
    const trustedRepo = findTrustedRepo(owner, repo, filePath);
    const relativePath = trustedRepo ? stripBasePath(filePath, trustedRepo.path) : filePath;
    const inferredTags = derivePathTags(relativePath);

    return {
      meta: {
        name: (frontmatter.name as string) || inferSkillNameFromPath(path) || "unknown",
        description: (frontmatter.description as string) || `${humanizeName(inferSkillNameFromPath(relativePath) || "skill")} — ${trustedRepo?.label ?? `${owner}/${repo}`}`,
        source: "github",
        identifier,
        trustLevel: trustedRepo?.trustLevel ?? "community",
        author: (frontmatter.author as string) || trustedRepo?.label || `${owner}/${repo}`,
        license: frontmatter.license as string,
        tags: (frontmatter.tags as string[]) || inferredTags,
        collection: trustedRepo?.collection,
        collectionLabel: trustedRepo?.label,
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
    collection?: string,
    label?: string,
  ): Promise<HubSkillMeta[]> {
    const cacheKey = `${owner}/${repo}/${basePath}/${collection ?? ""}/${label ?? ""}`;
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

    const skills: HubSkillMeta[] = [];
    for (const entry of data.tree ?? []) {
      if (!entry.path.endsWith("/SKILL.md")) continue;
      if (prefix && !entry.path.startsWith(prefix)) continue;

      const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
      const skillDir = rel.replace(/\/SKILL\.md$/, "");
      const segments = skillDir.split("/").filter(Boolean);
      if (segments.length === 0) continue;
      if (segments.some((segment) => segment.startsWith(".") || segment === "__pycache__")) continue;

      const name = segments[segments.length - 1];
      const categories = segments.slice(0, -1);
      const location = categories.length > 0
        ? ` (${categories.map(humanizeName).join(" / ")})`
        : "";
      const collectionLabel = label ?? `${owner}/${repo}`;

      skills.push({
        name,
        description: `${humanizeName(name)} — ${collectionLabel}${location}`,
        source: "github",
        identifier: `${owner}/${repo}/${entry.path}`,
        trustLevel,
        tags: categories.length > 0 ? categories : undefined,
        collection,
        collectionLabel,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));

    repoIndexCache.set(cacheKey, { skills, ts: Date.now() });
    return skills;
  }
}
