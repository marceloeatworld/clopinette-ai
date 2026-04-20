import {
  streamText,
  generateText,
  pruneMessages,
  stepCountIs,
} from "ai";
import type { ModelMessage } from "ai";
import type { SqlFn } from "./config/sql.js";
import type { InferenceConfig, Platform, MediaAsset } from "./config/types.js";
import { prepareImageForVision, mediaToContentParts } from "./media/vision.js";
import { transcribeAudio } from "./media/transcribe.js";
import { ingestSummary } from "./media/ingest.js";
import { saveTranscript, updateContext, savePdfTranscript } from "./media/handler.js";
import {
  MAX_STEPS, DEFAULT_AGENT_IDENTITY,
  WHISPER_TOKENS_PER_KB,
} from "./config/constants.js";
import { buildCurrentContextBlock, buildSystemPrompt } from "./prompt-builder.js";
import { getHonchoContext } from "./memory/honcho.js";
import { mirrorMessage, type MirrorVectorCtx } from "./memory/session-search.js";
import type { LanguageModel } from "ai";
import { compressContext } from "./compression.js";
import { resolveTools, buildTools } from "./tools/registry.js";
import { loadServiceTokens } from "./tools/credential-fetcher.js";
import {
  createModel,
  createAuxiliaryModel,
  loadInferenceConfig,
  loadFallbackConfig,
  PlanViolationError,
  type Plan,
} from "./inference/provider.js";
import { isAnthropicProvider, applyCacheControl } from "./inference/prompt-caching.js";
import { routeModel } from "./inference/router.js";
import { classifyError } from "./inference/error-classifier.js";
import { redact } from "./enterprise/redact.js";
import { checkBudget } from "./enterprise/budget.js";
import { logAudit } from "./enterprise/audit.js";
import { buildToolSummaryContext } from "./tool-summary.js";
import {
  runSelfLearningReview,
  buildConversationSummary,
  REVIEW_INTERVAL,
  MIN_TURNS_BEFORE_REVIEW,
} from "./memory/self-learning.js";

// ───────────────────────── Pipeline Context ─────────────────────────

/**
 * Gateway-agnostic context for the inference pipeline.
 * Each gateway (WebSocket, Telegram, Slack, cron) builds this from its own state.
 */
export interface PipelineContext {
  // Identity
  platform: Platform;
  userId: string;
  sessionId: string;
  /** Chat id for non-WS platforms — propagated to ToolContext so `delegate` can persist
   *  it on `pending_delegates` for the auto-resume push. */
  chatId?: string;
  /** User's billing plan — drives BYOK enforcement (no Workers AI fallback for BYOK). */
  plan?: Plan;

  // Dependencies
  sql: SqlFn;
  env: Env;

  // Messages (already in ModelMessage format)
  messages: ModelMessage[];
  userText: string;

  // Media (images, voice, docs — processed by media/ modules before reaching pipeline)
  mediaAssets?: MediaAsset[];

  // Gateway controls
  abortSignal?: AbortSignal;
  enableCodemode?: boolean;      // default: false
  enableCompression?: boolean;   // default: true
  enableSelfLearning?: boolean;  // default: true
  sharedMode?: boolean;          // group without owner's memory (skip MEMORY.md/USER.md)
  recentToolUse?: number;        // for smart routing (0 = no recent tools)

  // Performance: session-level caches (set by the DO, reused across turns)
  // Keeps the system prompt identical between turns for prefix caching (83% token cost savings)
  cachedSystemPrompt?: string | null;
  cachedInferenceConfig?: InferenceConfig | null;
  /** Called to store the system prompt after first build */
  onCacheSystemPrompt?: (prompt: string) => void;
  /** Called to store the inference config after first load */
  onCacheInferenceConfig?: (config: InferenceConfig) => void;

  // Callbacks (gateway-specific side effects)
  onStateChange?: (status: "thinking" | "streaming" | "idle") => void;
  onComplete?: (result: { text: string; usage?: PipelineUsage; mediaDelivery?: MediaDelivery[] }) => void;
  /** DO `ctx.waitUntil` — keeps fire-and-forget promises alive past the request lifecycle. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Queue a background task that survives DO hibernation. Falls back to fire-and-forget if not provided. */
  queueTask?: (task: BackgroundTask) => void;
  /** Request structured input from the user mid-tool-execution. Returns null if not supported. */
  elicitInput?: (params: ElicitParams) => Promise<ElicitResult>;
  /** Called each time a tool starts executing — used for live progress messages on Telegram. */
  onToolProgress?: (toolName: string, preview: string) => void;
}

// ───────────────────────── Elicitation ─────────────────────────

export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

export interface ElicitParams {
  message: string;
  schema?: {
    type: "object";
    properties: Record<string, {
      type: "string" | "boolean" | "number" | "integer";
      title?: string;
      description?: string;
      default?: unknown;
      format?: "email" | "uri" | "date" | "password";
      enum?: string[];
      minimum?: number;
      maximum?: number;
    }>;
    required?: string[];
  };
}

// ───────────────────────── Background Task Types ─────────────────────────

/**
 * Background tasks executed by the DO scheduler (survives hibernation).
 * Note: usage reports go through `env.USAGE_QUEUE` now, not this queue.
 */
export type BackgroundTask =
  | { type: "selfLearning"; summary: string; userId: string; sessionId: string; options: { reviewMemory: boolean; reviewSkills: boolean } }
  | { type: "r2ContextUpdate"; r2Key: string; context: string }
  | { type: "delegateResume"; sessionId: string; platform: string | null; chatId: string | null };

export interface PipelineUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  sessionId: string;
}

export interface MediaDelivery {
  type: "audio" | "image";
  r2Key: string;
  format: string;
}

export interface PipelineResultGenerate {
  mode: "generate";
  text: string;
  usage?: PipelineUsage;
  mediaDelivery?: MediaDelivery[];
  toolTrace?: string[];
}

export interface PipelineResultStream {
  mode: "stream";
  stream: ReturnType<typeof streamText>;
}

export type PipelineResult = PipelineResultGenerate | PipelineResultStream;

/** Build the shared MirrorVectorCtx from a PipelineContext — returns undefined if the DO hasn't provided waitUntil. */
function buildVectorCtx(ctx: PipelineContext): MirrorVectorCtx | undefined {
  if (!ctx.waitUntil || !ctx.env.VECTORS) return undefined;
  return {
    ai: ctx.env.AI,
    vectors: ctx.env.VECTORS,
    userId: ctx.userId,
    waitUntil: ctx.waitUntil,
  };
}

