import { describe, it, expect } from "vitest";
import { verifyWsToken } from "../src/token.js";

// ───────────────────────── Test helpers ─────────────────────────

function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signToken(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const header = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  );
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))
  );
  return `${data}.${base64urlEncode(sig)}`;
}

// ───────────────────────── Tests ─────────────────────────

const SECRET = "test-signing-secret-32chars-long!";

describe("WS token verification", () => {
  it("verifies a valid token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await signToken({ sub: "user-123", exp }, SECRET);
    const result = await verifyWsToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("user-123");
    expect(result!.exp).toBe(exp);
  });

  it("rejects expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = await signToken({ sub: "user-123", exp }, SECRET);
    expect(await verifyWsToken(token, SECRET)).toBeNull();
  });

  it("rejects token signed with wrong secret", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await signToken({ sub: "user-123", exp }, SECRET);
    expect(await verifyWsToken(token, "wrong-secret")).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyWsToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyWsToken("a.b", SECRET)).toBeNull();
    expect(await verifyWsToken("", SECRET)).toBeNull();
  });

  it("rejects token missing sub", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await signToken({ exp }, SECRET);
    expect(await verifyWsToken(token, SECRET)).toBeNull();
  });

  it("rejects token missing exp", async () => {
    const token = await signToken({ sub: "user-123" }, SECRET);
    expect(await verifyWsToken(token, SECRET)).toBeNull();
  });
});
