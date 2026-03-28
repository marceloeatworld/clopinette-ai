#!/usr/bin/env bun
export {};
/**
 * ClopinetteAI — Smoke test script
 * Tests all core features against the live deployment.
 *
 * Usage:
 *   bun test/live/smoke.ts
 *
 * Requires API_AUTH_KEY env var or pass as argument:
 *   API_KEY=xxx bun test/live/smoke.ts
 */

const BASE = process.env.BASE_URL || "https://clopinette-ai.YOUR-SUBDOMAIN.workers.dev";
const API_KEY = process.env.API_KEY || process.argv[2] || "";
const USER_ID = `smoke-${Date.now().toString(36)}`;

if (!API_KEY) {
  console.error("Usage: API_KEY=your_key bun test/live/smoke.ts");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${name} — ${msg}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BASE}${path}`, opts);
  const data = await resp.json() as Record<string, unknown>;
  return { status: resp.status, data };
}

const DEBUG = !!process.env.DEBUG;

function wsChat(text: string): Promise<{ text: string; tools: string[] }> {
  return new Promise((resolve, reject) => {
    const url = `${BASE.replace("https://", "wss://")}/agents/clopinette-agent/${USER_ID}?token=${API_KEY}`;
    const ws = new WebSocket(url);
    let fullText = "";
    const tools: string[] = [];
    let timeout: ReturnType<typeof setTimeout>;
    let finished = false;

    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ws.close();
      resolve({ text: fullText, tools });
    };

    ws.onopen = () => {
      // Wait for agent to be ready before sending
      timeout = setTimeout(done, 60_000);
    };

    // Send after receiving initial state (agent ready)
    let sentMsg = false;
    const sendMsg = () => {
      if (sentMsg) return;
      sentMsg = true;
      const reqId = `req-${Date.now()}`;
      ws.send(JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: reqId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{ id: `m-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }],
          }),
        },
      }));
    };

    ws.onmessage = (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : "";
      if (DEBUG) console.log("      [ws]", raw.slice(0, 200));

      // Try JSON parse first (Agents SDK wraps messages as JSON)
      try {
        const json = JSON.parse(raw);

        // State messages — send chat after agent is ready
        if (json.type === "cf_agent_state" || json.type === "cf_agent_state_update") {
          sendMsg();
          return;
        }
        if (json.type === "cf_agent_identity" || json.type === "cf_agent_mcp_servers") return;

        // Chat response stream — body is a JSON-stringified chunk
        if (json.type === "cf_agent_use_chat_response") {
          if (json.done) { setTimeout(done, 300); return; }
          try {
            const part = JSON.parse(json.body);
            if (part.type === "text-delta") {
              fullText += part.delta || "";
            } else if (part.type === "tool-call") {
              tools.push(part.toolName || part.name || "unknown");
            } else if (part.type === "finish" || part.type === "finish-step") {
              // wait for done:true
            }
          } catch {}
          return;
        }

        // Direct stream part
        if (json.type) {
          parseLine(`${json.type}:${JSON.stringify(json)}`);
          return;
        }
      } catch {
        // Not JSON — try as raw SSE lines
      }

      // Raw SSE lines (one or multiple)
      for (const line of raw.split("\n")) {
        parseLine(line);
      }
    };

    function parseLine(line: string) {
      const m = line.match(/^(\w+):(.*)$/s);
      if (!m) return;
      const [, type, payload] = m;

      if (type === "2" || type === "0") {
        // text delta
        try { fullText += JSON.parse(payload); } catch { fullText += payload; }
      } else if (type === "9") {
        // tool call
        try {
          const parsed = JSON.parse(payload);
          tools.push(parsed.toolName || "unknown");
        } catch {}
      } else if (type === "e" || type === "d") {
        // finish
        setTimeout(done, 300);
      }
    }

    ws.onerror = () => { clearTimeout(timeout!); reject(new Error("WebSocket error")); };
    ws.onclose = (e) => {
      if (e.code === 4001 || e.code === 4003) {
        clearTimeout(timeout!);
        reject(new Error(`Auth failed (${e.code})`));
      } else if (!finished) {
        done();
      }
    };
  });
}