// ───────────────────────── Text file detection ─────────────────────────

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/json", "application/xml", "text/xml",
  "application/yaml", "text/yaml",
]);

const NO_RESPONSE_FALLBACK = "I couldn't generate a final answer. Please try again.";
const TOOL_ONLY_RESPONSE_FALLBACK = "I found information but couldn't finish the final reply. Please try again.";
const STEP_LIMIT_RESPONSE_FALLBACK = "I couldn't finish the answer before reaching the tool budget. Please try again.";

async function synthesizeToolOnlyResponse(
  model: LanguageModel,
  userText: string,
  toolContext: string,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const summaryResult = await generateText({
    model,
    system: "You are writing the final assistant reply after tool calls. Answer the user's request directly using the tool results below. Be concise, factual, and natural. If the results are incomplete, state what is known and what remains uncertain. Do not mention internal tools or say that you are summarizing.",
    messages: [
      {
        role: "user" as const,
        content: `User request: ${userText}\n\nTool results:\n${toolContext}\n\nWrite the final answer you should send to the user now.`,
      },
    ],
    maxRetries: 1,
  });

  return {
    text: summaryResult.text?.trim() || "",
    tokensIn: summaryResult.usage?.inputTokens ?? 0,
    tokensOut: summaryResult.usage?.outputTokens ?? 0,
  };
}

// Telegram often sends .md/.txt/.json as "application/octet-stream"
// so we also check the file extension
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".html", ".htm",
  ".json", ".xml", ".yaml", ".yml", ".log", ".ini", ".cfg",
  ".toml", ".env", ".sh", ".bash", ".zsh", ".py", ".js", ".ts",
  ".jsx", ".tsx", ".css", ".scss", ".sql", ".r", ".rb", ".go",
  ".rs", ".c", ".cpp", ".h", ".hpp", ".java", ".kt", ".swift",
]);

function isTextReadable(mime: string | undefined, filename: string | undefined): boolean {
  if (mime && (TEXT_MIMES.has(mime) || mime.startsWith("text/"))) return true;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function isDocx(mime: string | undefined, filename: string | undefined): boolean {
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  return !!filename?.toLowerCase().endsWith(".docx");
}

function isXlsx(mime: string | undefined, filename: string | undefined): boolean {
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return true;
  return !!filename?.toLowerCase().endsWith(".xlsx");
}

/** Cap extracted text to avoid blowing up the context window */
const MAX_INJECTED_CHARS = 20_000;

function capText(text: string, filename: string): string {
  if (text.length <= MAX_INJECTED_CHARS) return text;
  return text.slice(0, MAX_INJECTED_CHARS) + `\n\n[...truncated — ${filename} is ${(text.length / 1024).toFixed(0)}KB, showing first ${(MAX_INJECTED_CHARS / 1024).toFixed(0)}KB]`;
}

// ───────────────────────── Persistent turn counter (DO SQLite) ─────────────────────────

/**
 * Turn counter persisted in SQLite — survives DO hibernation/cold starts.
 * The old in-memory Map would reset to 0 on every cold start, meaning
 * self-learning reviews never fired for users with < 6 messages per session.
 */
function incrementTurn(sql: SqlFn): number {
  // Upsert: create or increment. Per-user scoping is handled by the DO itself.
  sql`INSERT INTO agent_config (key, value, encrypted, updated_at)
    VALUES ('_turn_count', '1', 0, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = datetime('now')`;
  const rows = sql<{ value: string }>`SELECT value FROM agent_config WHERE key = '_turn_count'`;
  return parseInt(rows[0]?.value ?? "0", 10);
}

// ───────────────────────── Tool Enhancements (Hermes-style) ─────────────────────────

type ToolLike = { description: string; inputSchema: unknown; execute: (args: unknown) => Promise<unknown> };

/** Per-result spillover threshold: results larger than this land in R2. */
const SPILL_THRESHOLD_BYTES = 20_000;
/** Preview length for spilled results — enough for the LLM to decide whether to read the full file. */
const SPILL_PREVIEW_CHARS = 800;

export interface SpillContext {
  r2: R2Bucket;
  userId: string;
  sessionId: string;
}

function enqueueUsageReport(
  env: Env,
  message: {
    userId: string;
    tokensIn: number;
    tokensOut: number;
    model: string;
    sessionId: string;
    timestamp: number;
  },
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const sendPromise = env.USAGE_QUEUE.send(message).catch((err) => {
    console.warn("Failed to enqueue usage report:", err);
  });
  if (waitUntil) {
    waitUntil(sendPromise);
  } else {
    void sendPromise;
  }
}

function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * If the tool result is too large to safely return inline, persist it to R2
 * under `${userId}/spillover/${sessionId}/...` and return a preview + r2Key
 * that the LLM can re-open via `docs({ action: "read_spillover", r2Key })`.
 *
 * This prevents silent context overflow on large crawls, greps, and search
 * results while keeping the full data accessible on demand.
 */
async function maybeSpillResult(
  name: string,
  result: unknown,
  spill: SpillContext,
): Promise<unknown> {
  if (result === null || result === undefined) return result;
  let serialized: string;
  try {
    serialized = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return result;
  }
  if (serialized.length <= SPILL_THRESHOLD_BYTES) return result;

  const safeUserId = sanitizeForPath(spill.userId);
  const safeSessionId = sanitizeForPath(spill.sessionId);
  const safeName = sanitizeForPath(name);
  const r2Key = `${safeUserId}/spillover/${safeSessionId}/${Date.now()}-${safeName}.json`;

  try {
    await spill.r2.put(r2Key, serialized, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { tool: name, sessionId: spill.sessionId, spilledAt: String(Date.now()) },
    });
  } catch (err) {
    // R2 write failed — return a truncated version so the turn can continue
    console.warn(`[spill] r2 put failed for ${name}:`, err instanceof Error ? err.message : String(err));
    return {
      _truncated: true,
      _tool: name,
      _originalBytes: serialized.length,
      preview: serialized.slice(0, SPILL_PREVIEW_CHARS),
    };
  }

  return {
    _spilled: true,
    _tool: name,
    r2Key,
    preview: serialized.slice(0, SPILL_PREVIEW_CHARS),
    fullSizeBytes: serialized.length,
    instruction: `Full tool result (${serialized.length} bytes) saved to R2. If the preview is insufficient, call docs({ action: "read_spillover", r2Key: "${r2Key}" }) to retrieve it.`,
  };
}

