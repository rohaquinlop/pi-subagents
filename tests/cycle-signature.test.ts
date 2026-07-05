import { describe, it, expect } from "vitest";
import {
    extractCycleSignature,
    taskFingerprint,
    normalizeTaskForSignature,
} from "../lib/cycle-signature";

describe("taskFingerprint", () => {
    it("returns consistent output for same input", () => {
        const fp1 = taskFingerprint("hello world");
        const fp2 = taskFingerprint("hello world");
        expect(fp1).toBe(fp2);
    });

    it("returns different output for different inputs", () => {
        const fp1 = taskFingerprint("hello world");
        const fp2 = taskFingerprint("hello world!");
        expect(fp1).not.toBe(fp2);
    });

    it("returns 12 hex chars (48 bits)", () => {
        const fp = taskFingerprint("test input");
        expect(fp).toHaveLength(12);
        expect(fp).toMatch(/^[0-9a-f]{12}$/);
    });

    it("handles empty string", () => {
        const fp = taskFingerprint("");
        expect(fp).toHaveLength(12);
        expect(fp).toMatch(/^[0-9a-f]{12}$/);
    });

    it("handles unicode", () => {
        const fp = taskFingerprint("你好世界");
        expect(fp).toHaveLength(12);
        expect(fp).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe("normalizeTaskForSignature", () => {
    it("strips ## Prior iterations: section", () => {
        const task = "Do something\n\n## Prior iterations:\n--- Iteration 1 output ---\nSome old output";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("do something");
    });

    it("strips ## Key findings section", () => {
        const task = "Analyze code\n\n## Key findings\nFound 3 issues";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("analyze code");
    });

    it("strips ## Implementation results section", () => {
        const task = "Fix bug\n\n## Implementation results\nFixed successfully";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("fix bug");
    });

    it("strips ## Research findings section", () => {
        const task = "Research topic\n\n## Research findings\nFound relevant docs";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("research topic");
    });

    it("collapses whitespace and lowercases", () => {
        const task = "  Do   Something   Important  ";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("do something important");
    });

    it("preserves core task instruction", () => {
        const task = "Read the file at src/index.ts and fix the bug on line 42";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("read the file at src/index.ts and fix the bug on line 42");
    });

    it("handles task with no connector headers", () => {
        const task = "Simple task without any headers";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("simple task without any headers");
    });

    it("strips real scout connector header", () => {
        const task = "Analyze the auth module\n\n## Key findings from codebase exploration:\n\nFound 3 issues";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("analyze the auth module");
    });

    it("strips real worker connector header", () => {
        const task = "Implement feature X\n\n## Implementation results:\n\nDone";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("implement feature x");
    });

    it("strips real researcher connector header", () => {
        const task = "Research topic Y\n\n## Research findings:\n\nFound 5 sources";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("research topic y");
    });

    it("strips real loop prior-iterations header", () => {
        const task = "Do task Z\n\n## Prior iterations:\n\nPrevious output here";
        const normalized = normalizeTaskForSignature(task);
        expect(normalized).toBe("do task z");
    });
});

describe("extractCycleSignature", () => {
    describe("subagent", () => {
        it("produces different signatures for different tasks", () => {
            const sig1 = extractCycleSignature("subagent", { agent: "scout", task: "Find all TypeScript files" });
            const sig2 = extractCycleSignature("subagent", { agent: "scout", task: "Read package.json" });
            expect(sig1).not.toBe(sig2);
        });

        it("produces identical signatures for identical tasks", () => {
            const sig1 = extractCycleSignature("subagent", { agent: "scout", task: "Find all TypeScript files" });
            const sig2 = extractCycleSignature("subagent", { agent: "scout", task: "Find all TypeScript files" });
            expect(sig1).toBe(sig2);
        });

        it("normalizes whitespace and case in tasks", () => {
            const sig1 = extractCycleSignature("subagent", { agent: "scout", task: "Find  All  Files" });
            const sig2 = extractCycleSignature("subagent", { agent: "scout", task: "find all files" });
            expect(sig1).toBe(sig2);
        });

        it("strips connector context before hashing", () => {
            const task1 = "Do something\n\n## Prior iterations:\n--- Iteration 1 output ---\nOld output";
            const task2 = "Do something\n\n## Prior iterations:\n--- Iteration 2 output ---\nDifferent old output";
            const sig1 = extractCycleSignature("subagent", { agent: "worker", task: task1 });
            const sig2 = extractCycleSignature("subagent", { agent: "worker", task: task2 });
            expect(sig1).toBe(sig2);
        });

        it("uses 'notask' placeholder when task is missing", () => {
            const sig1 = extractCycleSignature("subagent", { agent: "scout" });
            const sig2 = extractCycleSignature("subagent", { agent: "scout" });
            expect(sig1).toBe(sig2);
            expect(sig1).toContain("notask");
        });

        it("includes agent name in signature", () => {
            const sig1 = extractCycleSignature("subagent", { agent: "scout", task: "test" });
            const sig2 = extractCycleSignature("subagent", { agent: "researcher", task: "test" });
            expect(sig1).not.toBe(sig2);
            expect(sig1).toContain("scout:");
            expect(sig2).toContain("researcher:");
        });
    });

    describe("read", () => {
        it("produces different signatures for same file at different offsets", () => {
            const sig1 = extractCycleSignature("read", { path: "src/index.ts", offset: 0 });
            const sig2 = extractCycleSignature("read", { path: "src/index.ts", offset: 120 });
            expect(sig1).not.toBe(sig2);
        });

        it("produces identical signatures for same file at same offset", () => {
            const sig1 = extractCycleSignature("read", { path: "src/index.ts", offset: 0 });
            const sig2 = extractCycleSignature("read", { path: "src/index.ts", offset: 0 });
            expect(sig1).toBe(sig2);
        });

        it("defaults offset to 0 when not provided", () => {
            const sig1 = extractCycleSignature("read", { path: "src/index.ts" });
            const sig2 = extractCycleSignature("read", { path: "src/index.ts", offset: 0 });
            expect(sig1).toBe(sig2);
        });

        it("produces different signatures for different limits", () => {
            const sig1 = extractCycleSignature("read", { path: "src/index.ts", offset: 0, limit: 100 });
            const sig2 = extractCycleSignature("read", { path: "src/index.ts", offset: 0, limit: 200 });
            expect(sig1).not.toBe(sig2);
        });

        it("produces different signatures for different paths", () => {
            const sig1 = extractCycleSignature("read", { path: "src/a.ts" });
            const sig2 = extractCycleSignature("read", { path: "src/b.ts" });
            expect(sig1).not.toBe(sig2);
        });
    });

    describe("write", () => {
        it("produces different signatures for same path with different content", () => {
            const sig1 = extractCycleSignature("write", { path: "src/index.ts", content: "const a = 1;" });
            const sig2 = extractCycleSignature("write", { path: "src/index.ts", content: "const b = 2;" });
            expect(sig1).not.toBe(sig2);
        });

        it("produces identical signatures for same path with same content", () => {
            const sig1 = extractCycleSignature("write", { path: "src/index.ts", content: "const a = 1;" });
            const sig2 = extractCycleSignature("write", { path: "src/index.ts", content: "const a = 1;" });
            expect(sig1).toBe(sig2);
        });

        it("uses 'nocontent' placeholder when content is missing", () => {
            const sig = extractCycleSignature("write", { path: "src/index.ts" });
            expect(sig).toContain("nocontent");
        });
    });

    describe("edit", () => {
        it("produces different signatures for same path with different body", () => {
            const sig1 = extractCycleSignature("edit", { path: "src/index.ts", newText: "const a = 1;" });
            const sig2 = extractCycleSignature("edit", { path: "src/index.ts", newText: "const b = 2;" });
            expect(sig1).not.toBe(sig2);
        });

        it("produces identical signatures for same path with same body", () => {
            const sig1 = extractCycleSignature("edit", { path: "src/index.ts", newText: "const a = 1;" });
            const sig2 = extractCycleSignature("edit", { path: "src/index.ts", newText: "const a = 1;" });
            expect(sig1).toBe(sig2);
        });

        it("handles old_string/new_string format", () => {
            const sig1 = extractCycleSignature("edit", { path: "src/index.ts", new_string: "const a = 1;" });
            const sig2 = extractCycleSignature("edit", { path: "src/index.ts", new_string: "const a = 1;" });
            expect(sig1).toBe(sig2);
        });

        it("uses 'noedit' placeholder when no body is provided", () => {
            const sig = extractCycleSignature("edit", { path: "src/index.ts" });
            expect(sig).toContain("noedit");
        });

        it("produces real hash for edits array format", () => {
            const sig = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] });
            expect(sig).toContain("edit:f.ts:");
            expect(sig).not.toContain("noedit");
        });

        it("produces identical signatures for same edits array content", () => {
            const sig1 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] });
            const sig2 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] });
            expect(sig1).toBe(sig2);
        });

        it("produces different signatures for different edits array content", () => {
            const sig1 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] });
            const sig2 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "z" }] });
            expect(sig1).not.toBe(sig2);
        });

        it("produces different signatures for multi-edit vs single-edit arrays", () => {
            const sig1 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
            const sig2 = extractCycleSignature("edit", { path: "f.ts", edits: [{ oldText: "a", newText: "x" }] });
            expect(sig1).not.toBe(sig2);
        });

        it("handles empty edits array gracefully", () => {
            const sig1 = extractCycleSignature("edit", { path: "f.ts", edits: [] });
            const sig2 = extractCycleSignature("edit", { path: "f.ts", edits: [] });
            expect(sig1).toBe(sig2);
            expect(sig1).toContain("edit:f.ts:");
            expect(sig1).toContain("noedit");
        });
    });

    describe("grep", () => {
        it("produces different signatures for same pattern with different path", () => {
            const sig1 = extractCycleSignature("grep", { pattern: "TODO", path: "src/" });
            const sig2 = extractCycleSignature("grep", { pattern: "TODO", path: "lib/" });
            expect(sig1).not.toBe(sig2);
        });

        it("produces different signatures for different exclude patterns", () => {
            const sig1 = extractCycleSignature("grep", { pattern: "TODO", exclude: "*.test.ts" });
            const sig2 = extractCycleSignature("grep", { pattern: "TODO", exclude: "*.spec.ts" });
            expect(sig1).not.toBe(sig2);
        });
    });

    describe("find/fffind", () => {
        it("produces different signatures for different patterns", () => {
            const sig1 = extractCycleSignature("find", { pattern: "*.ts" });
            const sig2 = extractCycleSignature("find", { pattern: "*.js" });
            expect(sig1).not.toBe(sig2);
        });

        it("works for fffind tool", () => {
            const sig = extractCycleSignature("fffind", { pattern: "*.ts", path: "src/" });
            expect(sig).toContain("fffind:");
        });
    });

    describe("ffgrep", () => {
        it("produces different signatures for different patterns", () => {
            const sig1 = extractCycleSignature("ffgrep", { pattern: "TODO" });
            const sig2 = extractCycleSignature("ffgrep", { pattern: "FIXME" });
            expect(sig1).not.toBe(sig2);
        });
    });

    describe("bash", () => {
        it("produces different signatures for different commands", () => {
            const sig1 = extractCycleSignature("bash", { command: "npm test" });
            const sig2 = extractCycleSignature("bash", { command: "npm run build" });
            expect(sig1).not.toBe(sig2);
        });

        it("produces identical signatures for same command", () => {
            const sig1 = extractCycleSignature("bash", { command: "npm test" });
            const sig2 = extractCycleSignature("bash", { command: "npm test" });
            expect(sig1).toBe(sig2);
        });

        it("includes cwd when provided", () => {
            const sig1 = extractCycleSignature("bash", { command: "npm test", cwd: "/home/user/project" });
            const sig2 = extractCycleSignature("bash", { command: "npm test", cwd: "/tmp/other" });
            expect(sig1).not.toBe(sig2);
        });

        it("works for safe_bash tool", () => {
            const sig = extractCycleSignature("safe_bash", { command: "ls -la" });
            expect(sig).toContain("safe_bash:");
        });
    });

    describe("other tools", () => {
        it("handles ls tool", () => {
            const sig = extractCycleSignature("ls", { path: "src/" });
            expect(sig).toBe("ls:src/");
        });

        it("handles web_search tool", () => {
            const sig = extractCycleSignature("web_search", { query: "vitest documentation" });
            expect(sig).toContain("web_search:");
        });

        it("handles web_fetch tool", () => {
            const sig = extractCycleSignature("web_fetch", { url: "https://example.com" });
            expect(sig).toContain("web_fetch:");
        });

        it("handles gh_cli tool", () => {
            const sig = extractCycleSignature("gh_cli", { command: "pr list" });
            expect(sig).toContain("gh_cli:");
        });

        it("handles read_pdf tool", () => {
            const sig = extractCycleSignature("read_pdf", { path: "document.pdf" });
            expect(sig).toContain("read_pdf:");
        });

        it("handles unknown tools with JSON fallback", () => {
            const sig = extractCycleSignature("unknown_tool", { foo: "bar" });
            expect(sig).toContain("unknown_tool:");
        });
    });

    describe("edge cases", () => {
        it("handles empty args gracefully", () => {
            const sig = extractCycleSignature("bash", {});
            expect(sig).toBeDefined();
            expect(typeof sig).toBe("string");
        });

        it("handles missing args gracefully", () => {
            const sig = extractCycleSignature("read", {});
            expect(sig).toBeDefined();
            expect(sig).toContain("read:");
        });

        it("caps long argument strings", () => {
            const longCommand = "a".repeat(200);
            const sig = extractCycleSignature("bash", { command: longCommand });
            // The signature should be capped but still contain the tool name
            expect(sig).toContain("bash:");
            expect(sig.length).toBeLessThan(300);
        });
    });
});
