/**
 * Discord Gateway bridge — connects to Discord's WebSocket Gateway and
 * forwards MESSAGE_CREATE events to the Clopinette Worker via HTTP POST.
 *
 * Env vars:
 *   DISCORD_TOKEN        — Bot token
 *   BRIDGE_SECRET        — Shared secret (from POST /api/admin/setup-discord)
 *   WORKER_URL           — e.g. https://clopinette-ai.aiteklabs.workers.dev
 *   BOT_USER_ID          — (auto-detected from READY event)
 *
 * Discord Gateway protocol (v10):
 *   1. Connect WSS → receive Hello (op 10) with heartbeat_interval
 *   2. Send Identify (op 2) with token + intents
 *   3. Heartbeat at interval, track ACKs for zombie detection
 *   4. Dispatch events (op 0) — forward MESSAGE_CREATE to Worker
 *   5. Reconnect/resume on disconnect
 */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GATEWAY_API = "https://discord.com/api/v10";

// Intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // 37377

const DISCORD_TOKEN = env("DISCORD_TOKEN");
const BRIDGE_SECRET = env("BRIDGE_SECRET");
const WORKER_URL = env("WORKER_URL");

let botUserId = "";
let sessionId = "";
let resumeUrl = "";
let sequence: number | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatAcked = true;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;

function env(key: string): string {
  const val = process.env[key];
  if (!val) { console.error(`Missing env: ${key}`); process.exit(1); }
  return val;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ───────────────────────── Gateway Connection ─────────────────────────

function connect(resume = false) {
  const url = resume && resumeUrl ? resumeUrl : GATEWAY_URL;
  log(`Connecting to ${resume ? "resume" : "new"} gateway...`);

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    log("WebSocket connected");
    reconnectAttempts = 0;

    if (resume && sessionId) {
      send({ op: 6, d: { token: DISCORD_TOKEN, session_id: sessionId, seq: sequence } });
      log("Sent RESUME");
    }
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    handleMessage(data);
  });

  ws.addEventListener("close", (event) => {
    log(`WebSocket closed: code=${event.code} reason=${event.reason}`);
    cleanup();

    // Non-resumable close codes
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
    if (fatal.includes(event.code)) {
      log(`Fatal close code ${event.code} — exiting`);
      process.exit(1);
    }

    scheduleReconnect(event.code !== 1000 && sessionId !== "");
  });

  ws.addEventListener("error", (event) => {
    log(`WebSocket error: ${event}`);
  });
}

function send(data: unknown) {
  ws?.send(JSON.stringify(data));
}

function cleanup() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function scheduleReconnect(canResume: boolean) {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
  reconnectAttempts++;
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}, resume=${canResume})`);
  setTimeout(() => connect(canResume), delay);
}

// ───────────────────────── Message Handling ─────────────────────────

function handleMessage(msg: { op: number; t?: string; s?: number; d?: any }) {
  if (msg.s != null) sequence = msg.s;

  switch (msg.op) {
    case 10: // Hello
      startHeartbeat(msg.d.heartbeat_interval);
      if (!sessionId) {
        // New session — send IDENTIFY
        send({
          op: 2,
          d: {
            token: DISCORD_TOKEN,
            intents: INTENTS,
            properties: { os: "linux", browser: "clopinette-bridge", device: "clopinette-bridge" },
          },
        });
        log("Sent IDENTIFY");
      }
      break;

    case 11: // Heartbeat ACK
      heartbeatAcked = true;
      break;

    case 7: // Reconnect
      log("Gateway requested reconnect");
      ws?.close(4000, "Reconnect requested");
      break;

    case 9: // Invalid Session
      log(`Invalid session (resumable=${msg.d})`);
      if (!msg.d) { sessionId = ""; sequence = null; }
      setTimeout(() => connect(!!msg.d), 1000 + Math.random() * 4000);
      break;

    case 0: // Dispatch
      handleDispatch(msg.t!, msg.d);
      break;
  }
}

function startHeartbeat(intervalMs: number) {
  cleanup();
  // First heartbeat: jittered
  const jitter = Math.random() * intervalMs;
  setTimeout(() => {
    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, intervalMs);
  }, jitter);
}

function sendHeartbeat() {
  if (!heartbeatAcked) {
    log("Heartbeat not ACKed — zombie connection, reconnecting");
    ws?.close(4000, "Zombie connection");
    return;
  }
  heartbeatAcked = false;
  send({ op: 1, d: sequence });
}

// ───────────────────────── Dispatch Events ─────────────────────────

function handleDispatch(event: string, data: any) {
  switch (event) {
    case "READY":
      sessionId = data.session_id;
      resumeUrl = data.resume_gateway_url;
      botUserId = data.user.id;
      log(`Ready! Bot: ${data.user.username}#${data.user.discriminator} (${botUserId}), session=${sessionId}`);
      break;

    case "RESUMED":
      log("Session resumed successfully");
      break;

    case "MESSAGE_CREATE":
      // Ignore bot messages (including our own)
      if (data.author?.bot) return;
      // Ignore system messages
      if (data.type !== 0 && data.type !== 19) return; // 0=DEFAULT, 19=REPLY

      // In guilds: only respond if bot is mentioned or replied to
      if (data.guild_id) {
        const mentionsBot = data.mentions?.some((m: any) => m.id === botUserId);
        const repliesToBot = data.referenced_message?.author?.id === botUserId;
        if (!mentionsBot && !repliesToBot) return;
        // Strip bot mention from content
        if (mentionsBot) {
          data.content = data.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
        }
      }

      forwardToWorker(data);
      break;
  }
}

// ───────────────────────── Forward to Worker ─────────────────────────

async function forwardToWorker(message: any) {
  const url = `${WORKER_URL}/webhook/discord-bridge`;
  const body = JSON.stringify({ type: "MESSAGE_CREATE", message });

  // HMAC-SHA256 signature (same pattern as WhatsApp X-Hub-Signature-256)
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(BRIDGE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + body));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Timestamp": timestamp,
        "X-Bridge-Signature": `sha256=${hex}`,
      },
      body,
    });
    if (!resp.ok) {
      log(`Worker responded ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
  } catch (err) {
    log(`Forward failed: ${err}`);
  }
}

// ───────────────────────── Health Check ─────────────────────────

Bun.serve({
  port: Number(process.env.PORT ?? 3100),
  fetch(req) {
    if (new URL(req.url).pathname === "/health") {
      const ok = ws?.readyState === WebSocket.OPEN;
      return new Response(ok ? "ok" : "disconnected", { status: ok ? 200 : 503 });
    }
    return new Response("", { status: 404 });
  },
});

// ───────────────────────── Start ─────────────────────────

log("Discord bridge starting...");
connect();

// Graceful shutdown
process.on("SIGTERM", () => { log("SIGTERM — closing"); cleanup(); ws?.close(1000, "Shutdown"); process.exit(0); });
process.on("SIGINT", () => { log("SIGINT — closing"); cleanup(); ws?.close(1000, "Shutdown"); process.exit(0); });