/**
 * Enhance tools with four Hermes-inspired upgrades:
 * 1. Budget pressure: inject _budget warnings at 70%/90% of MAX_STEPS
 * 2. Dedup: skip duplicate tool calls (same name+args within 2s window)
 * 3. Fuzzy matching: Proxy-based correction for hallucinated tool names
 * 4. Oversized result spillover to R2 (prevents silent context overflow)
 */
function enhanceTools(
  tools: Record<string, unknown>,
  maxSteps: number,
  getStep: () => number,
  onToolProgress?: (toolName: string, preview: string) => void,
  spillCtx?: SpillContext,
): Record<string, unknown> {
  // Dedup cache: key → { result, timestamp }
  const dedupCache = new Map<string, { result: unknown; ts: number }>();
  const DEDUP_TTL = 2000; // 2 seconds

  // Wrap each tool with budget pressure + dedup + spillover
  const enhanced = Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const t = tool as ToolLike;
      return [name, {
        ...t,
        execute: async (args: unknown) => {
          // Dedup: same tool+args within 2s → return cached
          const dedupKey = `${name}:${JSON.stringify(args)}`;
          const cached = dedupCache.get(dedupKey);
          if (cached && Date.now() - cached.ts < DEDUP_TTL) {
            return cached.result;
          }

          // Fire progress callback before execution
          if (onToolProgress) {
            const a = args as Record<string, unknown> | null;
            const preview = a?.query ?? a?.action ?? a?.url ?? a?.text ?? "";
            onToolProgress(name, String(preview).slice(0, 80));
          }

          let result = await t.execute(args);

          // Spill oversized results to R2 before caching / returning
          if (spillCtx) {
            result = await maybeSpillResult(name, result, spillCtx);
          }

          // Cache for dedup
          dedupCache.set(dedupKey, { result, ts: Date.now() });

          // Budget pressure (Hermes-style: caution at 70%, warning at 90%)
          const pct = getStep() / maxSteps;
          if (typeof result === "object" && result !== null) {
            if (pct >= 0.9) {
              return { ...result, _budget: "CRITICAL: 90% of tool budget used. Provide your FINAL answer NOW. No more tool calls unless absolutely critical." };
            }
            if (pct >= 0.7) {
              return { ...result, _budget: "CAUTION: 70% of tool budget used. Start consolidating your work." };
            }
          }
          return result;
        },
      }];
    }),
  );

  // Fuzzy matching via Proxy — corrects hallucinated tool names at dispatch time.
  // Object.keys() still returns canonical names only (no schema pollution).
  return new Proxy(enhanced, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop in target) return target[prop];
      // Normalize: lowercase, hyphens/spaces → underscores
      const normalized = prop.toLowerCase().replace(/[-\s]/g, "_");
      if (normalized in target) return target[normalized];
      // Levenshtein fuzzy match (distance ≤ 2)
      const match = closestToolName(normalized, Object.keys(target));
      if (match) return target[match];
      return undefined;
    },
    has(target, prop) {
      if (prop in target) return true;
      if (typeof prop !== "string") return false;
      const normalized = prop.toLowerCase().replace(/[-\s]/g, "_");
      if (normalized in target) return true;
      return !!closestToolName(normalized, Object.keys(target));
    },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  });
}

