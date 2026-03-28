import { describe, it, expect } from "vitest";
import { loadInferenceConfig } from "../src/inference/provider.js";
import { deriveMasterKey, encrypt } from "../src/crypto.js";

const TEST_KEY_B64 = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
);

type MockRow = { key: string; value: string; encrypted: number };

function createMockSql(rows: MockRow[]) {
  return <T>(_strings: TemplateStringsArray, ..._values: unknown[]): T[] => {
    return rows as T[];
  };
}

describe("loadInferenceConfig", () => {
  it("returns defaults when no config exists", async () => {
    const config = await loadInferenceConfig(createMockSql([]), TEST_KEY_B64);
    expect(config.model).toBe("@cf/moonshotai/kimi-k2.5");
    expect(config.apiKey).toBeUndefined();
    expect(config.provider).toBeUndefined();
  });

  it("loads plaintext config", async () => {
    const sql = createMockSql([
      { key: "model", value: "gpt-4o", encrypted: 0 },
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "api_key", value: "sk-test-123", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("gpt-4o");
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("sk-test-123");
  });

  it("decrypts encrypted API key", async () => {
    const masterKey = await deriveMasterKey(TEST_KEY_B64);
    const encryptedKey = await encrypt("sk-secret-key", masterKey);

    const sql = createMockSql([
      { key: "model", value: "@cf/moonshotai/kimi-k2.5", encrypted: 0 },
      { key: "api_key", value: encryptedKey, encrypted: 1 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBe("sk-secret-key");
  });

  it("uses default model when model row is missing", async () => {
    const sql = createMockSql([
      { key: "provider", value: "anthropic", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("@cf/moonshotai/kimi-k2.5");
    expect(config.provider).toBe("anthropic");
  });
});
