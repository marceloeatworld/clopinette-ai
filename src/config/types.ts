export type Platform = "api" | "telegram" | "slack" | "discord" | "whatsapp" | "websocket";

/** Cloudflare AI Gateway provider slugs (https://developers.cloudflare.com/ai-gateway/usage/providers/). */
export type ProviderName =
  | "workers-ai"
  | "openai"
  | "anthropic"
  | "google-ai-studio"
  | "groq"
  | "deepseek"
  | "grok"          // xAI (CF's official slug, not "xai")
  | "mistral"
  | "cohere"
  | "perplexity"
  | "openrouter"
  | "cerebras"
  | "huggingface"
  | "replicate";

export interface AgentState {
  status: "idle" | "thinking" | "streaming";
  currentModel: string;
  platform: Platform;
}

export interface AgentConfigRow {
  key: string;
  value: string;
  encrypted: number;
  key_version: number;
  updated_at: string;
}

export interface PromptMemoryRow {
  type: "memory" | "user";
  content: string;
  char_limit: number;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  parent_session_id: string | null;
  platform: string;
  started_at: string;
  ended_at: string | null;
  updated_at: string | null;
  summary: string | null;
  model: string | null;
  total_tokens: number;
}

export interface SessionMessageRow {
  id: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  created_at: string;
}

export interface InferenceConfig {
  apiKey?: string;
  provider?: string;
  model: string;
  /** Auxiliary provider (may differ from primary). Undefined means "use primary provider". */
  auxiliaryProvider?: string;
  /** Decrypted API key for the auxiliary provider (may be the same as apiKey if same provider). */
  auxiliaryApiKey?: string;
  /** Model used for simple/greeting routing. Bound to auxiliaryProvider's credentials. */
  auxiliaryModel: string;
}

export interface SetupRequest {
  userId: string;
  displayName?: string;
}

export interface ConfigRequest {
  userId: string;
  provider?: ProviderName;
  apiKey?: string;
  model?: string;
  auxiliaryProvider?: string;
  auxiliaryModel?: string;
  soulMd?: string;
  autoragName?: string;
}

export interface MediaAsset {
  type: "image" | "voice" | "document";
  r2Key: string;
  mimeType: string;
  originalName?: string;
  sizeBytes: number;
  /** Base64 data URI (populated by vision module for images) */
  dataUri?: string;
  /** Transcribed text (populated by transcribe module for voice) */
  transcription?: string;
  /** Audio size in bytes (populated by transcribe for usage tracking) */
  audioBytes?: number;
}

export interface StatusResponse {
  ok: boolean;
  currentModel: string;
  /** Stored provider config (workers-ai | openai | anthropic | ...). */
  currentProvider?: string;
  /** Model for the current provider (shortcut for configuredModels[currentProvider]). */
  configuredModel?: string;
  /** Per-provider saved models: { openai: "gpt-4o", anthropic: "claude-3-5-sonnet", ... }. */
  configuredModels?: Record<string, string>;
  /** Auxiliary provider if different from primary (cross-provider auxiliary). */
  currentAuxiliaryProvider?: string;
  /** Auxiliary model for the current auxiliary provider. */
  configuredAuxiliaryModel?: string;
  /** Per-provider saved auxiliary models. */
  configuredAuxiliaryModels?: Record<string, string>;
  platform: Platform;
  status: string;
  configuredKeys: string[];
}

// ───────────────────────── Admin types ─────────────────────────

export interface AuditRow {
  id: number;
  action: string;
  details: string | null;
  created_at: string;
}

export interface ConfigEntry {
  key: string;
  value: string;
  encrypted: boolean;
  updated_at: string;
}

// ───────────────────────── Delegation types ─────────────────────────

export interface DelegateResult {
  status: "success" | "error";
  summary: string;
  toolTrace: string[];
  duration: number;
  tokens: { input: number; output: number };
}

// ───────────────────────── Hub types ────────────────────────────────

export interface HubInstalledEntry {
  name: string;
  source: string;
  identifier: string;
  trustLevel: string;
  contentHash: string | null;
  installedAt: string;
  updatedAt: string;
  metadata: string | null;
}