// ─────────────────────── Tests ───────────────────────

console.log(`\n🔬 ClopinetteAI Smoke Test`);
console.log(`   ${BASE} — user: ${USER_ID}\n`);

// ── API ──
console.log("API Routes:");

await test("POST /api/setup", async () => {
  const { status, data } = await api("POST", "/api/setup", { userId: USER_ID, displayName: "Smoke" });
  assert(status === 200, `status ${status}`);
  assert(data.ok === true, `expected ok:true, got ${JSON.stringify(data)}`);
});

await test("GET /api/status", async () => {
  const { status, data } = await api("GET", `/api/status?userId=${USER_ID}`);
  assert(status === 200, `status ${status}`);
  assert(data.ok === true, `expected ok:true`);
  assert(typeof data.currentModel === "string", "missing currentModel");
  console.log(`      model=${data.currentModel} status=${data.status}`);
});

await test("POST /api/config (model)", async () => {
  const { status, data } = await api("POST", "/api/config", { userId: USER_ID, model: "@cf/moonshotai/kimi-k2.5" });
  assert(status === 200, `status ${status}`);
  assert(data.ok === true, `expected ok:true`);
});

await test("Auth required (no header)", async () => {
  const resp = await fetch(`${BASE}/api/status?userId=x`);
  assert(resp.status === 401, `expected 401, got ${resp.status}`);
});

await test("404 on unknown route", async () => {
  const { status } = await api("GET", "/nonexistent");
  assert(status === 404, `expected 404, got ${status}`);
});

// ── WebSocket Chat (with pauses between tests to let the DO settle) ──
console.log("\nWebSocket Chat:");

await test("Basic chat response", async () => {
  const r = await wsChat("Say exactly: SMOKE_OK");
  assert(r.text.length > 0, "empty response");
  console.log(`      response: ${r.text.slice(0, 80)}...`);
});
await sleep(3000);

await test("Memory write", async () => {
  const r = await wsChat("Save to MEMORY.md: smoke_test_value=42. Use the memory tool with operation add.");
  const evidence = r.tools.length > 0 || /memory|saved|done|smoke_test/i.test(r.text);
  assert(evidence, `no evidence of memory write, text=${r.text.slice(0, 100)}`);
  console.log(`      tools: [${r.tools.join(", ")}] text: ${r.text.slice(0, 60)}`);
});
await sleep(3000);

await test("Memory read", async () => {
  const r = await wsChat("Read MEMORY.md using the memory tool. What does it contain?");
  assert(r.text.length > 0, "empty response");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Todo add", async () => {
  const r = await wsChat("Add a todo: smoke test item. Use the todo tool.");
  assert(r.tools.length > 0 || /added|todo|done/i.test(r.text), "no tool evidence");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Todo list", async () => {
  const r = await wsChat("List all todos using the todo tool.");
  assert(r.text.length > 0, "empty response");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Session search", async () => {
  const r = await wsChat("Search past conversations for the word 'smoke' using session_search.");
  assert(r.text.length > 0, "empty response");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Skill create", async () => {
  const r = await wsChat("Create a skill called smoke-test-skill with description 'test skill' and content 'Step 1: run tests. Step 2: check results.' Use the skills tool with action create.");
  assert(r.text.length > 0, "empty response");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Skill list", async () => {
  const r = await wsChat("List all skills using the skills tool.");
  assert(r.text.length > 0, "empty response");
  console.log(`      tools: [${r.tools.join(", ")}]`);
});
await sleep(3000);

await test("Smart routing (cheap model for greeting)", async () => {
  const r = await wsChat("hello");
  assert(r.text.length > 0, "empty response");
  console.log(`      response: ${r.text.slice(0, 60)}`);
});

// ── Summary ──
console.log(`\n${"─".repeat(40)}`);
console.log(`  ${passed + failed} tests | ${passed} passed | ${failed} failed`);
console.log(`${"─".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