/** Levenshtein distance — O(n*m) but names are short (<30 chars). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/** Find closest tool name with Levenshtein distance ≤ 2. Requires min 4 chars to avoid false matches. */
function closestToolName(input: string, names: string[]): string | null {
  if (input.length < 4) return null; // Too short — "go" matching "todo" would be wrong
  let best: string | null = null;
  let bestDist = 3; // max allowed distance
  for (const name of names) {
    const d = levenshtein(input, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

// Backward compat alias
const wrapToolsWithBudget = enhanceTools;

// ───────────────────────── The Pipeline ─────────────────────────

/**
 * Unified inference pipeline.
 * Called by all gateways — WebSocket, Telegram, cron, future Slack/WhatsApp.
 *
 * 10 steps:
 * 1. Budget check
 * 2. Load inference config (model, provider, API key)
 * 3. Smart model routing (cheap model for greetings)
 * 4. Create model with session affinity
 * 5. Honcho context (optional external context)
 * 6. Build system prompt
 * 7. Context compression (optional, for long conversations)
 * 8. Build tools (codemode or classic)
 * 9. LLM call (stream or generate)
 * 10. Post-processing (mirror, tokens, gateway report, self-learning)
 */
export async function runPipeline(
  ctx: PipelineContext,
  mode: "stream" | "generate"
): Promise<PipelineResult | { error: string; status: number }> {
  ctx.onStateChange?.("thinking");

  // Step 1: Load inference config (cached per session — no SQL query per turn).
  // Plan-aware: BYOK users that haven't configured a real provider get a clean
  // PlanViolationError here, before any token is spent.
  let config: InferenceConfig;
  let auxiliary: { model: LanguageModel; modelId: string };
  let model: LanguageModel;
  try {
    if (ctx.cachedInferenceConfig) {
      config = ctx.cachedInferenceConfig;
    } else {
      config = await loadInferenceConfig(ctx.sql, ctx.env.MASTER_KEY, ctx.plan);
      ctx.onCacheInferenceConfig?.(config);
    }

    // Step 2: Smart model routing (runs BEFORE budget check for fast path)
    const routing = routeModel(
      ctx.userText,
      config.model,
      config.auxiliaryModel,
      ctx.recentToolUse ?? 0,
    );

    // Step 3: Build the auxiliary model ONCE — used by compression, self-learning,
    // web summarization, browser snapshots, and the simple-routing fast path.
    // For BYOK this routes to the user's BYOK provider; for trial/pro it lands on Gemma.
    auxiliary = createAuxiliaryModel(config, ctx.env, ctx.plan, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      platform: ctx.platform,
      purpose: "auxiliary",
    });

    // Step 4: Create the primary model with session affinity.
    // For the simple/auxiliary branch we reuse the pre-built auxiliary model
    // (which already has the right credentials).
    if (routing.reason === "simple") {
      model = auxiliary.model;
    } else {
      model = createModel(config, ctx.env, routing.model, {
        sessionAffinity: ctx.userId,
        plan: ctx.plan,
        telemetry: {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          platform: ctx.platform,
          purpose: "primary",
        },
      });
    }

    // Hand-off to the rest of the pipeline via a closure variable. We collected
    // routing here so the fast path below can read it.
    return await runPipelineInner(ctx, mode, config, model, auxiliary, routing);
  } catch (err) {
    if (err instanceof PlanViolationError) {
      ctx.onStateChange?.("idle");
      return { error: err.message, status: 402 };
    }
    throw err;
  }
}

async function runPipelineInner(
  ctx: PipelineContext,
  mode: "stream" | "generate",
  config: InferenceConfig,
  model: LanguageModel,
  auxiliary: { model: LanguageModel; modelId: string },
  routing: ReturnType<typeof routeModel>,
): Promise<PipelineResult | { error: string; status: number }> {

  // Fast path: simple messages skip history, tools, honcho, compression
  // Still checks budget to prevent billing bypass via greetings
  if (routing.reason === "simple") {
    const fastBudget = checkBudget(ctx.sql);
    if (fastBudget.exceeded) {
      const msg = "Monthly token budget exceeded. Please wait for reset or increase your budget.";
      ctx.onStateChange?.("idle");
      return mode === "stream"
        ? { mode: "stream", stream: new ReadableStream() } as unknown as PipelineResultStream
        : { mode: "generate", text: msg } as PipelineResultGenerate;
    }
    // Use cached system prompt if available, otherwise load soul + personality from SQLite
    let fastPrompt = ctx.cachedSystemPrompt;
    if (!fastPrompt) {
      const soulRows = ctx.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'soul_md'`;
      const soul = soulRows[0]?.value;
      fastPrompt = soul ? `${DEFAULT_AGENT_IDENTITY}\n\n${soul}` : DEFAULT_AGENT_IDENTITY;
      // Also load personality preset (was missing — caused personality to be ignored on fast path)
      const personalityRows = ctx.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'personality'`;
      if (personalityRows.length > 0 && personalityRows[0].value) {
        const { PERSONALITIES } = await import("./config/personalities.js");
        const preset = PERSONALITIES[personalityRows[0].value];
        if (preset) fastPrompt += `\n\n${preset}`;
      }
      fastPrompt += `\n\n${buildCurrentContextBlock(ctx.platform)}`;
    }
    mirrorMessage(ctx.sql, ctx.sessionId, "user", ctx.userText, undefined, undefined, buildVectorCtx(ctx));
    ctx.onStateChange?.("streaming");

    // Fast path uses cheap model but KEEPS conversation history (like Hermes smart routing)
    const fastMessages = ctx.messages.length > 0 ? ctx.messages : [{ role: "user" as const, content: ctx.userText }];

    if (mode === "stream") {
      const result = streamText({
        abortSignal: ctx.abortSignal,
        model,
        system: fastPrompt,
        messages: fastMessages,
        onFinish: async ({ text, usage }) => {
          const fastConfig = { ...config, model: routing.model };
          afterInference(ctx, fastConfig, text, usage, auxiliary);
          ctx.onComplete?.({
            text,
            usage: usage ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              model: routing.model,
              sessionId: ctx.sessionId,
            } : undefined,
          });
        },
      });
      return { mode: "stream", stream: result };
    }

    const result = await generateText({
      model,
      system: fastPrompt,
      messages: fastMessages,
      maxRetries: 1,
    });
    const text = result.text?.trim() || NO_RESPONSE_FALLBACK;
    // Use routing.model (AUXILIARY) not config.model (primary) for correct usage attribution
    const fastConfig = { ...config, model: routing.model };
    afterInference(ctx, fastConfig, text, result.usage, auxiliary);
    const fastUsage = result.usage ? { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0, model: routing.model, sessionId: ctx.sessionId } : undefined;
    ctx.onComplete?.({ text, usage: fastUsage });
    ctx.onStateChange?.("idle");
    return { mode: "generate", text, usage: fastUsage };
  }

  // Step 4: Budget check (skipped on fast path for simple messages)
  const budget = checkBudget(ctx.sql);
  if (budget.exceeded) {
    logAudit(ctx.sql, "budget.exceeded");
    ctx.onStateChange?.("idle");
    return { error: "Monthly token budget exceeded", status: 429 };
  }

  // Step 5: Honcho context (opt-in)
  let honchoContext: string | null = null;
  if (!ctx.cachedSystemPrompt) {
    const honchoRows = ctx.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config WHERE key IN ('honcho_base_url','honcho_api_key','honcho_app_id')
    `;
    if (honchoRows.length === 3) {
      const hMap = new Map(honchoRows.map((r) => [r.key, r.value]));
      try {
        const hCtx = await getHonchoContext(
          { baseUrl: hMap.get("honcho_base_url")!, apiKey: hMap.get("honcho_api_key")!, appId: hMap.get("honcho_app_id")! },
          ctx.userId,
          ctx.sessionId,
          ctx.userText
        );
        honchoContext = hCtx?.content ?? null;
      } catch { /* non-fatal */ }
    }
  }

  // Step 6: Build system prompt (cached per session for prefix caching — 83% token savings)
  // The prompt is frozen at session start. Memory writes update disk but NOT the prompt.
  // This keeps the system prompt identical across turns, maximizing Workers AI prefix cache hits.
  const codemodeEnabled = ctx.enableCodemode ?? false;
  let systemPrompt: string;
  if (ctx.cachedSystemPrompt) {
    systemPrompt = ctx.cachedSystemPrompt;
  } else {
    systemPrompt = await buildSystemPrompt({
      platform: ctx.platform,
      sql: ctx.sql,
      env: ctx.env,
      r2Memories: ctx.env.MEMORIES,
      userId: ctx.userId,
      honchoContext,
      codemodeEnabled,
      sharedMode: ctx.sharedMode,
      modelId: config.model,
    });
    ctx.onCacheSystemPrompt?.(systemPrompt);
  }

  // Step 7: Context compression (optional). Uses the pre-built auxiliary model so
  // BYOK users compress against their own provider, never against our Workers AI.
  let messages = ctx.messages;
  let didCompress = false;
  if (ctx.enableCompression !== false && messages.length > 40) {
    const compression = await compressContext(messages, auxiliary.model, ctx.sql, ctx.env.MEMORIES, ctx.userId);
    if (compression) {
      messages = compression.compressed;
      didCompress = true;
      trackAuxiliaryUsage(
        ctx.sql, ctx.sessionId, compression.auxTokensIn, compression.auxTokensOut,
        auxiliary.modelId, ctx.env, ctx.userId, ctx.waitUntil,
      );
    }
  }
  // Only prune if compression did NOT just run (compression already produces a minimal array)
  if (!didCompress && messages.length > 10) {
    messages = pruneMessages({ messages, toolCalls: "before-last-2-messages" });
  }

  // Step 8: Build tools
  // Load + decrypt the user's service tokens once per turn so codemode's
  // outbound proxy can inject Authorization headers for services like GitHub.
  // Loaded only when codemode is enabled — classic-mode tools don't use them.
  const serviceTokens = codemodeEnabled
    ? await loadServiceTokens(ctx.sql, ctx.env.MASTER_KEY)
    : undefined;

  const toolCtx = {
    sql: ctx.sql,
    r2Memories: ctx.env.MEMORIES,
    r2Skills: ctx.env.SKILLS,
    ai: ctx.env.AI,
    auxModel: auxiliary.model,
    auxModelId: auxiliary.modelId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    env: ctx.env,
    waitUntil: ctx.waitUntil,
    queueTask: ctx.queueTask,
    cfAccountId: ctx.env.CF_ACCOUNT_ID,
    cfBrowserToken: ctx.env.CF_BROWSER_TOKEN,
    searxngUrl: ctx.env.SEARXNG_URL,
    braveApiKey: ctx.env.BRAVE_API_KEY,
    loader: codemodeEnabled ? ctx.env.LOADER : undefined,
    globalOutbound: codemodeEnabled ? ctx.env.CODEMODE_OUTBOUND : undefined,
    serviceTokens,
    playwrightMcp: ctx.env.PlaywrightMCP,
    platform: ctx.platform,
    chatId: ctx.chatId,
  };
  const tools = codemodeEnabled ? resolveTools(toolCtx) : buildTools(toolCtx);

  // Step 8b: Process media assets
  // Images: prepare for vision (AutoRAG auto-indexes images with its own vision models)
  // Voice: Whisper transcribe + save .transcript.md sidecar (AutoRAG can't process audio)
  // Docs: already in R2, AutoRAG indexes directly
  let processedMedia: MediaAsset[] = [];
  if (ctx.mediaAssets?.length) {
    const processed: MediaAsset[] = [];
    for (const asset of ctx.mediaAssets) {
      try {
        if (asset.type === "image") {
          // BYOK vision check: if user has a non-vision BYOK model, warn instead of silently failing
          if (config.apiKey && !config.model?.includes("vision") && !config.model?.includes("claude") && !config.model?.includes("gpt-4")) {
            const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "image";
            processed.push({ ...asset, extractedText: `[Image received: ${name}] Note: Your current model may not support image analysis. Switch to a vision-capable model (Claude, GPT-4, etc.) to analyze images.` } as MediaAsset & { extractedText: string });
          } else {
            processed.push(await prepareImageForVision(asset, ctx.env.MEMORIES));
          }
        } else if (asset.type === "voice") {
          const transcribed = await transcribeAudio(asset, ctx.env.MEMORIES, ctx.env.AI);
          if (transcribed.audioBytes) {
            const equivTokens = Math.ceil(transcribed.audioBytes / 1000) * WHISPER_TOKENS_PER_KB;
            trackAuxiliaryUsage(ctx.sql, ctx.sessionId, equivTokens, 0, "@cf/openai/whisper-large-v3-turbo", ctx.env, ctx.userId, ctx.waitUntil);
          }
          if (transcribed.transcription) {
            // Save .transcript.md sidecar + update context metadata on original
            await saveTranscript(ctx.env.MEMORIES, transcribed, transcribed.transcription);
          }
          processed.push(transcribed);
        } else if (asset.type === "document" && asset.mimeType === "application/pdf") {
          const { extractPdfText } = await import("./media/pdf.js");
          const text = await extractPdfText(ctx.env.MEMORIES, asset.r2Key);
          if (text) {
            const name = asset.originalName ?? "document.pdf";
            savePdfTranscript(ctx.env.MEMORIES, asset, text).catch(() => {});
            processed.push({ ...asset, extractedText: capText(text, name) } as MediaAsset & { extractedText: string });
          } else {
            processed.push(asset);
          }
        } else if (asset.type === "document" && isDocx(asset.mimeType, asset.originalName)) {
          // DOCX: extract text with mammoth.js
          const { extractDocxText } = await import("./media/docx.js");
          const text = await extractDocxText(ctx.env.MEMORIES, asset.r2Key);
          if (text) {
            const name = asset.originalName ?? "document.docx";
            processed.push({ ...asset, extractedText: capText(`[DOCX: ${name}]\n\n${text}`, name) } as MediaAsset & { extractedText: string });
          } else {
            processed.push(asset);
          }
        } else if (asset.type === "document" && isXlsx(asset.mimeType, asset.originalName)) {
          // XLSX: extract text with fflate zero-dep parser
          const { extractXlsxText } = await import("./media/xlsx.js");
          const text = await extractXlsxText(ctx.env.MEMORIES, asset.r2Key);
          if (text) {
            const name = asset.originalName ?? "spreadsheet.xlsx";
            processed.push({ ...asset, extractedText: capText(`[XLSX: ${name}]\n\n${text}`, name) } as MediaAsset & { extractedText: string });
          } else {
            processed.push(asset);
          }
        } else if (asset.type === "document" && isTextReadable(asset.mimeType, asset.originalName)) {
          try {
            const obj = await ctx.env.MEMORIES.get(asset.r2Key);
            if (obj) {
              const text = await obj.text();
              if (text.length > 0) {
                const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "file";
                processed.push({ ...asset, extractedText: capText(`[File: ${name}]\n\n${text}`, name) } as MediaAsset & { extractedText: string });
              } else {
                processed.push(asset);
              }
            } else {
              processed.push(asset);
            }
          } catch {
            processed.push(asset);
          }
        } else if (asset.type === "document") {
          // Unknown binary document: try to read anyway (might be misreported mime)
          try {
            const obj = await ctx.env.MEMORIES.get(asset.r2Key);
            if (obj) {
              const buf = await obj.arrayBuffer();
              // Quick heuristic: if the first 1KB has no null bytes, it's likely text
              const sample = new Uint8Array(buf.slice(0, 1024));
              const hasNulls = sample.some(b => b === 0);
              if (!hasNulls && buf.byteLength > 0) {
                const text = new TextDecoder().decode(buf);
                const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "file";
                processed.push({ ...asset, extractedText: capText(`[File: ${name}]\n\n${text}`, name) } as MediaAsset & { extractedText: string });
              } else {
                processed.push(asset);
              }
            } else {
              processed.push(asset);
            }
          } catch {
            processed.push(asset);
          }
        } else {
          processed.push(asset);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Media processing failed for ${asset.type} ${asset.r2Key}: ${msg}`);
        processed.push(asset);
      }
    }

    // Inject media into messages
    const mediaParts = mediaToContentParts(processed);
    const docSummaries = processed
      .filter(a => a.type === "document")
      .map(a => ingestSummary(a));

    // Collect text-only parts (voice transcripts, doc summaries, image fallbacks)
    const textParts: string[] = [];
    const imageParts: Array<{ type: "image"; image: string; mediaType: string }> = [];

    for (const part of mediaParts) {
      if (part.type === "text") textParts.push(part.text);
      else if (part.type === "image") imageParts.push(part);
    }
    textParts.push(...docSummaries);

    if (textParts.length > 0 || imageParts.length > 0) {
      const lastIdx = messages.length - 1;
      const lastMsg = messages[lastIdx];
      if (lastMsg?.role === "user") {
        if (imageParts.length > 0) {
          // Multimodal: use content array (AI SDK handles image + text parts)
          const existingContent = typeof lastMsg.content === "string"
            ? [{ type: "text" as const, text: lastMsg.content }]
            : Array.isArray(lastMsg.content) ? lastMsg.content : [];
          const extraText = textParts.length > 0
            ? [{ type: "text" as const, text: textParts.join("\n") }]
            : [];
          messages = [
            ...messages.slice(0, lastIdx),
            { ...lastMsg, content: [...existingContent, ...imageParts, ...extraText] as typeof lastMsg.content },
          ];
        } else {
          // Text-only media (voice transcripts, doc summaries): append to message text
          const existingText = typeof lastMsg.content === "string" ? lastMsg.content : "";
          const combined = [existingText, ...textParts].filter(Boolean).join("\n\n");
          messages = [
            ...messages.slice(0, lastIdx),
            { ...lastMsg, content: combined },
          ];
        }
      }
    }
    processedMedia = processed;
  }

  // Mirror user message to FTS5 — include media markers so future turns
  // can see what was sent (SirChatalot "Description Placeholder" pattern)
  let mirrorText = ctx.userText;
  if (processedMedia.length > 0) {
    const markers: string[] = [];
    for (const asset of processedMedia) {
      const name = asset.originalName ?? asset.r2Key.split("/").pop() ?? "file";
      if (asset.type === "image") {
        markers.push(`[Image sent: ${name}]`);
      } else if (asset.type === "voice" && asset.transcription) {
        markers.push(`[Voice message: ${name}] Transcription: ${asset.transcription}`);
      } else if (asset.type === "voice") {
        markers.push(`[Voice message sent: ${name}]`);
      } else if (asset.type === "document") {
        const extracted = (asset as MediaAsset & { extractedText?: string }).extractedText;
        if (extracted) {
          // Include a content summary in FTS5 so next turns have document context
          const summary = extracted.length > 2000 ? extracted.slice(0, 2000) + "\n[...]" : extracted;
          markers.push(`[Document: ${name}]\n${summary}`);
        } else {
          markers.push(`[Document uploaded: ${name} (${(asset.sizeBytes / 1024).toFixed(0)}KB)]`);
        }
      }
    }
    if (markers.length > 0) {
      mirrorText = [mirrorText, ...markers].filter(Boolean).join("\n");
    }
  }
  mirrorMessage(ctx.sql, ctx.sessionId, "user", mirrorText, undefined, undefined, buildVectorCtx(ctx));

  ctx.onStateChange?.("streaming");

  // Track image assets — update their R2 context metadata after LLM describes them
  const imageAssets = ctx.mediaAssets?.filter(a => a.type === "image") ?? [];

  // Shared onFinish callback (step 10)
  const onFinish = (text: string, usage?: { inputTokens?: number; outputTokens?: number }) => {
    afterInference(ctx, config, text, usage, auxiliary);

    // Update image R2 context metadata with LLM's description
    if (imageAssets.length > 0 && text) {
      for (const img of imageAssets) {
        const name = img.originalName ?? img.r2Key.split("/").pop() ?? "image";
        const context = `Image: ${name}. Analysis: ${text}`;
        if (ctx.queueTask) {
          ctx.queueTask({ type: "r2ContextUpdate", r2Key: img.r2Key, context });
        } else {
          updateContext(ctx.env.MEMORIES, img.r2Key, context).catch(() => {});
        }
      }
    }
  };

  // Step 9a: Apply Anthropic cache control if BYOK
  const useAnthropicCache = isAnthropicProvider(config.provider);
  let providerOptions: Parameters<typeof streamText>[0]["providerOptions"];
  if (useAnthropicCache) {
    const cached = applyCacheControl(messages, systemPrompt);
    messages = cached.messages;
    providerOptions = cached.providerOptions as typeof providerOptions;
  }

  // Step 9b: Budget pressure — inject warnings into tool results (like Hermes)
  // The AI SDK doesn't let us inject messages mid-loop, so we wrap each tool's
  // execute() to append _budget warnings to their return value. The LLM sees
  // the warning naturally when reading tool results.
  const stepLimit = MAX_STEPS;
  let stepCount = 0;
  const spillCtx: SpillContext = {
    r2: ctx.env.MEMORIES,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
  };
  const budgetWrapped = wrapToolsWithBudget(tools, stepLimit, () => stepCount, ctx.onToolProgress, spillCtx);
  const onStepFinish = () => { stepCount++; };

  // Step 9c: LLM call with error recovery
  try {
    if (mode === "stream") {
      const result = streamText({
        abortSignal: ctx.abortSignal,
        model,
        system: systemPrompt,
        messages,
        tools: budgetWrapped as Parameters<typeof streamText>[0]["tools"],
        stopWhen: stepCountIs(stepLimit),
        ...(providerOptions ? { providerOptions } : {}),
        onStepFinish,
        onFinish: async ({ text, usage, steps }) => {
          onFinish(text, usage);

          // Extract media deliveries for stream mode too
          const streamMediaDelivery = extractMediaDelivery(steps);

          ctx.onComplete?.({
            text,
            usage: usage ? {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              model: config.model,
              sessionId: ctx.sessionId,
            } : undefined,
            mediaDelivery: streamMediaDelivery.length > 0 ? streamMediaDelivery : undefined,
          });
        },
      });
      return { mode: "stream", stream: result };
    }

    // generate mode
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      tools: budgetWrapped as Parameters<typeof generateText>[0]["tools"],
      stopWhen: stepCountIs(stepLimit),
      ...(providerOptions ? { providerOptions } : {}),
      onStepFinish,
      maxRetries: 2,
    });

    let text = result.text || "";

    // Tool-only turns can end with empty text if the model calls tools and stops.
    // Synthesize the final reply explicitly so gateways never get stuck on a placeholder.
    let summaryTokensIn = 0, summaryTokensOut = 0;
    const toolContext = buildToolSummaryContext(result.steps);
    if (!text && toolContext) {
      const stepLimitReached = !!result.steps && result.steps.length >= stepLimit;
      console.log(stepLimitReached
        ? "Budget exhausted — making final summary call"
        : "Tool-only run returned no final text — synthesizing summary");
      try {
        const summary = await synthesizeToolOnlyResponse(model, ctx.userText, toolContext);
        text = summary.text || (stepLimitReached ? STEP_LIMIT_RESPONSE_FALLBACK : TOOL_ONLY_RESPONSE_FALLBACK);
        // Track summary tokens separately — they are NOT included in result.usage
        summaryTokensIn = summary.tokensIn;
        summaryTokensOut = summary.tokensOut;
        if (summaryTokensIn > 0 || summaryTokensOut > 0) {
          trackAuxiliaryUsage(
            ctx.sql, ctx.sessionId, summaryTokensIn, summaryTokensOut,
            config.model, ctx.env, ctx.userId, ctx.waitUntil,
          );
        }
      } catch (err) {
        console.error("Summary call failed:", err);
        text = stepLimitReached ? STEP_LIMIT_RESPONSE_FALLBACK : TOOL_ONLY_RESPONSE_FALLBACK;
      }
    }

    if (!text) {
      const stepLimitReached = !!result.steps && result.steps.length >= stepLimit;
      text = stepLimitReached ? STEP_LIMIT_RESPONSE_FALLBACK : NO_RESPONSE_FALLBACK;
    }
    const usage = result.usage;
    onFinish(text, usage);

    // Extract media deliveries from tool results (TTS audio, generated images)
    const mediaDelivery = extractMediaDelivery(result.steps);

    const pipelineUsage: PipelineUsage | undefined = usage ? {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      model: config.model,
      sessionId: ctx.sessionId,
    } : undefined;

    const toolTrace = undefined;

    ctx.onStateChange?.("idle");
    ctx.onComplete?.({ text, usage: pipelineUsage });
    return { mode: "generate", text, usage: pipelineUsage, mediaDelivery: mediaDelivery.length > 0 ? mediaDelivery : undefined, toolTrace };
  } catch (err) {
    // Error recovery via structured classification — all provider quirks centralized.
    // errMsg is redacted before logging/returning so that upstream error strings
    // containing a leaked API key never hit the logs or the user-facing response.
    const errMsg = redact(err instanceof Error ? err.message : String(err));
    const classification = classifyError(err);
    console.warn(`[pipeline] ${classification.hint} (kind=${classification.kind}): ${errMsg}`);

    // Transient failures (rate_limit, overloaded) benefit from a short decorrelated jitter
    // before hitting the fallback — prevents thundering-herd retry spikes under load.
    if (classification.kind === "rate_limit" || classification.kind === "overloaded") {
      const delayMs = classification.retryAfterMs ?? jitteredDelay(1);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 5000)));
    }

    // Non-fallbackable errors (thinking_signature) return immediately so the next
    // user turn can retry with a fresh cache state.
    if (!classification.shouldFallback) {
      ctx.onStateChange?.("idle");
      return { error: `Model error (${classification.kind}): ${errMsg}`, status: 502 };
    }

    const fallback = await loadFallbackConfig(ctx.sql, ctx.env, ctx.plan);
    if (fallback) {
      console.log(`[pipeline] Falling back to ${fallback.model}`);
      try {
        const fbModel = createModel(fallback, ctx.env, fallback.model, {
          plan: ctx.plan,
          telemetry: {
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            platform: ctx.platform,
            purpose: "fallback",
          },
        });
        const fbResult = await generateText({
          model: fbModel,
          system: systemPrompt,
          messages,
          tools: tools as Parameters<typeof generateText>[0]["tools"],
          stopWhen: stepCountIs(MAX_STEPS),
          maxRetries: 1,
        });
        const text = fbResult.text?.trim() || NO_RESPONSE_FALLBACK;
        onFinish(text, fbResult.usage);

        const fbMediaDelivery = extractMediaDelivery(fbResult.steps);
        const pipelineUsage: PipelineUsage | undefined = fbResult.usage ? {
          inputTokens: fbResult.usage.inputTokens ?? 0,
          outputTokens: fbResult.usage.outputTokens ?? 0,
          model: fallback.model,
          sessionId: ctx.sessionId,
        } : undefined;

        ctx.onStateChange?.("idle");
        ctx.onComplete?.({ text, usage: pipelineUsage, mediaDelivery: fbMediaDelivery.length > 0 ? fbMediaDelivery : undefined });
        return { mode: "generate", text, usage: pipelineUsage, mediaDelivery: fbMediaDelivery.length > 0 ? fbMediaDelivery : undefined };
      } catch (fbErr) {
        console.error("[pipeline] Fallback also failed:", redact(fbErr instanceof Error ? fbErr.message : String(fbErr)));
      }
    }

    ctx.onStateChange?.("idle");
    return { error: `Model error (${classification.kind}): ${errMsg}`, status: 502 };
  }

}

