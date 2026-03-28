/**
 * Constant-time string comparison to prevent timing attacks.
 * Used for API keys, webhook secrets, HMAC signatures.
 * Pads to same length to avoid leaking key length via early return.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const maxLen = Math.max(a.length, b.length);
  // Pad both to same length to prevent length oracle
  const bufA = encoder.encode(a.padEnd(maxLen, "\0"));
  const bufB = encoder.encode(b.padEnd(maxLen, "\0"));
  let result = a.length ^ b.length; // length mismatch contributes but doesn't early-return
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
