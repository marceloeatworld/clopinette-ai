import type { HubSkillMeta, CatalogIndex, TrustedRepo } from "./types.js";

/**
 * Official skills catalog.
 * Built-in generic skills (inline) + trusted GitHub repos (fetched dynamically).
 */

// ───────────────────────── Trusted GitHub Repos ─────────────────────────

export const TRUSTED_REPOS: TrustedRepo[] = [
  { owner: "MiniMax-AI", repo: "skills", path: "skills", trustLevel: "trusted", label: "MiniMax AI" },
  { owner: "garrytan", repo: "gstack", path: "", trustLevel: "trusted", label: "gstack" },
  { owner: "cloudflare", repo: "skills", path: "skills", trustLevel: "trusted", label: "Cloudflare" },
];

// ───────────────────────── Built-in Catalog (inline content) ─────────────────────────

const BUILT_IN_CATALOG: CatalogIndex = {
  version: 2,
  updatedAt: "2026-03-27",
  skills: [
    {
      name: "code-review",
      description: "Structured code review with security, performance, and maintainability checks",
      source: "catalog",
      identifier: "code-review",
      trustLevel: "trusted",
      tags: ["development", "review"],
      featured: true,
    },
    {
      name: "git-workflow",
      description: "Git branching, commit messages, PR creation, and merge strategies",
      source: "catalog",
      identifier: "git-workflow",
      trustLevel: "trusted",
      tags: ["development", "git"],
      featured: true,
    },
    {
      name: "api-design",
      description: "REST API design patterns, versioning, error handling, pagination",
      source: "catalog",
      identifier: "api-design",
      trustLevel: "trusted",
      tags: ["development", "api"],
    },
    {
      name: "debug-strategy",
      description: "Systematic debugging: reproduce, isolate, fix, verify, document",
      source: "catalog",
      identifier: "debug-strategy",
      trustLevel: "trusted",
      tags: ["development", "debugging"],
    },
    {
      name: "meeting-notes",
      description: "Extract action items, decisions, and follow-ups from meeting transcripts",
      source: "catalog",
      identifier: "meeting-notes",
      trustLevel: "trusted",
      tags: ["productivity", "meetings"],
    },
    {
      name: "research-summary",
      description: "Summarize research papers, articles, or documents with key findings",
      source: "catalog",
      identifier: "research-summary",
      trustLevel: "trusted",
      tags: ["research", "summary"],
    },
  ],
};

const CATALOG_CONTENTS: Record<string, string> = {
  "code-review": `Review code changes systematically:
1. Security: check for injection, auth issues, secrets exposure
2. Performance: unnecessary loops, N+1 queries, missing indexes
3. Maintainability: naming, single responsibility, DRY
4. Edge cases: null handling, empty arrays, boundary conditions
5. Tests: coverage of new code, edge case tests
Format: list issues by severity (critical > warning > suggestion).`,

  "git-workflow": `Git best practices:
- Branch naming: feature/, fix/, chore/ prefixes
- Commit messages: imperative mood, explain why not what
- PR: small, focused, one concern per PR
- Review: approve with comments, request changes for blockers
- Merge: squash for features, rebase for fixes`,

  "api-design": `REST API patterns:
- Resources as nouns, actions as HTTP methods
- Consistent error format: { error: string, code: number }
- Pagination: cursor-based for large sets, offset for small
- Versioning: URL prefix (/v1/) or Accept header
- Validation: fail fast at the boundary, return 400 with details`,

  "debug-strategy": `Systematic debugging:
1. Reproduce: find the minimal steps to trigger the bug
2. Isolate: narrow down to the exact function/line
3. Hypothesize: what could cause this behavior?
4. Test: verify hypothesis with a targeted change
5. Fix: implement the minimal fix
6. Verify: confirm fix works and doesn't break other things
7. Document: add a test case for the bug`,

  "meeting-notes": `Extract from meeting transcript:
- Decisions made (with who decided)
- Action items (with owner and deadline)
- Open questions (unresolved)
- Key discussion points (brief)
Format as markdown with clear sections.`,

  "research-summary": `Summarize research content:
- Main thesis/finding (1-2 sentences)
- Methodology (brief)
- Key results (bullet points)
- Limitations
- Relevance to the user's context
Keep it concise. Link to source if available.`,
};

// ───────────────────────── Catalog API ─────────────────────────

/**
 * Search the built-in catalog.
 */
export function searchCatalog(query: string, limit = 10): HubSkillMeta[] {
  const q = query.toLowerCase();
  return BUILT_IN_CATALOG.skills
    .filter(s =>
      s.name.includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags?.some(t => t.includes(q))
    )
    .slice(0, limit)
    .map(s => ({
      name: s.name,
      description: s.description,
      source: s.source,
      identifier: s.identifier,
      trustLevel: s.trustLevel,
      tags: s.tags,
    }));
}

/**
 * Get a catalog skill by identifier (inline content only).
 */
export function getCatalogSkill(identifier: string): { meta: HubSkillMeta; content: string } | null {
  const entry = BUILT_IN_CATALOG.skills.find(s => s.identifier === identifier);
  if (!entry) return null;

  const content = CATALOG_CONTENTS[identifier];
  if (!content) return null;

  return {
    meta: {
      name: entry.name,
      description: entry.description,
      source: entry.source,
      identifier: entry.identifier,
      trustLevel: entry.trustLevel,
      tags: entry.tags,
    },
    content,
  };
}

/**
 * List all catalog skills (for browse UI).
 */
export function listCatalog(): HubSkillMeta[] {
  return BUILT_IN_CATALOG.skills.map(s => ({
    name: s.name,
    description: s.description,
    source: s.source,
    identifier: s.identifier,
    trustLevel: s.trustLevel,
    tags: s.tags,
  }));
}
