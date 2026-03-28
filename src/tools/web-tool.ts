import { z } from "zod";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { AUXILIARY_MODEL } from "../config/constants.js";

/**
 * Unified web tool — 100% Cloudflare-native.
 *
 * Replaces: web-search-tool.ts (Brave/Tavily), web-browse-tool.ts, web-crawl-tool.ts.
 *
 * All powered by CF Browser Rendering REST API:
 * - search:      /json endpoint on DuckDuckGo HTML → AI extracts structured results
 * - read:        /markdown endpoint → page as markdown, auto-summarized if long
 * - extract:     /json endpoint → AI-powered structured data extraction
 * - scrape:      /scrape endpoint → CSS selector extraction
 * - links:       /links endpoint → all links on a page
 * - crawl_start: /crawl endpoint → async multi-page crawl
 * - crawl_check: /crawl/{id} → check crawl status/results
 */

const BR_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** Resource types blocked by default — pages load 3-5x faster */
const REJECT_RESOURCES = ["image", "font", "media", "stylesheet"];

/** Keep browser session alive 90s between requests — avoids 15-30s cold starts */
const SESSION_KEEP_ALIVE = 90_000;

// ─── Summarization constants ──────────────────────────────────────────────────

const SUMMARIZE_SYSTEM = `You are an expert content analyst. Extract the key information from this web page and create a comprehensive yet concise markdown summary.

Include:
1. Key facts, figures, data points, and actionable information
2. Important quotes or code snippets in their original format
3. Proper markdown formatting (headers, bullets, emphasis)

Preserve ALL important information while removing boilerplate (navbars, footers, ads, cookie notices).
Never lose key facts or insights. Be thorough but concise. Max 1200 words.`;

const CHUNK_SYSTEM = `You are processing a SECTION of a larger web page. Extract ALL key facts, figures, data, and insights from THIS SECTION ONLY.
- Use bullet points and structured formatting
- Preserve important quotes and code snippets verbatim
- Do NOT write introductions or conclusions
- Focus on thorough extraction, not narrative flow`;

const MAX_OUTPUT = 5000;
const SUMMARIZE_THRESHOLD = 5000;
const CHUNK_THRESHOLD = 200_000;
const CHUNK_SIZE = 50_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function brBody(url: string, sessionId: string, extra?: Record<string, unknown>) {
  return {
    url,
    sessionId,
    keep_alive: SESSION_KEEP_ALIVE,
    rejectResourceTypes: REJECT_RESOURCES,
    bestAttempt: true,
    ...extra,
  };
}

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

type SearchReturn = { ok: boolean; engine: string; query: string; results: SearchResult[]; count: number };

// ─── SearXNG (self-hosted, ~500ms, unlimited) ──────────────────────────────

