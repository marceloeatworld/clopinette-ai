/**
 * Verify ephemeral WebSocket tokens signed by the gateway.
 * Mirror of clopinette-platform/packages/gateway/src/token.ts (verify only).
 */

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface TokenPayload {
  sub: string;   // userId
  exp: number;   // unix timestamp
}

/** Verify a signed token. Returns the payload if valid, null otherwise. */
export async function verifyWsToken(token: string, secret: string): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBytes = base64urlDecode(sig);
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;

  try {
    const payload: TokenPayload = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
    if (!payload.sub || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