/**
 * Decorrelated exponential jitter — spreads thundering-herd retries by a random
 * factor so multiple concurrent sessions never retry on the same instant.
 * Cap at `capMs` to keep worst-case user-visible latency bounded.
 */
function jitteredDelay(attempt: number, baseMs = 250, capMs = 5000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

// ───────────────────────── Media delivery extraction ─────────────────────────

/**
 * Extract media delivery markers from tool results.
 * Tools like tts and image set _audio_delivery / _image_delivery
 * flags on their return values with the R2 key of the generated media.
 */
function extractMediaDelivery(steps: unknown): MediaDelivery[] {
  const deliveries: MediaDelivery[] = [];
  if (!Array.isArray(steps)) return deliveries;

  for (const step of steps) {
    const toolResults = (step as { toolResults?: unknown[] }).toolResults;
    if (!Array.isArray(toolResults)) continue;

    for (const tr of toolResults) {
      // AI SDK v6: toolResult has `output` field (not `result`)
      const output = (tr as { output?: unknown }).output;
      const r = output as Record<string, unknown> | undefined;
      if (!r) continue;

      if (r._audio_delivery && r.audio_key) {
        deliveries.push({ type: "audio", r2Key: r.audio_key as string, format: (r.format as string) ?? "mp3" });
      }
      if (r._image_delivery && r.image_key) {
        deliveries.push({ type: "image", r2Key: r.image_key as string, format: (r.format as string) ?? "jpg" });
      }
    }
  }

  return deliveries;
}

// ───────────────────────── Auxiliary usage tracking ─────────────────────────

/**
 * Atomic increment of the durable monthly token counter.
 *
 * Stored in `monthly_tokens` (separate from `sessions.total_tokens`) so that
 * `/reset` and `/wipe` — which both DELETE FROM sessions — don't blow away the
 * count the dashboard displays. The PRIMARY KEY on month makes the UPSERT
 * race-safe across concurrent inference calls.
 */
export function incrementMonthlyTokens(sql: SqlFn, tokensAdded: number): void {
  if (tokensAdded <= 0) return;
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  sql`INSERT INTO monthly_tokens (month, total, updated_at)
      VALUES (${month}, ${tokensAdded}, datetime('now'))
      ON CONFLICT(month) DO UPDATE SET
        total = total + ${tokensAdded},
        updated_at = datetime('now')`;
}

/**
 * Reports token usage to the gateway via Cloudflare Queues.
 *
 * Durable by design:
 * - `env.USAGE_QUEUE.send()` is awaited via ctx.waitUntil in the caller (non-blocking)
 * - Queue retries automatically on gateway failure
 * - Failed messages after max retries land in `clopinette-usage-dlq`
 * - No more fire-and-forget fetch — usage events can never be silently dropped
 */
export function trackAuxiliaryUsage(
  sql: SqlFn, sessionId: string,
  tokensIn: number, tokensOut: number,
  model: string, env: Env, userId: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const tokens = tokensIn + tokensOut;
  if (tokens <= 0) return;
  sql`UPDATE sessions SET total_tokens = total_tokens + ${tokens} WHERE id = ${sessionId}`;
  incrementMonthlyTokens(sql, tokens);
  enqueueUsageReport(env, {
    userId, tokensIn, tokensOut, model, sessionId, timestamp: Date.now(),
  }, waitUntil);
}

// ───────────────────────── Post-inference (step 10) ─────────────────────────

function afterInference(
  ctx: PipelineContext,
  config: InferenceConfig,
  text: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  auxiliary: { model: LanguageModel; modelId: string },
): void {
  // Mirror assistant response to FTS5 + Vectorize
  if (text) {
    mirrorMessage(ctx.sql, ctx.sessionId, "assistant", text, undefined, undefined, buildVectorCtx(ctx));
  }

  // Auto-generate session title from the first exchange (fire-and-forget)
  if (text && ctx.userText) {
    const titleRows = ctx.sql<{ summary: string | null }>`
      SELECT summary FROM sessions WHERE id = ${ctx.sessionId}
    `;
    if (!titleRows[0]?.summary) {
      // Generate a short title from the first exchange using simple heuristic
      // No LLM call — just take the first meaningful words from the user message
      const raw = ctx.userText.replace(/\[.*?\]/g, "").trim();
      const title = raw.length > 60 ? raw.slice(0, 57) + "..." : raw;
      if (title.length > 2) {
        ctx.sql`UPDATE sessions SET summary = ${title} WHERE id = ${ctx.sessionId}`;
      }
    }
  }

  // Touch session timestamp + token tracking
  if (usage) {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    ctx.sql`UPDATE sessions SET total_tokens = total_tokens + ${tokens}, updated_at = datetime('now')
      WHERE id = ${ctx.sessionId}`;

    // Durable monthly counter — survives /reset and /wipe (which both DELETE FROM sessions)
    incrementMonthlyTokens(ctx.sql, tokens);

    // Gateway usage reporting via Cloudflare Queue (retry-safe, DLQ-backed)
    enqueueUsageReport(ctx.env, {
      userId: ctx.userId,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      model: config.model,
      sessionId: ctx.sessionId,
      timestamp: Date.now(),
    }, ctx.waitUntil);
  } else {
    // No usage info but still touch the timestamp
    ctx.sql`UPDATE sessions SET updated_at = datetime('now') WHERE id = ${ctx.sessionId}`;
  }

  // Self-learning
  if (ctx.enableSelfLearning !== false) {
    const turnCount = incrementTurn(ctx.sql);
    if (
      turnCount >= MIN_TURNS_BEFORE_REVIEW &&
      turnCount % REVIEW_INTERVAL === 0
    ) {
      // Build summary from the messages we have
      const summaryInput = ctx.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map(m => ({
          role: m.role,
          parts: [{ type: "text" as const, text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
        }));
      // Add current exchange
      summaryInput.push({ role: "user", parts: [{ type: "text", text: ctx.userText }] });
      if (text) summaryInput.push({ role: "assistant", parts: [{ type: "text", text }] });

      const summary = buildConversationSummary(summaryInput);
      if (ctx.queueTask) {
        ctx.queueTask({
          type: "selfLearning",
          summary,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          options: { reviewMemory: true, reviewSkills: true },
        });
      } else {
        const reviewPromise = runSelfLearningReview(
          summary, ctx.sql, auxiliary.model, ctx.env.MEMORIES, ctx.env.SKILLS, ctx.userId,
          { reviewMemory: true, reviewSkills: true }
        ).then((r) => {
          if (r.tokensIn > 0 || r.tokensOut > 0) {
            trackAuxiliaryUsage(ctx.sql, ctx.sessionId, r.tokensIn, r.tokensOut, auxiliary.modelId, ctx.env, ctx.userId, ctx.waitUntil);
          }
          if (r.memoryActions > 0 || r.skillActions > 0) {
            console.log(`Self-learning: ${r.memoryActions} memory, ${r.skillActions} skill updates`);
          }
        }).catch((err) => {
          console.warn("Self-learning review failed:", err);
        });
        if (ctx.waitUntil) ctx.waitUntil(reviewPromise);
        else void reviewPromise;
      }
    }
  }
}
