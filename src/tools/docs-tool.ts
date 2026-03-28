import { z } from "zod";
import type { ToolContext } from "./registry.js";
import type { SqlFn } from "../config/sql.js";

/**
 * Unified document search — merges docs-search-tool.ts + ai-search-tool.ts.
 *
 * Actions:
 * - search: auto-routes — tries AutoRAG (semantic) first, falls back to R2 keyword
 * - ask:    AutoRAG AI-generated answer with citations
 * - list:   list all uploaded files
 */

// ─── Text MIME detection ──────────────────────────────────────────────────────

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/json", "application/xml", "text/xml",
  "application/yaml", "text/yaml",
]);

function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return TEXT_MIMES.has(mime) || mime.startsWith("text/");
}

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "");
}

// ─── AutoRAG types ────────────────────────────────────────────────────────────

interface AutoRAGSearchResult {
  filename: string;
  score: number;
  content: string[];
}

interface AutoRAGAIResult {
  response: string;
  data: Array<AutoRAGSearchResult>;
}

interface AutoRAGBinding {
  aiSearch(options: {
    query: string;
    rewrite_query?: boolean;
    max_num_results?: number;
    ranking_options?: { score_threshold?: number };
    stream?: boolean;
  }): Promise<AutoRAGAIResult>;
  search(options: {
    query: string;
    rewrite_query?: boolean;
    max_num_results?: number;
  }): Promise<{ data: AutoRAGSearchResult[] }>;
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createDocsTool(ctx: ToolContext) {
  return {
    description:
      "Search through uploaded documents — unified keyword + semantic search.\n" +
      "Actions:\n" +
      "- 'search': finds documents by query (auto-routes: semantic AI search if available, keyword fallback).\n" +
      "- 'ask': get an AI-generated answer with source citations (requires AutoRAG).\n" +
      "- 'list': show all uploaded files.\n" +
      "USE when user asks about their documents, PDFs, or uploaded files.",
    inputSchema: z.object({
      action: z.enum(["search", "ask", "list"]).describe("Action to perform"),
      query: z.string().optional().describe("Search query (for search/ask)"),
      maxResults: z.number().optional().default(5).describe("Max results (default 5)"),
    }),
    execute: async (params: { action: string; query?: string; maxResults?: number }) => {
      const limit = params.maxResults ?? 5;

      switch (params.action) {
        // ─── LIST ─────────────────────────────────────────────────────────
        case "list": {
          const prefix = `${sanitizeUserId(ctx.userId)}/docs/`;
          const listed = await ctx.r2Memories.list({ prefix, limit: 50 });
          if (listed.objects.length === 0) {
            return { ok: true, results: [], message: "No documents found. Upload documents first." };
          }
          const contextRows = ctx.sql<{ r2_key: string; context: string }>`
            SELECT r2_key, context FROM doc_context WHERE r2_key LIKE ${prefix + '%'}
          `;
          const contextMap = new Map(contextRows.map(r => [r.r2_key, r.context]));
          return {
            ok: true,
            results: listed.objects.map((obj) => ({
              document: obj.key.replace(prefix, ""),
              type: obj.httpMetadata?.contentType ?? "unknown",
              size: obj.size,
              uploaded: obj.uploaded.toISOString(),
              description: contextMap.get(obj.key) ?? obj.customMetadata?.context ?? null,
            })),
            total: listed.objects.length,
          };
        }

        // ─── ASK (AutoRAG AI answer) ──────────────────────────────────────
        case "ask": {
          if (!params.query) return { ok: false, error: "query required for ask" };
          const autorag = getAutoRAG(ctx.ai, ctx.sql);
          if (!autorag) {
            return { ok: false, error: "AI Search (AutoRAG) not configured. Use action 'search' for keyword search, or set up AutoRAG in the CF dashboard." };
          }
          const result = await autorag.aiSearch({
            query: params.query,
            rewrite_query: true,
            max_num_results: limit,
            stream: false,
          });
          return {
            ok: true,
            answer: result.response,
            sources: result.data?.map((d) => ({
              filename: d.filename,
              score: d.score,
              snippet: d.content?.[0]?.slice(0, 300),
            })),
          };
        }

        // ─── SEARCH (auto: semantic first, keyword fallback) ──────────────
        case "search": {
          if (!params.query) return { ok: false, error: "query required for search" };

          // Try AutoRAG semantic search first
          const autorag = getAutoRAG(ctx.ai, ctx.sql);
          if (autorag) {
            try {
              const result = await autorag.search({
                query: params.query,
                rewrite_query: true,
                max_num_results: limit,
              });
              if (result.data?.length > 0) {
                return {
                  ok: true,
                  mode: "semantic",
                  results: result.data.map((d) => ({
                    document: d.filename,
                    score: d.score,
                    snippet: d.content?.[0]?.slice(0, 500),
                  })),
                };
              }
            } catch {
              // AutoRAG failed, fall through to keyword
            }
          }

          // Keyword fallback
          return keywordSearch(ctx, params.query, limit);
        }

        default:
          return { ok: false, error: `Unknown action: ${params.action}. Use: search, ask, list` };
      }
    },
  };
}

// ─── AutoRAG helper ───────────────────────────────────────────────────────────

function getAutoRAG(ai: Ai, sql: SqlFn): AutoRAGBinding | null {
  const rows = sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'autorag_name'`;
  if (rows.length === 0 || !rows[0].value) return null;
  try {
    return (ai as unknown as { autorag: (name: string) => AutoRAGBinding }).autorag(rows[0].value);
  } catch { return null; }
}

// ─── Keyword search (R2) ─────────────────────────────────────────────────────

async function keywordSearch(ctx: ToolContext, query: string, limit: number) {
  const prefix = `${sanitizeUserId(ctx.userId)}/docs/`;
  const listed = await ctx.r2Memories.list({ prefix, limit: 50 });

  if (listed.objects.length === 0) {
    return { ok: true, mode: "keyword", results: [], message: "No documents found." };
  }

  const contextRows = ctx.sql<{ r2_key: string; context: string }>`
    SELECT r2_key, context FROM doc_context WHERE r2_key LIKE ${prefix + '%'}
  `;
  const contextMap = new Map(contextRows.map(r => [r.r2_key, r.context]));

  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter(Boolean);

  const files = listed.objects.map((obj) => ({
    key: obj.key,
    name: obj.key.replace(prefix, ""),
    mime: obj.httpMetadata?.contentType,
    context: contextMap.get(obj.key) ?? obj.customMetadata?.context,
  }));

  const scored = await Promise.all(files.map(async (file) => {
    let score = 0;
    let snippet = "";
    const nameLower = file.name.toLowerCase();

    for (const term of terms) {
      if (nameLower.includes(term)) score += 2;
    }

    if (file.context) {
      const ctxLower = file.context.toLowerCase();
      for (const term of terms) {
        if (ctxLower.includes(term)) score += 2;
      }
      if (score > 0 && !snippet) snippet = file.context.slice(0, 400);
    }

    if (isTextMime(file.mime)) {
      const r2Obj = await ctx.r2Memories.get(file.key);
      if (r2Obj) {
        const content = await r2Obj.text();
        const contentLower = content.toLowerCase();
        for (const term of terms) {
          if (contentLower.includes(term)) score++;
        }
        if (score > 0 && !snippet) {
          const firstTerm = terms.find((t) => contentLower.includes(t));
          if (firstTerm) {
            const idx = contentLower.indexOf(firstTerm);
            snippet = content.slice(Math.max(0, idx - 100), idx + 300);
          }
        }
      }
    }

    if (!isTextMime(file.mime)) {
      const transcript = await ctx.r2Memories.get(file.key + ".transcript.md");
      if (transcript) {
        const text = await transcript.text();
        const textLower = text.toLowerCase();
        for (const term of terms) {
          if (textLower.includes(term)) score++;
        }
        if (score > 0 && !snippet) snippet = text.slice(0, 400);
      }
    }

    return score > 0 ? { document: file.name, snippet, relevance: score, type: file.mime ?? "unknown" } : null;
  }));

  const matches = scored.filter((m): m is NonNullable<typeof m> => m !== null);
  matches.sort((a, b) => b.relevance - a.relevance);

  return {
    ok: true,
    mode: "keyword",
    results: matches.slice(0, limit),
    allFiles: files.map((f) => f.name),
  };
}
