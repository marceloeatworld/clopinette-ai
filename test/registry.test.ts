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

describe("tool registry", () => {
  describe("buildTools", () => {
    it("returns exactly the primary tools (no alias duplicates in the LLM schema)", () => {
      const tools = buildTools(mockCtx());
      const names = Object.keys(tools);
      expect(names).toEqual(PRIMARY_TOOL_NAMES);
      expect(names).toHaveLength(11);
    });

    it("each primary tool has description and execute", () => {
      const tools = buildTools(mockCtx());
      for (const name of PRIMARY_TOOL_NAMES) {
        const tool = tools[name as keyof typeof tools];
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("execute");
      }
    });

    it("does not expose old alias names (fuzzy dispatch handles them)", () => {
      const tools = buildTools(mockCtx()) as Record<string, unknown>;
      for (const alias of ["session_search", "save_note", "text_to_speech", "web_search", "docs_search", "search"]) {
        expect(tools[alias]).toBeUndefined();
      }
    });
  });

  describe("resolveTools", () => {
    it("returns the primary tools when LOADER is absent", () => {
      const tools = resolveTools(mockCtx());
      expect(Object.keys(tools)).toEqual(PRIMARY_TOOL_NAMES);
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
      expect(codemodeTool._wrappedToolNames).not.toContain("delegate");
      // Should contain core orchestration tools
      expect(codemodeTool._wrappedToolNames).toContain("memory");
      expect(codemodeTool._wrappedToolNames).toContain("history");
      expect(codemodeTool._wrappedToolNames).toContain("skills");
      expect(codemodeTool._wrappedToolNames).toContain("todo");
    });
  });
});
