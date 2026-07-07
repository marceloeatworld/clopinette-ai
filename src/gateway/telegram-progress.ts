export interface TelegramEditResult {
  ok: boolean;
  reason?: "not_modified" | "flood_control" | "too_long" | "parse_error" | "error";
  retryAfterMs?: number;
}

export interface TelegramProgressControllerOptions {
  editMessage: (text: string) => Promise<TelegramEditResult>;
  pingTyping?: () => Promise<void>;
  editIntervalMs?: number;
  animationIntervalMs?: number;
  previewLimit?: number;
  maxLines?: number;
  frames?: string[];
}

const DEFAULT_FRAMES = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const DEFAULT_EDIT_INTERVAL_MS = 1300;
const DEFAULT_ANIMATION_INTERVAL_MS = 900;
const DEFAULT_PREVIEW_LIMIT = 40;
const DEFAULT_MAX_LINES = 8;

const TOOL_EMOJIS: Record<string, string> = {
  web: "🔍",
  memory: "🧠",
  history: "📜",
  skills: "📚",
  todo: "✅",
  docs: "📄",
  notes: "📝",
  calendar: "📅",
  image: "🎨",
  tts: "🔊",
  codemode: "⚡",
  browser: "🌐",
  clarify: "❓",
  delegate: "🔀",
};

export class TelegramProgressController {
  private readonly editMessage: TelegramProgressControllerOptions["editMessage"];
  private readonly pingTyping?: TelegramProgressControllerOptions["pingTyping"];
  private readonly editIntervalMs: number;
  private readonly animationIntervalMs: number;
  private readonly previewLimit: number;
  private readonly maxLines: number;
  private readonly frames: string[];

  private lines: string[] = [];
  private lastBaseLine: string | null = null;
  private repeatCount = 0;
  private lastRendered = "";
  private lastEditAt = 0;
  private frameIndex = 0;
  private canEdit = true;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private animationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TelegramProgressControllerOptions) {
    this.editMessage = options.editMessage;
    this.pingTyping = options.pingTyping;
    this.editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this.animationIntervalMs = options.animationIntervalMs ?? DEFAULT_ANIMATION_INTERVAL_MS;
    this.previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.frames = options.frames?.length ? options.frames : DEFAULT_FRAMES;
  }

  static initialText(): string {
    return `⏳ ${DEFAULT_FRAMES[0]}`;
  }

  get editable(): boolean {
    return this.canEdit;
  }

  start(): void {
    if (!this.canEdit || this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      void this.flush();
    }, this.animationIntervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  pushToolProgress(toolName: string, preview: string): void {
    if (!this.canEdit) return;

    const emoji = TOOL_EMOJIS[toolName] ?? "⚙️";
    const trimmed = preview.trim();
    const limited = trimmed.length > this.previewLimit
      ? `${trimmed.slice(0, this.previewLimit - 3)}...`
      : trimmed;
    const baseLine = limited ? `${emoji} ${toolName}: "${limited}"` : `${emoji} ${toolName}...`;

    if (baseLine === this.lastBaseLine && this.lines.length > 0) {
      this.repeatCount += 1;
      this.lines[this.lines.length - 1] = `${baseLine} (x${this.repeatCount + 1})`;
    } else {
      this.lastBaseLine = baseLine;
      this.repeatCount = 0;
      this.lines.push(baseLine);
      if (this.lines.length > this.maxLines) {
        this.lines = this.lines.slice(-this.maxLines);
      }
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush(true);
      }, 120);
    }
  }

  snapshot(): string {
    const statusLine = `⏳ ${this.frames[this.frameIndex]}`;
    return this.lines.length > 0 ? [statusLine, ...this.lines].join("\n") : statusLine;
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush(true);
  }

  private async flush(force = false): Promise<void> {
    if (!this.canEdit) return;

    const elapsed = Date.now() - this.lastEditAt;
    if (!force && elapsed < this.editIntervalMs) {
      if (!this.flushTimer) {
        const delay = this.editIntervalMs - elapsed;
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush(true);
        }, delay);
      }
      return;
    }

    const text = this.snapshot();
    if (text === this.lastRendered) return;

    const result = await this.editMessage(text);
    if (result.ok) {
      this.lastRendered = text;
      this.lastEditAt = Date.now();
      if (this.pingTyping) void this.pingTyping().catch(() => {});
      return;
    }

    if (result.reason === "not_modified") {
      this.lastRendered = text;
      this.lastEditAt = Date.now();
      return;
    }

    if (result.reason === "flood_control" && result.retryAfterMs && result.retryAfterMs <= 5000) {
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush(true);
        }, result.retryAfterMs);
      }
      return;
    }

    this.canEdit = false;
    this.stop();
  }
}
