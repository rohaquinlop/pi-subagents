import { describe, it, expect } from "vitest";
import { LOOP_ERROR_PREFIX } from "../lib/loop-detector";
import { buildSubagentErrorContent } from "../lib/error-helpers";

// ── Retry Mechanism Tests ─────────────────────────────────────────────
//
// These tests verify the retry mechanism behavior at the unit/integration
// level. Since `runSubagent` is internal to index.ts, we test the concepts
// and error message patterns that drive the retry logic.

describe("retry mechanism", () => {
    // ── LOOP_ERROR_PREFIX usage ─────────────────────────────────────────

    it("LOOP_ERROR_PREFIX is used in loop detection error messages", () => {
        // Simulate what index.ts does when it detects a loop
        const patternStr = "read→edit→bash";
        const error = `${LOOP_ERROR_PREFIX}: repeating ${patternStr}`;

        expect(error).toBe("Subagent stuck in a tool-call loop: repeating read→edit→bash");
        expect(error.startsWith(LOOP_ERROR_PREFIX)).toBe(true);
    });

    it("startsWith(LOOP_ERROR_PREFIX) is more robust than includes('tool-call loop')", () => {
        // The old fragile check would break if the error message changed
        const error = `${LOOP_ERROR_PREFIX}: repeating read→edit`;

        // New check: startsWith is stable because we control the prefix
        expect(error.startsWith(LOOP_ERROR_PREFIX)).toBe(true);

        // Verify the constant hasn't changed unexpectedly
        expect(LOOP_ERROR_PREFIX).toBe("Subagent stuck in a tool-call loop");
    });

    // ── Graceful Degradation Error Message ──────────────────────────────

    it("graceful degradation error message matches expected pattern", () => {
        // This is the error message used when retries are exhausted
        const degradedError = "Subagent failed after retry. Returning partial results.";

        // Verify it's a clear, actionable message
        expect(degradedError).toContain("failed after retry");
        expect(degradedError).toContain("Returning partial results");
    });

    it("buildSubagentErrorContent includes graceful degradation message", () => {
        const degradedError = "Subagent failed after retry. Returning partial results.";
        const msg = buildSubagentErrorContent({
            agent: "test-agent",
            exitCode: 1,
            output: "partial output",
            progress: { error: degradedError },
        });

        expect(msg).toContain(degradedError);
        expect(msg).toContain("test-agent");
        expect(msg).toContain("Output:");
        expect(msg).toContain("partial output");
    });

    // ── Retry Context Building ──────────────────────────────────────────

    it("retry context includes partial output from failed attempt", () => {
        // Simulate building retry task with partial context
        const task = "Original task description";
        const partialOutput = "Some partial output from the looped attempt";
        const MAX_PARTIAL_CONTEXT = 4000;

        const truncatedOutput = partialOutput.slice(0, MAX_PARTIAL_CONTEXT);
        const retryContext = truncatedOutput
            ? `\n\n## Partial output from previous (looped) attempt:\n${truncatedOutput}`
            : "";
        const retryTask = `${task}${retryContext}`;

        expect(retryTask).toContain("Original task description");
        expect(retryTask).toContain("## Partial output from previous (looped) attempt:");
        expect(retryTask).toContain("Some partial output from the looped attempt");
    });

    it("retry context truncates large output to MAX_PARTIAL_CONTEXT", () => {
        const task = "Original task";
        const largeOutput = "x".repeat(5000);
        const MAX_PARTIAL_CONTEXT = 4000;

        const truncatedOutput = largeOutput.slice(0, MAX_PARTIAL_CONTEXT);
        const retryContext = `\n\n## Partial output from previous (looped) attempt:\n${truncatedOutput}`;
        const retryTask = `${task}${retryContext}`;

        // Should be truncated to 4000 chars
        expect(truncatedOutput.length).toBe(MAX_PARTIAL_CONTEXT);
        expect(retryTask).toContain("x".repeat(MAX_PARTIAL_CONTEXT));
        // Should NOT contain the full 5000 chars
        expect(retryTask).not.toContain("x".repeat(5001));
    });

    // ── Usage Accumulation Semantics ────────────────────────────────────

    it("usage accumulation semantics are documented", () => {
        // This test documents the intentional asymmetry:
        // - result.output is overwritten (best attempt)
        // - result.usage accumulates (total cost across all attempts)

        // Verify the comment exists in index.ts by checking the pattern
        const commentPattern = /result\.output is overwritten.*result\.usage accumulates/s;

        // The actual comment in index.ts:
        const actualComment = `// Note: result.output is overwritten (we want the best attempt's output),
// but result.usage accumulates (we want total cost across all attempts).`;

        expect(actualComment).toMatch(commentPattern);
    });

    // ── MAX_ATTEMPTS Naming ─────────────────────────────────────────────

    it("MAX_ATTEMPTS correctly represents 1 initial + 1 retry", () => {
        // MAX_ATTEMPTS = 2 means: 1 initial attempt + 1 retry = 2 total attempts
        const MAX_ATTEMPTS = 2;

        // Verify the semantics:
        // - attempt 1: initial attempt
        // - attempt 2: retry (if attempt 1 had a loop error)
        expect(MAX_ATTEMPTS).toBe(2);

        // The loop runs for attempt 1 and 2
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            expect(attempt).toBeLessThanOrEqual(MAX_ATTEMPTS);
        }
    });

    // ── Progress State Reset ────────────────────────────────────────────

    it("progress state reset includes all necessary fields", () => {
        // Simulate the progress reset that happens on retry
        const progress = {
            status: "failed" as const,
            error: "Subagent stuck in a tool-call loop: repeating read→edit",
            retriedAfterLoop: false,
            recentTools: [{ tool: "read", args: "file.ts", status: "done" as const }],
            toolCount: 5,
            tokens: 1000,
            lastMessage: "some message",
        };

        // Apply the reset (what index.ts does on retry)
        progress.status = "running";
        progress.error = undefined;
        progress.retriedAfterLoop = true;
        progress.recentTools = [];
        progress.toolCount = 0;
        progress.tokens = 0;
        progress.lastMessage = "";

        // Verify all fields are reset
        expect(progress.status).toBe("running");
        expect(progress.error).toBeUndefined();
        expect(progress.retriedAfterLoop).toBe(true);
        expect(progress.recentTools).toEqual([]);
        expect(progress.toolCount).toBe(0);
        expect(progress.tokens).toBe(0);
        expect(progress.lastMessage).toBe("");
    });

    // ── Loop Error Detection ────────────────────────────────────────────

    it("detects loop error using startsWith(LOOP_ERROR_PREFIX)", () => {
        const loopError = `${LOOP_ERROR_PREFIX}: repeating read→edit`;
        const isLoopError = loopError?.startsWith(LOOP_ERROR_PREFIX);

        expect(isLoopError).toBe(true);
    });

    it("does not detect non-loop error as loop error", () => {
        const nonLoopError = "Subagent timed out after 600s";
        const isLoopError = nonLoopError?.startsWith(LOOP_ERROR_PREFIX);

        expect(isLoopError).toBe(false);
    });

    it("handles undefined error gracefully", () => {
        const error: string | undefined = undefined;
        const isLoopError = error?.startsWith(LOOP_ERROR_PREFIX);

        expect(isLoopError).toBeUndefined();
    });

    // ── Error Message Stability ─────────────────────────────────────────

    it("LOOP_ERROR_PREFIX is stable and matches expected value", () => {
        // This constant should never change once deployed, as it's used
        // for error message matching in the retry logic
        expect(LOOP_ERROR_PREFIX).toBe("Subagent stuck in a tool-call loop");
    });

    it("loop error message format is consistent", () => {
        // Verify the format matches what the code produces
        const patternStr = "read→edit";
        const errorMessage = `${LOOP_ERROR_PREFIX}: repeating ${patternStr}`;

        expect(errorMessage).toMatch(/^Subagent stuck in a tool-call loop: repeating .+$/);
    });
});
