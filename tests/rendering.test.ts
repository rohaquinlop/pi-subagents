import { describe, it, expect } from "vitest";
import type { PipelineResult, LoopResult, AgentUsage, PipelineStepResult, LoopIterationResult } from "../lib/types";

describe("PipelineResult shape", () => {
    it("accepts a complete pipeline result", () => {
        const result: PipelineResult = {
            steps: [],
            finalOutput: "",
            totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            totalDurationMs: 0,
        };
        expect(result.steps).toEqual([]);
        expect(result.finalOutput).toBe("");
    });

    it("accepts a pipeline result with stoppedAt and error", () => {
        const result: PipelineResult = {
            steps: [
                { agent: "scout", task: "test", output: "ok", exitCode: 0, 
                  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                  durationMs: 100 },
                { agent: "worker", task: "test", output: "", exitCode: 1,
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
                  durationMs: 50 },
            ],
            finalOutput: "ok",
            stoppedAt: 1,
            error: "Agent worker exited with code 1",
            totalUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            totalDurationMs: 150,
        };
        expect(result.stoppedAt).toBe(1);
        expect(result.error).toContain("worker");
    });

    it("accepts a pipeline result with currentStep for live updates", () => {
        const result: PipelineResult & { currentStep?: number } = {
            steps: [{ agent: "scout", task: "test", output: "ok", exitCode: 0,
                      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
                      durationMs: 100 }],
            currentStep: 1,
            finalOutput: "",
            totalUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            totalDurationMs: 100,
        };
        expect(result.currentStep).toBe(1);
    });
});

describe("LoopResult shape", () => {
    const zeroUsage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

    it("accepts a complete loop result (max iterations)", () => {
        const result: LoopResult = {
            iterations: [
                { iteration: 1, output: "draft", exitCode: 0, usage: zeroUsage, durationMs: 100 },
                { iteration: 2, output: "final", exitCode: 0, usage: zeroUsage, durationMs: 100 },
            ],
            finalOutput: "final",
            stoppedBecause: "max_iterations",
            totalUsage: zeroUsage,
            totalDurationMs: 200,
        };
        expect(result.iterations.length).toBe(2);
        expect(result.stoppedBecause).toBe("max_iterations");
    });

    it("accepts a loop result with judge satisfied", () => {
        const result: LoopResult = {
            iterations: [
                { iteration: 1, output: "draft", exitCode: 0, usage: zeroUsage, durationMs: 100,
                  judgeVerdict: { satisfied: false, response: "NO, needs work" } },
                { iteration: 2, output: "final", exitCode: 0, usage: zeroUsage, durationMs: 100,
                  judgeVerdict: { satisfied: true, response: "YES" } },
            ],
            finalOutput: "final",
            stoppedBecause: "judge_satisfied",
            totalUsage: zeroUsage,
            totalDurationMs: 200,
        };
        expect(result.stoppedBecause).toBe("judge_satisfied");
    });

    it("accepts a loop result with error", () => {
        const result: LoopResult = {
            iterations: [
                { iteration: 1, output: "", exitCode: 1, usage: zeroUsage, durationMs: 100 },
            ],
            finalOutput: "",
            stoppedBecause: "error",
            totalUsage: zeroUsage,
            totalDurationMs: 100,
        };
        expect(result.stoppedBecause).toBe("error");
    });
});
