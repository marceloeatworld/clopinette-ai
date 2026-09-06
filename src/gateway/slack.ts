/**
 * Slack Events API gateway.
 *
 * Secrets:
 *   SLACK_SIGNING_SECRET  — HMAC-SHA256 verification of incoming requests
 *   SLACK_BOT_TOKEN       — xoxb-... for sending messages + downloading files
 *
 * Setup:
 *   1. Create a Slack app at api.slack.com/apps
 *   2. Enable Events API, set Request URL to /webhook/slack
 *   3. Subscribe to: message.im, message.channels, file_shared
 *   4. Add OAuth scopes: chat:write, files:read, users:read
 *   5. Install to workspace, copy bot token
 *   6. wrangler secret put SLACK_BOT_TOKEN
 *   7. wrangler secret put SLACK_SIGNING_SECRET
 *   8. POST /api/admin/setup-slack
 *
 * User ID: event.user (e.g. U123ABC456)
 * DO name: sl_{userId}
 * Rate limit: 1 msg/channel/sec, must respond 200 within 3 seconds
 */

export async function handleSlackEvent(_request: Request): Promise<Response> {
  return Response.json({ error: "Slack not implemented" }, { status: 501 });
}

// ───────────────────────── Signature verification ─────────────────────────

/**
 * Verify Slack request signature (HMAC-SHA256).
 * Base string: v0:{timestamp}:{rawBody}
 * Compare: v0={hex_digest} vs X-Slack-Signature header
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  // Replay protection: reject if older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  const { timingSafeEqual } = await import("../enterprise/safe-compare.js"); // keep dynamic — slack not on hot path
  const computed = `v0=${arrayToHex(new Uint8Array(sig))}`;
  return timingSafeEqual(computed, signature);
}

// ───────────────────────── Send message ─────────────────────────

export async function sendSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string
): Promise<boolean> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const data = await resp.json<{ ok: boolean }>();
  return data.ok;
}

// ───────────────────────── Helpers ─────────────────────────

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
