import type { HubSkillMeta, CatalogIndex, TrustedRepo } from "./types.js";

/**
 * Official skills catalog.
 * Built-in generic skills (inline) + trusted GitHub repos (fetched dynamically).
 *
 * The inline catalog ships with the worker: deploying the core updates the hub
 * for every user at once. Skills already installed from the catalog are
 * refreshed by the daily update check in `install.ts` (content-hash compare),
 * so bumping `version` / editing a body here reaches existing installs too.
 */

// ───────────────────────── Trusted GitHub Repos ─────────────────────────

export const TRUSTED_REPOS: TrustedRepo[] = [
  { id: "minimax", collection: "minimax", owner: "MiniMax-AI", repo: "skills", path: "skills", trustLevel: "trusted", label: "MiniMax AI" },
  { id: "gstack", collection: "gstack", owner: "garrytan", repo: "gstack", path: "", trustLevel: "trusted", label: "gstack" },
  { id: "cloudflare", collection: "cloudflare", owner: "cloudflare", repo: "skills", path: "skills", trustLevel: "trusted", label: "Cloudflare" },
  { id: "hermes", collection: "hermes", owner: "NousResearch", repo: "hermes-agent", path: "skills", trustLevel: "trusted", label: "Hermes Agent" },
  { id: "hermes-optional", collection: "hermes", owner: "NousResearch", repo: "hermes-agent", path: "optional-skills", trustLevel: "trusted", label: "Hermes Agent Optional" },
];

// ───────────────────────── Built-in Catalog (inline content) ─────────────────────────

export const BUILT_IN_CATALOG: CatalogIndex = {
  version: 3,
  updatedAt: "2026-09-06",
  skills: [
    {
      name: "web-research",
      description: "Multi-source web research: parallel delegates, primary sources, cited and cross-checked answer",
      source: "catalog",
      identifier: "web-research",
      trustLevel: "trusted",
      tags: ["research", "web"],
      featured: true,
    },
    {
      name: "daily-briefing",
      description: "Morning briefing from the calendar, open todos, pinned notes and recent context",
      source: "catalog",
      identifier: "daily-briefing",
      trustLevel: "trusted",
      tags: ["productivity", "calendar", "todo"],
      featured: true,
    },
    {
      name: "document-qa",
      description: "Answer questions from uploaded documents with quotes and document names, never from guesswork",
      source: "catalog",
      identifier: "document-qa",
      trustLevel: "trusted",
      tags: ["documents", "rag"],
      featured: true,
    },
    {
      name: "meeting-notes",
      description: "Turn a transcript or voice memo into decisions, owners, deadlines, then file them as notes, todos and events",
      source: "catalog",
      identifier: "meeting-notes",
      trustLevel: "trusted",
      tags: ["productivity", "meetings"],
      featured: true,
    },
    {
      name: "code-review",
      description: "Structured code review with security, performance, correctness and maintainability checks",
      source: "catalog",
      identifier: "code-review",
      trustLevel: "trusted",
      tags: ["development", "review"],
    },
    {
      name: "git-workflow",
      description: "Git branching, commit messages, PR creation, and merge strategies",
      source: "catalog",
      identifier: "git-workflow",
      trustLevel: "trusted",
      tags: ["development", "git"],
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
      name: "research-summary",
      description: "Summarize research papers, articles, or documents with key findings and limitations",
      source: "catalog",
      identifier: "research-summary",
      trustLevel: "trusted",
      tags: ["research", "summary"],
    },
    {
      name: "writing-editor",
      description: "Edit and proofread text while keeping the author's voice, language and register",
      source: "catalog",
      identifier: "writing-editor",
      trustLevel: "trusted",
      tags: ["writing", "editing"],
    },
  ],
};

