import { describe, it, expect } from "vitest";
import { deriveMasterKey, encrypt, decrypt } from "../src/crypto.js";

// Generate a valid base64 32-byte key for tests
const TEST_KEY_B64 = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
);

describe("crypto", () => {
  it("deriveMasterKey returns a CryptoKey", async () => {
    const key = await deriveMasterKey(TEST_KEY_B64);
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
  });

  it("deriveMasterKey rejects invalid key length", async () => {
    const shortKey = btoa("too-short");
    await expect(deriveMasterKey(shortKey)).rejects.toThrow("32-byte");
  });

  it("encrypt/decrypt round-trip", async () => {
    const key = await deriveMasterKey(TEST_KEY_B64);
    const plaintext = "sk-my-secret-api-key-12345";
    const ciphertext = await encrypt(plaintext, key);

    // Ciphertext should be base64
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Ciphertext should differ from plaintext
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("different IVs produce different ciphertexts", async () => {
    const key = await deriveMasterKey(TEST_KEY_B64);
    const plaintext = "same-input";
    const c1 = await encrypt(plaintext, key);
    const c2 = await encrypt(plaintext, key);
    expect(c1).not.toBe(c2); // random IV → different output
  });

  it("decrypt with wrong key fails", async () => {
    const key1 = await deriveMasterKey(TEST_KEY_B64);
    const key2B64 = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
    );
    const key2 = await deriveMasterKey(key2B64);

    const ciphertext = await encrypt("secret", key1);
    await expect(decrypt(ciphertext, key2)).rejects.toThrow();
  });
});