async function searchSearXNG(
  searxngUrl: string, query: string, count: number,
): Promise<SearchReturn | null> {
  const t0 = Date.now();
  try {
    const url = `${searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      console.warn(`[web] searxng failed: ${resp.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data = await resp.json<{ results?: Array<{ title: string; url: string; content?: string }> }>();
    const results: SearchResult[] = (data.results ?? []).slice(0, count).map(r => ({
      title: r.title, url: r.url, description: r.content ?? "",
    }));
    console.log(`[web] searxng: ${results.length} results (${Date.now() - t0}ms)`);
    if (results.length === 0) return null;
    return { ok: true, engine: "searxng", query, results, count: results.length };
  } catch (err) {
    console.error(`[web] searxng error (${Date.now() - t0}ms):`, err);
    return null;
  }
}

// ─── Brave Search API (free tier 2000/month, ~300ms) ────────────────────────

async function searchBraveAPI(
  apiKey: string, query: string, count: number,
): Promise<SearchReturn | null> {
  const t0 = Date.now();
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const resp = await fetch(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } });
    if (!resp.ok) {
      console.warn(`[web] brave-api failed: ${resp.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data = await resp.json<{ web?: { results?: Array<{ title: string; url: string; description?: string }> } }>();
    const results: SearchResult[] = (data.web?.results ?? []).slice(0, count).map(r => ({
      title: r.title, url: r.url, description: r.description ?? "",
    }));
    console.log(`[web] brave-api: ${results.length} results (${Date.now() - t0}ms)`);
    if (results.length === 0) return null;
    return { ok: true, engine: "brave-api", query, results, count: results.length };
  } catch (err) {
    console.error(`[web] brave-api error (${Date.now() - t0}ms):`, err);
    return null;
  }
}

// ─── Google/Brave via Browser Rendering /scrape (fast, no AI) ────────────────

async function searchViaScrape(
  accountId: string,
  headers: Record<string, string>,
  query: string,
  count: number,
  engine: "google" | "brave",
  sessionId: string,
): Promise<{ ok: boolean; engine: string; query: string; results: SearchResult[]; count: number } | null> {
  const t0 = Date.now();
  const searchUrl = engine === "google"
    ? `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=en`
    : `https://search.brave.com/search?q=${encodeURIComponent(query)}`;

  // Use /scrape with CSS selectors — much faster than /json (no AI inference)
  const selectors = engine === "google"
    ? [{ selector: "div.g" }]   // Google result blocks
    : [{ selector: ".snippet" }]; // Brave result blocks

  try {
    const resp = await fetch(`${BR_BASE}/${accountId}/browser-rendering/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: searchUrl,
        sessionId,
        keep_alive: SESSION_KEEP_ALIVE,
        elements: selectors,
        rejectResourceTypes: REJECT_RESOURCES,
        bestAttempt: true,
        gotoOptions: { waitUntil: "networkidle2" },
      }),
    });
    if (!resp.ok) {
      console.warn(`[web] ${engine} scrape failed: ${resp.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data = await resp.json<{
      success: boolean;
      result?: Array<{ results: Array<{ text?: string; html?: string; attributes?: Array<{ name: string; value: string }> }> }>;
    }>();
    const elements = data.result?.[0]?.results ?? [];
    const results: SearchResult[] = [];
    for (const el of elements) {
      if (results.length >= count) break;
      const text = el.text?.replace(/\s+/g, " ").trim() ?? "";
      // Extract URL from href in the HTML
      const hrefMatch = el.html?.match(/href="(https?:\/\/[^"]+)"/);
      const url = hrefMatch?.[1] ?? "";
      if (!url || !text) continue;
      // Split text into title (first line) and description (rest)
      const lines = text.split(/\n/).filter(Boolean);
      const title = lines[0] ?? text.slice(0, 100);
      const description = lines.slice(1).join(" ").slice(0, 300) || text.slice(0, 300);
      results.push({ title, url, description });
    }
    console.log(`[web] ${engine} scrape: ${results.length} results (${Date.now() - t0}ms)`);
    if (results.length === 0) return null;
    return { ok: true, engine, query, results, count: results.length };
  } catch (err) {
    console.error(`[web] ${engine} scrape error (${Date.now() - t0}ms):`, err);
    return null;
  }
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createWebTool(
  accountId: string,
  browserToken: string | undefined,
  ai?: Ai,
  searxngUrl?: string,
  braveApiKey?: string,
) {
  // Stable session ID — reuses the same Chromium instance across calls (3-5s vs 30s cold start)
  const sessionId = `clop-${accountId.slice(0, 12)}`;

  return {
    description:
      "All-in-one web tool: search the web, read URLs, extract data, scrape elements, list links, crawl sites.\n\n" +
      "Actions:\n" +
      "- 'search': search the web (fast — auto fallback chain).\n" +
      "  USE for weather, news, prices, facts, any real-world question.\n" +
      "- 'read': read a URL as markdown (auto-summarized for long pages).\n" +
      "- 'extract': AI-powered structured data extraction from a URL (pass prompt and/or schema).\n" +
      "- 'scrape': targeted CSS selector extraction.\n" +
      "- 'links': list all links on a page.\n" +
      "- 'crawl_start': start crawling a website (async). Returns a jobId.\n" +
      "- 'crawl_check': check crawl results by jobId.\n\n" +
      "NEVER guess or make up URLs, company info, or current events — search first.\n" +
      "Only use 'read' if search snippets don't contain enough detail for your answer.",
    inputSchema: z.object({
      action: z
        .enum(["search", "read", "extract", "scrape", "links", "crawl_start", "crawl_check"])
        .describe("Action to perform"),
      query: z.string().optional().describe("Search query (for 'search')"),
      url: z.string().optional().describe("URL (for read/extract/scrape/links/crawl_start)"),
      count: z.number().optional().default(5).describe("Number of search results (default 5, max 10)"),
      engine: z.string().optional()
        .describe("Ignored — search uses automatic fallback chain (SearXNG → Brave API → Browser Rendering)."),
      prompt: z.string().optional().describe("For 'extract': what data to extract"),
      schema: z.string().optional().describe("For 'extract': JSON schema string for structured output"),
      selector: z.string().optional().describe("For 'scrape': CSS selector (e.g. 'article', '.content', 'table')"),
      waitForSelector: z.string().optional().describe("CSS selector to wait for before capturing (SPAs)"),
      cacheTTL: z.number().optional().describe("Cache TTL in seconds (default 0, use 300 for stable pages)"),
      jobId: z.string().optional().describe("For 'crawl_check': job ID from crawl_start"),
      maxPages: z.number().optional().default(10).describe("For 'crawl_start': max pages (default 10, max 100)"),
      staticOnly: z.boolean().optional().describe("For 'crawl_start': skip browser rendering (faster for static HTML)"),
      includePattern: z.string().optional().describe("For 'crawl_start': URL pattern to include (e.g. '/docs/**')"),
      excludePattern: z.string().optional().describe("For 'crawl_start': URL pattern to exclude"),
    }),
    execute: async (params: {
      action: string;
      query?: string;
      url?: string;
      count?: number;
      engine?: string;
      prompt?: string;
      schema?: string;
      selector?: string;
      waitForSelector?: string;
      cacheTTL?: number;
      jobId?: string;
      maxPages?: number;
      staticOnly?: boolean;
      includePattern?: string;
      excludePattern?: string;
    }) => {
      if (!browserToken) {
        return { ok: false, error: "Browser not configured. Set CF_BROWSER_TOKEN secret." };
      }

      const headers = {
        Authorization: `Bearer ${browserToken}`,
        "Content-Type": "application/json",
      };

      const waitOpts: Record<string, unknown> = {};
      if (params.waitForSelector) {
        waitOpts.waitForSelector = { selector: params.waitForSelector, timeout: 10_000 };
      }
      const cacheQuery = params.cacheTTL ? `?cacheTTL=${params.cacheTTL}` : "";

      console.log(`[web] action=${params.action} query=${params.query ?? ""} url=${params.url ?? ""} engine=${params.engine ?? "auto"}`);

      switch (params.action) {
        // ─── SEARCH (SearXNG → Brave API → Browser Rendering fallback) ─
        case "search": {
          if (!params.query) return { ok: false, error: "query required for search" };
          const numResults = Math.min(params.count ?? 5, 10);

          // 1. SearXNG (self-hosted, ~500ms, unlimited)
          if (searxngUrl) {
            const sx = await searchSearXNG(searxngUrl, params.query, numResults);
            if (sx) return sx;
          }

          // 2. Brave Search API (free tier, ~300ms, 2000/month)
          if (braveApiKey) {
            const brave = await searchBraveAPI(braveApiKey, params.query, numResults);
            if (brave) return brave;
          }

          // 3. Browser Rendering /scrape (last resort, ~3-5s with session reuse)
          if (browserToken) {
            const scrape = await searchViaScrape(accountId, headers, params.query, numResults, "brave", sessionId);
            if (scrape) return scrape;
          }

          return { ok: false, error: `No results for "${params.query}". Configure SEARXNG_URL or BRAVE_API_KEY for fast search.` };
        }

        // ─── READ (URL → Markdown) ────────────────────────────────────────
        case "read": {
          if (!params.url) return { ok: false, error: "url required for read" };
          const resp = await fetch(
            `${BR_BASE}/${accountId}/browser-rendering/markdown${cacheQuery}`,
            { method: "POST", headers, body: JSON.stringify(brBody(params.url, sessionId, waitOpts)) },
          );
          if (!resp.ok) return { ok: false, error: `Browser API error: ${resp.status}` };
          const data = await resp.json<{ success: boolean; result: string }>();
          const raw = data.result ?? "";

          if (ai && raw.length > SUMMARIZE_THRESHOLD) {
            const summary = await summarizeContent(ai, raw, params.url);
            if (summary) {
              return { ok: true, url: params.url, content: summary, originalLength: raw.length, summarized: true };
            }
          }
          const content = raw.length > MAX_OUTPUT ? raw.slice(0, MAX_OUTPUT) + "\n\n[...truncated]" : raw;
          return { ok: true, url: params.url, content };
        }

        // ─── EXTRACT (AI structured extraction) ───────────────────────────
        case "extract": {
          if (!params.url) return { ok: false, error: "url required for extract" };
          const body: Record<string, unknown> = brBody(params.url, sessionId, waitOpts);
          if (params.prompt) body.prompt = params.prompt;
          if (params.schema) {
            try { body.response_format = { type: "json_schema", schema: JSON.parse(params.schema) }; }
            catch { return { ok: false, error: "Invalid JSON schema" }; }
          }
          const resp = await fetch(
            `${BR_BASE}/${accountId}/browser-rendering/json${cacheQuery}`,
            { method: "POST", headers, body: JSON.stringify(body) },
          );
          if (!resp.ok) return { ok: false, error: `Browser API error: ${resp.status}` };
          const data = await resp.json<{ success: boolean; result: unknown }>();
          return { ok: true, url: params.url, data: data.result };
        }

        // ─── SCRAPE (CSS selector) ────────────────────────────────────────
        case "scrape": {
          if (!params.url) return { ok: false, error: "url required for scrape" };
          if (!params.selector) return { ok: false, error: "selector required for scrape (CSS selector like 'article', '.content', 'table')" };
          const resp = await fetch(
            `${BR_BASE}/${accountId}/browser-rendering/scrape${cacheQuery}`,
            {
              method: "POST", headers,
              body: JSON.stringify(brBody(params.url, sessionId, { ...waitOpts, elements: [{ selector: params.selector }] })),
            },
          );
          if (!resp.ok) return { ok: false, error: `Browser API error: ${resp.status}` };
          const data = await resp.json<{
            success: boolean;
            result: Array<{ results: Array<{ text?: string; html?: string; attributes?: Array<{ name: string; value: string }>; width?: number; height?: number }> }>;
          }>();
          const elements = data.result?.[0]?.results ?? [];
          const scraped = elements.map((el) => ({ text: el.text?.slice(0, 2000), attributes: el.attributes }));
          return { ok: true, url: params.url, selector: params.selector, elements: scraped, count: scraped.length };
        }

        // ─── LINKS ────────────────────────────────────────────────────────
        case "links": {
          if (!params.url) return { ok: false, error: "url required for links" };
          const resp = await fetch(
            `${BR_BASE}/${accountId}/browser-rendering/links${cacheQuery}`,
            { method: "POST", headers, body: JSON.stringify(brBody(params.url, sessionId, waitOpts)) },
          );
          if (!resp.ok) return { ok: false, error: `Browser API error: ${resp.status}` };
          const data = await resp.json<{ success: boolean; result: Array<{ href: string; text: string }> }>();
          return { ok: true, url: params.url, links: data.result?.slice(0, 50) };
        }

        // ─── CRAWL START ──────────────────────────────────────────────────
        case "crawl_start": {
          if (!params.url) return { ok: false, error: "url required for crawl_start" };
          const body: Record<string, unknown> = {
            url: params.url,
            limit: Math.min(params.maxPages ?? 10, 100),
            scrapeOptions: { formats: ["markdown"] },
          };
          if (params.staticOnly) body.render = false;
          const options: Record<string, unknown> = {};
          if (params.includePattern) options.includePatterns = [params.includePattern];
          if (params.excludePattern) options.excludePatterns = [params.excludePattern];
          if (Object.keys(options).length > 0) body.options = options;

          const resp = await fetch(`${BR_BASE}/${accountId}/browser-rendering/crawl`, {
            method: "POST", headers, body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const err = await resp.text();
            return { ok: false, error: `Crawl API error: ${resp.status} ${err.slice(0, 200)}` };
          }
          const data = await resp.json<{ success: boolean; result?: { id: string } }>();
          if (!data.success || !data.result?.id) return { ok: false, error: "Crawl API returned no job ID" };
          return { ok: true, jobId: data.result.id, message: `Crawl started for ${params.url}. Use action:'crawl_check' with this jobId to get results.` };
        }

        // ─── CRAWL CHECK ──────────────────────────────────────────────────
        case "crawl_check": {
          if (!params.jobId) return { ok: false, error: "jobId required for crawl_check" };
          const safeJobId = params.jobId.replace(/[^a-zA-Z0-9_-]/g, "");
          if (!safeJobId) return { ok: false, error: "invalid jobId" };

          const resp = await fetch(`${BR_BASE}/${accountId}/browser-rendering/crawl/${safeJobId}`, { headers });
          if (!resp.ok) return { ok: false, error: `Crawl check error: ${resp.status}` };
          const data = await resp.json<{
            success: boolean;
            result?: { status: string; pages?: Array<{ url: string; status: string; markdown?: string }> };
          }>();
          if (!data.success || !data.result) return { ok: false, error: "No crawl results" };
          const { status, pages } = data.result;

          if (status === "running") {
            const completed = pages?.filter(p => p.status === "completed").length ?? 0;
            return { ok: true, status: "running", progress: `${completed}/${pages?.length ?? 0} pages completed` };
          }
          const completedPages = (pages ?? [])
            .filter(p => p.status === "completed" && p.markdown)
            .map(p => ({ url: p.url, content: (p.markdown ?? "").slice(0, 3000) }));
          return { ok: true, status, totalPages: pages?.length ?? 0, completedPages: completedPages.length, pages: completedPages.slice(0, 20) };
        }

        default:
          return { ok: false, error: `Unknown action: ${params.action}. Use: search, read, extract, scrape, links, crawl_start, crawl_check` };
      }
    },
  };
}

// ─── LLM Content Summarization ────────────────────────────────────────────────

async function summarizeContent(ai: Ai, content: string, url: string): Promise<string | null> {
  try {
    const workersai = createWorkersAI({ binding: ai });
    const model = workersai(AUXILIARY_MODEL);

    if (content.length > CHUNK_THRESHOLD) {
      return await summarizeChunked(model, content, url);
    }

    const { text } = await generateText({
      model, system: SUMMARIZE_SYSTEM,
      prompt: `Source: ${url}\n\nCONTENT:\n${content.slice(0, 150_000)}`,
      maxRetries: 1,
    });
    if (!text) return null;
    return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n\n[...summary truncated]" : text;
  } catch { return null; }
}

async function summarizeChunked(
  model: ReturnType<ReturnType<typeof createWorkersAI>>,
  content: string, url: string,
): Promise<string | null> {
  const chunks: string[] = [];
  for (let i = 0; i < content.length && chunks.length < 4; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }
  const summaries = await Promise.all(
    chunks.map(async (chunk, i) => {
      try {
        const { text } = await generateText({
          model, system: CHUNK_SYSTEM,
          prompt: `Source: ${url} [Section ${i + 1}/${chunks.length}]\n\nSECTION CONTENT:\n${chunk}`,
          maxRetries: 1,
        });
        return text || null;
      } catch { return null; }
    }),
  );
  const valid = summaries.filter(Boolean) as string[];
  if (valid.length === 0) return null;
  try {
    const { text } = await generateText({
      model,
      system: "Synthesize these section summaries into ONE cohesive markdown summary. Remove redundancy, preserve all key facts. Max 1200 words.",
      prompt: `Source: ${url}\n\n${valid.map((s, i) => `## Section ${i + 1}\n${s}`).join("\n\n---\n\n")}`,
      maxRetries: 1,
    });
    if (!text) return valid.join("\n\n---\n\n").slice(0, MAX_OUTPUT);
    return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n\n[...summary truncated]" : text;
  } catch { return valid.join("\n\n---\n\n").slice(0, MAX_OUTPUT); }
}
