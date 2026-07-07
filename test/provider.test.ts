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
    expect(config.model).toBe("@cf/moonshotai/kimi-k2.6");
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
      { key: "model", value: "@cf/moonshotai/kimi-k2.6", encrypted: 0 },
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
    expect(config.model).toBe("@cf/moonshotai/kimi-k2.6");
    expect(config.provider).toBe("anthropic");
  });

  it("loads per-provider API key (api_key:{provider}) matching current provider", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model", value: "gpt-4o", encrypted: 0 },
      { key: "api_key:openai", value: "sk-openai-live", encrypted: 0 },
      { key: "api_key:anthropic", value: "sk-ant-live", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBe("sk-openai-live");
    expect(config.provider).toBe("openai");
  });

  it("falls back to legacy api_key when no per-provider key is present", async () => {
    const sql = createMockSql([
      { key: "provider", value: "anthropic", encrypted: 0 },
      { key: "api_key", value: "sk-legacy", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBe("sk-legacy");
  });

  it("picks per-provider key over legacy api_key when both exist", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "api_key", value: "sk-legacy", encrypted: 0 },
      { key: "api_key:openai", value: "sk-new", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBe("sk-new");
  });

  it("returns undefined apiKey when provider has no saved key", async () => {
    const sql = createMockSql([
      { key: "provider", value: "groq", encrypted: 0 },
      { key: "api_key:openai", value: "sk-openai-only", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBeUndefined();
  });

  it("loads per-provider model (model:{provider}) matching current provider", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model:openai", value: "gpt-4o", encrypted: 0 },
      { key: "model:anthropic", value: "claude-3-5-sonnet", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("gpt-4o");
    expect(config.provider).toBe("openai");
  });

  it("falls back to legacy model row when no per-provider model exists", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model", value: "gpt-legacy", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("gpt-legacy");
  });

  it("prefers per-provider model over legacy when both exist", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model", value: "gpt-legacy", encrypted: 0 },
      { key: "model:openai", value: "gpt-4o", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("gpt-4o");
  });

  it("uses DEFAULT_MODEL when neither per-provider nor legacy model is set", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.model).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("auxiliary defaults to platform AUXILIARY_MODEL (Gemma) for Workers AI users", async () => {
    const sql = createMockSql([
      { key: "provider", value: "workers-ai", encrypted: 0 },
      { key: "model:workers-ai", value: "@cf/moonshotai/kimi-k2.6", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.auxiliaryModel).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("auxiliary uses configured auxiliary_model:{provider} when set", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model:openai", value: "gpt-4o", encrypted: 0 },
      { key: "auxiliary_model:openai", value: "gpt-4o-mini", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.auxiliaryModel).toBe("gpt-4o-mini");
  });

  it("auxiliary falls back to primary model for BYOK users without explicit auxiliary", async () => {
    const sql = createMockSql([
      { key: "provider", value: "anthropic", encrypted: 0 },
      { key: "model:anthropic", value: "claude-opus-4", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    // No auxiliary_model:anthropic → use primary to avoid forcing Workers AI on BYOK
    expect(config.auxiliaryModel).toBe("claude-opus-4");
  });

  it("loads cross-provider auxiliary with separate credentials", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model:openai", value: "gpt-4o", encrypted: 0 },
      { key: "api_key:openai", value: "sk-openai-xxx", encrypted: 0 },
      { key: "auxiliary_provider", value: "anthropic", encrypted: 0 },
      { key: "auxiliary_model:anthropic", value: "claude-haiku-4", encrypted: 0 },
      { key: "api_key:anthropic", value: "sk-ant-yyy", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("sk-openai-xxx");
    expect(config.model).toBe("gpt-4o");
    expect(config.auxiliaryProvider).toBe("anthropic");
    expect(config.auxiliaryApiKey).toBe("sk-ant-yyy");
    expect(config.auxiliaryModel).toBe("claude-haiku-4");
  });

  it("shares credentials when auxiliary provider equals primary provider", async () => {
    const sql = createMockSql([
      { key: "provider", value: "openai", encrypted: 0 },
      { key: "model:openai", value: "gpt-4o", encrypted: 0 },
      { key: "api_key:openai", value: "sk-openai-xxx", encrypted: 0 },
      { key: "auxiliary_model:openai", value: "gpt-4o-mini", encrypted: 0 },
    ]);
    const config = await loadInferenceConfig(sql, TEST_KEY_B64);
    expect(config.apiKey).toBe("sk-openai-xxx");
    expect(config.auxiliaryApiKey).toBe("sk-openai-xxx");
    expect(config.auxiliaryModel).toBe("gpt-4o-mini");
  });
});
