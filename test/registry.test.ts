import { describe, it, expect, vi } from "vitest";

// Mock codemode modules (they use cloudflare: protocol unavailable in Node)
vi.mock("@cloudflare/codemode/ai", () => ({
  createCodeTool: vi.fn(({ tools }) => ({
    description: "codemode tool",
    inputSchema: {},
    execute: async () => ({ ok: true }),
    _wrappedToolNames: Object.keys(tools),
  })),
}));

vi.mock("@cloudflare/codemode", () => ({
  DynamicWorkerExecutor: class FakeExecutor {
    constructor() {}
  },
}));

// Import AFTER mocks are set up
const { buildTools, resolveTools } = await import("../src/tools/registry.js");

// Minimal mock context — tools won't execute, we just test structure
function mockCtx(loader?: unknown) {
  const sql = <T>(_s: TemplateStringsArray, ..._v: unknown[]): T[] => [] as T[];
  return {
    sql,
    r2Memories: {} as unknown as R2Bucket,
    r2Skills: {} as unknown as R2Bucket,
    ai: {} as unknown as Ai,
    userId: "test-user",
    sessionId: "test-session",
    cfAccountId: "fake-account",
    env: { GATEWAY_URL: undefined, GATEWAY_INTERNAL_KEY: undefined, WS_SIGNING_SECRET: "test" },
    loader: loader as WorkerLoader | undefined,
  };
}

// New unified tool names
const PRIMARY_TOOL_NAMES = [
  "memory",
  "history",
  "skills",
  "todo",
  "docs",
  "web",
  "notes",
  "calendar",
  "tts",
  "image",
  "clarify",
];

const ALIAS_NAMES = [
  // Backward-compat (old names → new tools)
  "session_search",
  "save_note",
  "note",
  "text_to_speech",
  "image_generate",
  "web_search",
  "web_browse",
  "web_crawl",
  "docs_search",
  "ai_search",
  // LLM hallucination aliases
  "search_docs",
  "doc_search",
  "search_sessions",
  "memory_search",
  "aisearch",
  "search_web",
  "search",
];

const ALL_TOOL_NAMES = [...PRIMARY_TOOL_NAMES, ...ALIAS_NAMES];

describe("tool registry", () => {
  describe("buildTools", () => {
    it("returns all primary tools + aliases", () => {
      const tools = buildTools(mockCtx());
      const names = Object.keys(tools);
      expect(names).toEqual(ALL_TOOL_NAMES);
      expect(names).toHaveLength(28); // 11 primary + 17 aliases
    });

    it("each primary tool has description and execute", () => {
      const tools = buildTools(mockCtx());
      for (const name of PRIMARY_TOOL_NAMES) {
        const tool = tools[name as keyof typeof tools];
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("execute");
      }
    });

    it("backward-compat aliases point to the new tools", () => {
      const tools = buildTools(mockCtx()) as Record<string, unknown>;
      // Old → new mappings
      expect(tools.session_search).toBe(tools.history);
      expect(tools.save_note).toBe(tools.notes);
      expect(tools.note).toBe(tools.notes);
      expect(tools.text_to_speech).toBe(tools.tts);
      expect(tools.image_generate).toBe(tools.image);
      expect(tools.web_search).toBe(tools.web);
      expect(tools.web_browse).toBe(tools.web);
      expect(tools.web_crawl).toBe(tools.web);
      expect(tools.docs_search).toBe(tools.docs);
      expect(tools.ai_search).toBe(tools.docs);
      // Hallucination aliases
      expect(tools.search_docs).toBe(tools.docs);
      expect(tools.search_web).toBe(tools.web);
      expect(tools.search).toBe(tools.web);
      expect(tools.memory_search).toBe(tools.history);
    });
  });

  describe("resolveTools", () => {
    it("returns all tools with aliases when LOADER is absent", () => {
      const tools = resolveTools(mockCtx());
      expect(Object.keys(tools)).toEqual(ALL_TOOL_NAMES);
    });

    it("returns codemode + direct action tools when LOADER is present", () => {
      const fakeLoader = { load: () => {}, get: () => {} };
      const tools = resolveTools(mockCtx(fakeLoader));
      const toolKeys = Object.keys(tools);
      expect(toolKeys).toContain("codemode");
      expect(toolKeys).toContain("web");
      expect(toolKeys).toContain("docs");
      expect(toolKeys).toContain("image");
      expect(toolKeys).toContain("tts");
      expect(toolKeys).toContain("clarify");
      expect(toolKeys).toContain("notes");
      expect(toolKeys).toContain("calendar");
      expect(toolKeys).toHaveLength(8); // codemode + web + docs + image + tts + clarify + notes + calendar
    });

    it("codemode wraps orchestration tools only (not action tools)", () => {
      const fakeLoader = { load: () => {}, get: () => {} };
      const tools = resolveTools(mockCtx(fakeLoader));
      const codemodeTool = tools.codemode as unknown as { _wrappedToolNames: string[] };
      // Should NOT contain direct tools
      expect(codemodeTool._wrappedToolNames).not.toContain("image");
      expect(codemodeTool._wrappedToolNames).not.toContain("tts");
      expect(codemodeTool._wrappedToolNames).not.toContain("clarify");
      expect(codemodeTool._wrappedToolNames).not.toContain("notes");
      expect(codemodeTool._wrappedToolNames).not.toContain("calendar");
      expect(codemodeTool._wrappedToolNames).not.toContain("web");
      expect(codemodeTool._wrappedToolNames).not.toContain("docs");
      // Should contain core orchestration tools
      expect(codemodeTool._wrappedToolNames).toContain("memory");
      expect(codemodeTool._wrappedToolNames).toContain("history");
      expect(codemodeTool._wrappedToolNames).toContain("skills");
      expect(codemodeTool._wrappedToolNames).toContain("todo");
    });
  });
});
