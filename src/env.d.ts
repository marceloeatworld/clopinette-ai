interface Env {
  AI: Ai;
  BROWSER: Fetcher;
  CLOPINETTE_AGENT: DurableObjectNamespace<import("./agent.js").ClopinetteAgent>;
  PlaywrightMCP: DurableObjectNamespace;
  MEMORIES: R2Bucket;
  SKILLS: R2Bucket;
  LINKS: KVNamespace;
  // Secrets (wrangler secret put)
  MASTER_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  // WebSocket auth — shared secret with gateway for ephemeral token verification
  WS_SIGNING_SECRET: string;
  // Gateway URL for usage reporting (fire-and-forget after each response)
  GATEWAY_URL?: string;
  GATEWAY_INTERNAL_KEY?: string;
  // Delegation — ephemeral sub-agent DOs for parallel task execution
  DELEGATE_WORKER?: DurableObjectNamespace;
  // Dynamic Workers (codemode) — opt-in, requires Workers Paid plan
  LOADER?: WorkerLoader;
  // Codemode outbound — SSRF-safe fetch proxy for sandbox code (service binding)
  CODEMODE_OUTBOUND?: Fetcher;
  // Platform bot tokens (official bots, one per platform)
  TELEGRAM_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  // Evolution API (self-hosted WhatsApp via Baileys on Coolify)
  EVOLUTION_API_URL?: string;
  EVOLUTION_API_KEY?: string;
  // Optional
  CORS_ORIGINS?: string;
  CF_BROWSER_TOKEN?: string;
  API_AUTH_KEY?: string;
  GITHUB_TOKEN?: string;
  // Search backends (SearXNG primary, Brave API fallback, Browser Rendering last resort)
  SEARXNG_URL?: string;
  BRAVE_API_KEY?: string;
}
