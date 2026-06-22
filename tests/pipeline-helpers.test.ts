import { describe, it, expect } from "vitest";
import { zeroUsage, accumulateUsage, validateAgents, MAX_LOOP_CONTEXT } from "../lib/pipeline-helpers";
import type { AgentConfig } from "../lib/types";

function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        name,
        description: `Agent ${name}`,
        tools: [],
        model: "test/model",
        thinking: "medium",
        systemPrompt: "You are a test agent.",
        filePath: `/agents/${name}.md`,
        ...overrides,
    };
}

describe("zeroUsage", () => {
    it("returns all zeros", () => {
        const u = zeroUsage();
        expect(u.input).toBe(0);
        expect(u.output).toBe(0);
        expect(u.cacheRead).toBe(0);
        expect(u.cacheWrite).toBe(0);
        expect(u.cost).toBe(0);
        expect(u.turns).toBe(0);
    });
});

describe("accumulateUsage", () => {
    it("sums two usage objects correctly", () => {
        const a = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01, turns: 1 };
        const b = { input: 20, output: 15, cacheRead: 3, cacheWrite: 2, cost: 0.02, turns: 2 };
        const result = accumulateUsage(a, b);
        expect(result.input).toBe(30);
        expect(result.output).toBe(20);
        expect(result.cacheRead).toBe(5);
        expect(result.cacheWrite).toBe(3);
        expect(result.cost).toBeCloseTo(0.03);
        expect(result.turns).toBe(3);
    });

    it("accumulates from zero", () => {
        const z = zeroUsage();
        const step = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 1 };
        const result = accumulateUsage(z, step);
        expect(result).toEqual(step);
    });
});

describe("validateAgents", () => {
    const agents: AgentConfig[] = [
        makeAgent("scout"),
        makeAgent("worker"),
        makeAgent("researcher"),
    ];

    it("returns null when all agents exist", () => {
        expect(validateAgents(["scout", "worker"], agents)).toBeNull();
    });

    it("returns the first missing agent name", () => {
        expect(validateAgents(["scout", "nonexistent", "worker"], agents)).toBe("nonexistent");
    });

    it("returns null for empty list", () => {
        expect(validateAgents([], agents)).toBeNull();
    });

    it("returns missing name for single missing agent", () => {
        expect(validateAgents(["ghost"], agents)).toBe("ghost");
    });
});

describe("MAX_LOOP_CONTEXT", () => {
    it("is 48000", () => {
        expect(MAX_LOOP_CONTEXT).toBe(48000);
    });
});
