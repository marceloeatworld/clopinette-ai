/**
 * AES-GCM encryption utilities for BYOK API key storage.
 * MASTER_KEY env secret must be a base64-encoded 32-byte random value.
 * Generate with: openssl rand -base64 32
 */

const AES_GCM = "AES-GCM";
const IV_LENGTH = 12;

export async function deriveMasterKey(secret: string): Promise<CryptoKey> {
  let rawKey: Uint8Array;
  try {
    rawKey = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("MASTER_KEY is not valid base64. Generate with: openssl rand -base64 32");
  }
  if (rawKey.length !== 32) {
    throw new Error(
      "MASTER_KEY must be a base64-encoded 32-byte value. Generate with: openssl rand -base64 32"
    );
  }
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: AES_GCM },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(
  plaintext: string,
  masterKey: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv },
    masterKey,
    encoded
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(Array.from(combined, (b) => String.fromCharCode(b)).join(""));
}

export async function decrypt(
  ciphertext: string,
  masterKey: CryptoKey
): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const data = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt(
    { name: AES_GCM, iv },
    masterKey,
    data
  );
  return new TextDecoder().decode(decrypted);
}
