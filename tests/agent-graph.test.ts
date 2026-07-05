import { describe, it, expect } from "vitest";
import { validateAgentGraphAcyclicity } from "../lib/agent-graph";
import type { AgentConfig } from "../lib/types";

function makeAgent(name: string, subagentAgents?: string[]): AgentConfig {
    return {
        name,
        description: `Agent ${name}`,
        tools: ["read", "write"],
        model: "test/model",
        thinking: "off",
        systemPrompt: `You are ${name}.`,
        filePath: `/agents/${name}.md`,
        subagentAgents,
    };
}

describe("validateAgentGraphAcyclicity", () => {
    it("returns null for an acyclic tree", () => {
        const agents = [
            makeAgent("root", ["child1", "child2"]),
            makeAgent("child1", ["grandchild"]),
            makeAgent("child2"),
            makeAgent("grandchild"),
        ];
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("detects a 2-node cycle A → B → A", () => {
        const agents = [
            makeAgent("A", ["B"]),
            makeAgent("B", ["A"]),
        ];
        const result = validateAgentGraphAcyclicity(agents);
        expect(result).not.toBeNull();
        expect(result).toContain("A");
        expect(result).toContain("B");
        expect(result).toContain("→");
    });

    it("detects a 3-node cycle A → B → C → A", () => {
        const agents = [
            makeAgent("A", ["B"]),
            makeAgent("B", ["C"]),
            makeAgent("C", ["A"]),
        ];
        const result = validateAgentGraphAcyclicity(agents);
        expect(result).not.toBeNull();
        expect(result).toContain("A");
        expect(result).toContain("B");
        expect(result).toContain("C");
    });

    it("detects a self-loop A → A", () => {
        const agents = [
            makeAgent("A", ["A"]),
        ];
        const result = validateAgentGraphAcyclicity(agents);
        expect(result).not.toBeNull();
        expect(result).toContain("A");
        expect(result).toContain("→");
    });

    it("returns null for disconnected components (no edges)", () => {
        const agents = [
            makeAgent("A"),
            makeAgent("B"),
            makeAgent("C"),
        ];
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("returns null for agents with no subagentAgents", () => {
        const agents = [
            makeAgent("scout"),
            makeAgent("researcher"),
            makeAgent("worker"),
        ];
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("returns null for a diamond graph (no cycle)", () => {
        // A → B, A → C, B → D, C → D
        const agents = [
            makeAgent("A", ["B", "C"]),
            makeAgent("B", ["D"]),
            makeAgent("C", ["D"]),
            makeAgent("D"),
        ];
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("handles references to non-existent agent names gracefully", () => {
        const agents = [
            makeAgent("A", ["B", "nonexistent"]),
            makeAgent("B", ["also_nonexistent"]),
        ];
        // No cycle because "nonexistent" and "also_nonexistent" are not in the graph
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("does not crash on empty agents array", () => {
        expect(validateAgentGraphAcyclicity([])).toBeNull();
    });

    it("detects cycle in a complex graph with multiple paths", () => {
        // A → B → C → A (cycle), plus A → D (dead end)
        const agents = [
            makeAgent("A", ["B", "D"]),
            makeAgent("B", ["C"]),
            makeAgent("C", ["A"]),
            makeAgent("D"),
        ];
        const result = validateAgentGraphAcyclicity(agents);
        expect(result).not.toBeNull();
        expect(result).toContain("A");
    });

    it("handles agents with undefined subagentAgents", () => {
        const agents = [
            makeAgent("A"),  // subagentAgents is undefined
            makeAgent("B", ["A"]),
        ];
        expect(validateAgentGraphAcyclicity(agents)).toBeNull();
    });

    it("returns a descriptive error message", () => {
        const agents = [
            makeAgent("scout", ["worker"]),
            makeAgent("worker", ["scout"]),
        ];
        const result = validateAgentGraphAcyclicity(agents);
        expect(result).toContain("Cycle detected in agent delegation graph");
    });
});
