export type Platform = "api" | "telegram" | "slack" | "whatsapp" | "websocket";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "google-ai-studio"
  | "groq"
  | "deepseek"
  | "xai"
  | "openrouter"
  | "azure-openai"
  | "aws-bedrock"
  | "mistral"
  | "cohere"
  | "workers-ai";

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
