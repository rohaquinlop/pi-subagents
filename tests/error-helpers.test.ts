import { describe, it, expect } from "vitest";
import {
    buildSubagentErrorContent,
    buildPipelineErrorContent,
    buildLoopErrorContent,
} from "../lib/error-helpers";

// ── buildSubagentErrorContent ─────────────────────────────────────────

describe("buildSubagentErrorContent", () => {
    function makeResult(overrides: {
        error?: string;
        lastMessage?: string;
        output?: string;
        exitCode?: number;
    } = {}) {
        return {
            agent: "test-agent",
            exitCode: overrides.exitCode ?? 1,
            output: overrides.output ?? "",
            progress: {
                error: overrides.error,
                lastMessage: overrides.lastMessage,
            },
        };
    }

    it("includes agent name and exit code", () => {
        const msg = buildSubagentErrorContent(makeResult({ exitCode: 42 }));
        expect(msg).toContain('Agent "test-agent"');
        expect(msg).toContain("exit code 42");
    });

    it("includes Error when progress.error present", () => {
        const msg = buildSubagentErrorContent(makeResult({ error: "something broke" }));
        expect(msg).toContain("Error: something broke");
    });

    it("omits Error when progress.error absent", () => {
        const msg = buildSubagentErrorContent(makeResult());
        expect(msg).not.toContain("Error:");
    });

    it("includes Last message when progress.lastMessage present", () => {
        const msg = buildSubagentErrorContent(makeResult({ lastMessage: "final thought" }));
        expect(msg).toContain("Last message: final thought");
    });

    it("omits Last message when progress.lastMessage absent", () => {
        const msg = buildSubagentErrorContent(makeResult());
        expect(msg).not.toContain("Last message:");
    });

    it("includes Output block when output is truthy and not (no output)", () => {
        const msg = buildSubagentErrorContent(makeResult({ output: "some output" }));
        expect(msg).toContain("Output:\n");
        expect(msg).toContain("some output");
    });

    it("omits Output when output is empty", () => {
        const msg = buildSubagentErrorContent(makeResult({ output: "" }));
        expect(msg).not.toContain("Output:");
    });

    it("omits Output when output is (no output)", () => {
        const msg = buildSubagentErrorContent(makeResult({ output: "(no output)" }));
        expect(msg).not.toContain("Output:");
    });
});

// ── buildPipelineErrorContent ─────────────────────────────────────────

describe("buildPipelineErrorContent", () => {
    function makeResult(overrides: {
        error?: string;
        output?: string;
        exitCode?: number;
    } = {}) {
        return {
            exitCode: overrides.exitCode ?? 1,
            output: overrides.output ?? "",
            progress: {
                error: overrides.error,
            },
        };
    }

    it("includes step N+1 and agent name", () => {
        const msg = buildPipelineErrorContent(2, "scout", makeResult());
        expect(msg).toContain("Pipeline failed at step 3 (agent: scout).");
    });

    it("includes exit code", () => {
        const msg = buildPipelineErrorContent(0, "worker", makeResult({ exitCode: 127 }));
        expect(msg).toContain("Exit code: 127");
    });

    it("includes Error when progress.error present", () => {
        const msg = buildPipelineErrorContent(0, "worker", makeResult({ error: "timeout" }));
        expect(msg).toContain("Error: timeout");
    });

    it("omits Error when progress.error absent", () => {
        const msg = buildPipelineErrorContent(0, "worker", makeResult());
        expect(msg).not.toContain("Error:");
    });

    it("includes Output when output is truthy", () => {
        const msg = buildPipelineErrorContent(0, "worker", makeResult({ output: "details here" }));
        expect(msg).toContain("Output:\n");
        expect(msg).toContain("details here");
    });

    it("shows (no output) when output is empty", () => {
        const msg = buildPipelineErrorContent(0, "worker", makeResult({ output: "" }));
        expect(msg).toContain("(no output)");
    });

    it("edge case: empty output AND no error — has header, exit code, and (no output)", () => {
        const msg = buildPipelineErrorContent(1, "researcher", { exitCode: 2, output: "", progress: {} });
        expect(msg).toContain("Pipeline failed at step 2 (agent: researcher).");
        expect(msg).toContain("Exit code: 2");
        expect(msg).toContain("(no output)");
        // No blank lines in output
        expect(msg).not.toMatch(/\n\n/);
        expect(msg).not.toMatch(/^\s*$/m);
    });
});

// ── buildLoopErrorContent ─────────────────────────────────────────────

describe("buildLoopErrorContent", () => {
    function makeResult(overrides: {
        error?: string;
        output?: string;
        exitCode?: number;
    } = {}) {
        return {
            exitCode: overrides.exitCode ?? 1,
            output: overrides.output ?? "",
            progress: {
                error: overrides.error,
            },
        };
    }

    it("includes iteration N+1 and agent name", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult());
        expect(msg).toContain("Loop failed at iteration 1 (agent: coder).");
    });

    it("includes iteration N+1 for later iterations", () => {
        const msg = buildLoopErrorContent(3, "coder", makeResult());
        expect(msg).toContain("Loop failed at iteration 4 (agent: coder).");
    });

    it("includes exit code", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult({ exitCode: 137 }));
        expect(msg).toContain("Exit code: 137");
    });

    it("includes Error when progress.error present", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult({ error: "out of memory" }));
        expect(msg).toContain("Error: out of memory");
    });

    it("omits Error when progress.error absent", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult());
        expect(msg).not.toContain("Error:");
    });

    it("includes Output when output is truthy", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult({ output: "stack trace" }));
        expect(msg).toContain("Output:\n");
        expect(msg).toContain("stack trace");
    });

    it("shows (no output) when output is empty", () => {
        const msg = buildLoopErrorContent(0, "coder", makeResult({ output: "" }));
        expect(msg).toContain("(no output)");
    });

    it("edge case: empty output AND no error — has header, exit code, and (no output)", () => {
        const msg = buildLoopErrorContent(0, "coder", { exitCode: 1, output: "", progress: {} });
        expect(msg).toContain("Loop failed at iteration 1 (agent: coder).");
        expect(msg).toContain("Exit code: 1");
        expect(msg).toContain("(no output)");
        // No blank lines in output
        expect(msg).not.toMatch(/\n\n/);
        expect(msg).not.toMatch(/^\s*$/m);
    });
});
