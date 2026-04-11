import { z } from "zod";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { LanguageModel } from "ai";
import type { SqlFn } from "../config/sql.js";
import { createMemoryTool } from "./memory-tool.js";
import { createSessionSearchTool } from "./session-search-tool.js";
import { createSkillsTool } from "./skills-tool.js";
import { createTodoTool } from "./todo-tool.js";
import { createWebTool } from "./web-tool.js";
import { createDocsTool } from "./docs-tool.js";
import { createBrowserTool } from "./browser-tool.js";
import { createClarifyTool } from "./clarify-tool.js";
import { createTtsTool } from "./tts-tool.js";
import { createImageGenTool } from "./image-gen-tool.js";
import { createNoteTool } from "./note-tool.js";
import { createCalendarTool } from "./calendar-tool.js";
import { createDelegateTool } from "./delegate-tool.js";
import { trackAuxiliaryUsage, type BackgroundTask } from "../pipeline.js";

/**
 * Tool context passed from the agent to each tool factory.
 *
 * `auxModel` / `auxModelId` are pre-built by the pipeline via `createAuxiliaryModel`
 * and routed to tools that need an LLM (web summarization, browser snapshots,
 * tts, image generation). This is the only way for these features to remain
 * BYOK-correct — they never touch `ai` (the raw Workers AI binding) directly.
 */
export interface ToolContext {
  sql: SqlFn;
  r2Memories: R2Bucket;
  r2Skills: R2Bucket;
  ai: Ai;
  /** Pre-built auxiliary LLM (BYOK-aware). Optional for callers (e.g. delegates) that build their own. */
  auxModel?: LanguageModel;
  /** Model id used for usage tracking when `auxModel` runs. */
  auxModelId?: string;
  userId: string;
  sessionId: string;
  env: { GATEWAY_URL?: string; GATEWAY_INTERNAL_KEY?: string; WS_SIGNING_SECRET: string };
  queueTask?: (task: BackgroundTask) => void;
  cfAccountId: string;
  cfBrowserToken?: string;
  searxngUrl?: string;
  braveApiKey?: string;
  loader?: WorkerLoader;
  globalOutbound?: Fetcher;
  playwrightMcp?: DurableObjectNamespace;
  platform?: import("../config/types.js").Platform;
}

function createUsageTracker(ctx: ToolContext) {
  return (tokensIn: number, tokensOut: number, model: string) => {
    trackAuxiliaryUsage(
      ctx.sql, ctx.sessionId, tokensIn, tokensOut,
      model, ctx.env as Env, ctx.userId,
    );
  };
}

/**
 * Build the full tool set for streamText().
 *
 * 12 primary tools + backward-compat aliases for old names.
 * Aliases prevent hard failures when an LLM hallucinates old names.
 */
export function buildTools(ctx: ToolContext) {
  const memoryTool = createMemoryTool(ctx);
  const historyTool = createSessionSearchTool(ctx);
  const docsTool = createDocsTool(ctx);
  const notesTool = createNoteTool(ctx);
  const webTool = createWebTool(ctx.cfAccountId, ctx.cfBrowserToken, ctx.auxModel, ctx.searxngUrl, ctx.braveApiKey);
  const ttsTool = createTtsTool(ctx.ai, ctx.r2Memories, ctx.userId, createUsageTracker(ctx));
  const imageTool = createImageGenTool(ctx.ai, ctx.r2Memories, ctx.userId, createUsageTracker(ctx));

  return {
    // ── Primary names ───────────────────────────────────────────────────
    memory: memoryTool,
    history: historyTool,
    skills: createSkillsTool(ctx),
    todo: createTodoTool(ctx),
    docs: docsTool,
    web: webTool,
    notes: notesTool,
    calendar: createCalendarTool(ctx),
    tts: ttsTool,
    image: imageTool,
    clarify: createClarifyTool(),
    ...(ctx.playwrightMcp ? { browser: createBrowserTool(ctx) } : {}),
    ...((ctx.env as Env).DELEGATE_WORKFLOW ? { delegate: createDelegateTool(ctx) } : {}),

    // ── Backward-compat aliases (old names → new tools) ─────────────────
    session_search: historyTool,
    save_note: notesTool,
    note: notesTool,
    text_to_speech: ttsTool,
    image_generate: imageTool,
    web_search: webTool,
    web_browse: webTool,
    web_crawl: webTool,
    docs_search: docsTool,
    ai_search: docsTool,
    search_docs: docsTool,
    doc_search: docsTool,
    search_sessions: historyTool,
    memory_search: historyTool,
    aisearch: docsTool,
    search_web: webTool,
    search: webTool,
  };
}

/**
 * Resolve tools for streamText().
 *
 * If LOADER binding is available → codemode: wraps orchestration tools into a single
 * "codemode" tool. The LLM writes JS/TS code that orchestrates tools directly
 * (if/else, loops, Promise.all), saving up to 80% tokens.
 *
 * If LOADER is absent → returns all individual tools (classic mode).
 */
export function resolveTools(ctx: ToolContext) {
  const allTools = buildTools(ctx);

  if (!ctx.loader) return allTools;

  // Separate direct tools from orchestration tools.
  const {
    web,                                 // web search/read — must be direct
    docs,                                // document search — must be direct
    image, tts, clarify,                 // media/UX actions — must be direct
    notes, note, save_note,              // user-facing side effects — must be direct
    calendar,                            // user-facing side effects — must be direct
    delegate,                             // delegation — must be direct (not in sandbox)
    // All backward-compat aliases — strip from codemode namespace
    session_search, text_to_speech, image_generate,
    web_search, web_browse, web_crawl, docs_search, ai_search,
    search_docs, doc_search, search_sessions, memory_search, aisearch, search_web, search,
    ...orchestrationTools
  } = allTools;

  const executor = new DynamicWorkerExecutor({
    loader: ctx.loader,
    globalOutbound: ctx.globalOutbound ?? null,
  });
  const codemode = createCodeTool({ tools: orchestrationTools, executor });

  return {
    codemode,
    web,
    docs,
    image,
    tts,
    clarify,
    notes,
    calendar,
    ...(delegate ? { delegate } : {}),
  };
}

export { z };