const CATALOG_CONTENTS: Record<string, string> = {
  "web-research": `Research a question on the web and answer with sources.

Workflow:
1. Restate the question in one line. If it has an obvious default reading, do not ask, proceed.
2. If the user gave URLs, read each one with web({action:"read", url}) BEFORE searching.
3. For anything with 2-3 independent angles (primary source, recent changes, independent analysis or data), launch them in parallel with delegate({ tasks: [...] }). For a single simple lookup, use web({action:"search"}) directly.
4. Prefer primary sources: official docs, the original paper, the company's own announcement, the standard. Treat aggregators and forums as leads, not evidence.
5. Cross-check: when two sources disagree, say so and say which one you trust more and why.
6. Note the date of each key fact. Anything that can change (prices, versions, roles, laws) must carry its date.

Answer format:
- Direct answer first (2-4 sentences).
- Key findings as short bullets, each ending with its source URL.
- "Uncertain / not found" section when something could not be verified.
- Reply in the user's language, keep source titles in their original language.

Do not re-search topics the delegates already covered. Do not pad with background the user did not ask for.`,

  "daily-briefing": `Produce a short briefing of the user's day. Use the tools, never invent entries.

Gather, in parallel when possible:
- calendar: events for today and tomorrow (include time, location, and reminders).
- todo: open items, oldest first; flag anything overdue.
- notes: pinned notes, plus notes created in the last 48 hours.
- memory / USER.md: the user's known priorities, timezone and working hours.
- history: only if the user mentioned an ongoing project yesterday and it is not in the todos.

Output:
1. One-line headline for the day (busiest block, or "light day").
2. Schedule: chronological list, "HH:MM  Title (place)". Mark conflicts and back-to-back meetings.
3. Priorities: at most 3 items chosen from todos and notes, with a reason for each.
4. Follow-ups: things promised in recent conversations that have no todo yet. Offer to create them with todo, do not create silently.

Rules:
- Use the user's timezone from USER.md; if unknown, ask once via clarify and save the answer to memory.
- Respect the platform: plain lines on Telegram and WhatsApp, headers allowed on the web.
- If everything is empty, say so in one line and stop.`,

  "document-qa": `Answer questions from the user's uploaded documents.

1. Search first: docs({ action: "search", query }) with 2-3 phrasings of the question (synonyms, the user's exact words, the likely heading).
2. Read the relevant passages. If the result was spilled to R2, open it with docs({ action: "read_spillover", r2Key }) instead of guessing from the preview.
3. Answer from the documents only. Each claim names its document and, when available, the page or section. Quote short passages verbatim for numbers, dates, clauses and definitions.
4. If the documents do not contain the answer, say exactly that, then offer either a web search or to answer from general knowledge, clearly labelled as such.
5. When several documents conflict (different versions of a contract, old and new policy), show both with their document names and dates.

Formatting:
- Short question, short answer. Tables only on the web platform.
- Preserve the document's terminology and language; translate only if the user writes in another language, and keep the original term in parentheses the first time.`,

  "meeting-notes": `Turn a meeting transcript, voice memo or pasted notes into structured, actionable output.

Extract:
- Decisions: what was decided and by whom.
- Action items: owner, task, deadline. Unknown owner or deadline is written as "unassigned" / "no date", never guessed.
- Open questions: unresolved points and who should answer them.
- Key points: at most 5 bullets of context worth remembering.

Then file it:
- notes: save the full structured summary as one note titled with the meeting name and date.
- todo: create one todo per action item that belongs to the user.
- calendar: create events for any agreed follow-up meeting with an explicit date and time. Ask via clarify when the date is ambiguous ("next Tuesday" with no reference date).
- memory: if the meeting revealed a durable fact about the user's work (new project, new team member, new deadline), save it.

Reply with the summary in the language of the transcript, then a one-line list of what was filed (note, N todos, N events).`,

  "code-review": `Review code changes systematically. Read the whole diff before commenting.

Checklist, in priority order:
1. Correctness: logic errors, off-by-one, wrong null and empty-collection handling, unhandled promise rejections, race conditions.
2. Security: injection (SQL, shell, HTML), missing authentication or authorization checks, credentials committed to the repository, unsafe deserialization, SSRF on user-supplied URLs.
3. Data: migrations without rollback, breaking schema changes, unbounded growth, missing indexes on new query paths.
4. Performance: N+1 queries, work inside hot loops, blocking calls in async paths, oversized payloads.
5. Maintainability: naming, single responsibility, duplication, dead code, comments that explain "why".
6. Tests: new behaviour covered, edge cases covered, tests that would fail if the change were reverted.

Output format:
- Verdict line: approve, approve with comments, or request changes.
- Findings grouped by severity (critical, warning, suggestion). Each finding: file and line, what is wrong, why it matters, a concrete fix.
- Say what you did not review (files skipped, runtime not executed).

Do not restate the diff. Do not praise. Keep suggestions to things the author can act on.`,

  "git-workflow": `Git best practices for a small team.

Branches:
- Prefixes: feature/, fix/, chore/, docs/. Short, kebab-case, one topic per branch.
- Branch from the default branch, rebase on it before opening a PR.

Commits:
- Imperative mood subject under 72 characters ("fix: reject expired tokens"), Conventional Commits prefixes (feat, fix, chore, docs, refactor, test).
- Body explains why, not what. Reference the issue when there is one.
- One logical change per commit; never mix formatting with behaviour changes.

Pull requests:
- Small and focused: one concern per PR, under about 400 changed lines when possible.
- Description: problem, approach, how it was tested, anything reviewers should look at first.
- Keep CI green before requesting review.

Merging:
- Squash for feature branches, rebase for small fixes, never force-push a shared branch.
- Delete the branch after merge.

When asked to write a commit message or PR description, ask for the diff or summary first if it was not provided, then produce it in English regardless of the conversation language.`,

  "api-design": `REST API design patterns.

- Resources are nouns, actions are HTTP methods. Sub-resources for ownership (/users/{id}/keys), verbs only for non-CRUD operations (/orders/{id}/cancel).
- Status codes: 200 read or update, 201 create, 204 delete, 400 validation, 401 not authenticated, 403 not allowed, 404 missing, 409 conflict, 422 semantic error, 429 rate limited.
- One error format everywhere: { error: string, code: string, details?: object }. Fail fast at the boundary, return all validation errors at once.
- Pagination: cursor-based for large or changing sets, offset only for small stable lists. Always return the next cursor and a stable sort key.
- Versioning: URL prefix (/v1/) or an explicit header. Never break a released version; add fields, do not rename them.
- Idempotency: PUT and DELETE are idempotent by definition; accept an Idempotency-Key header on POST for payments and jobs.
- Security: authenticate every route by default, rate limit by identity, validate content types, never reflect user input into headers.
- Document with examples for every endpoint: request, success response, one error response.`,

  "debug-strategy": `Systematic debugging. Do not change code before step 3.

1. Reproduce: find the minimal steps or input that trigger the bug. If it cannot be reproduced, collect logs, versions and environment differences first.
2. Isolate: narrow to the exact function, line or data. Bisect by commit, by input, or by disabling components.
3. Hypothesize: write down what could cause the observed behaviour and what evidence would confirm or refute each hypothesis.
4. Test the hypothesis with a targeted probe (log, assertion, unit test), not with a speculative fix.
5. Fix: the smallest change that addresses the root cause, not the symptom.
6. Verify: the original reproduction passes, related paths still work, no new warnings.
7. Document: a regression test for the bug and a one-paragraph note of the root cause.

When helping someone else debug, ask for the exact error text, the expected versus actual behaviour, and what changed recently, before proposing causes.`,

  "research-summary": `Summarize research content (papers, reports, long articles).

Structure:
- Main claim or finding: 1-2 sentences in plain language.
- Method: what was done, on what data or population, how large.
- Key results: bullets with the actual numbers and effect sizes when given.
- Limitations: stated by the authors, plus obvious ones they did not state (sample size, conflicts of interest, no replication).
- Relevance: why it matters for the user's context (use memory / USER.md when helpful).
- Source: title, authors, venue, year, URL or document name.

Rules:
- Distinguish what the source shows from what it speculates.
- Never add findings that are not in the source. If the user asks a question the source does not answer, say so.
- Keep it under 250 words unless asked for a deep dive.`,

  "writing-editor": `Edit, proofread or rewrite text while keeping the author's voice.

Before editing, determine the mode from the request:
- Proofread: fix spelling, grammar, punctuation only. Keep every sentence.
- Tighten: remove redundancy and filler, keep meaning and tone, roughly the same length or shorter.
- Rewrite: restructure for clarity for a stated audience; keep facts and intent.
- Translate: keep register and formatting; keep names, product terms and quotes untranslated unless asked.

Rules:
- Keep the author's language, register (formal or casual) and person (I / we).
- Do not change facts, numbers, names or claims. Flag anything that looks wrong instead of silently fixing it.
- Preserve formatting: headings, lists, links, code blocks.
- Return the edited text first. Then, only if asked or if you made structural changes, a short list of what changed and why.
- For long texts, work section by section and keep section titles.`,
};

// ───────────────────────── Catalog API ─────────────────────────

/**
 * Search the built-in catalog.
 */
export function searchCatalog(query: string, limit = 10): HubSkillMeta[] {
  const q = query.toLowerCase();
  return BUILT_IN_CATALOG.skills
    .filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags?.some(t => t.toLowerCase().includes(q))
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
