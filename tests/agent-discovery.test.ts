import { describe, it, expect } from "vitest";
import { mergeAgents, type AgentConfig } from "../lib/helpers";

function makeAgent(name: string, description: string): AgentConfig {
    return {
        name,
        description,
        tools: ["read"],
        model: "deepseek-v4-flash",
        thinking: "medium",
        systemPrompt: `System prompt for ${name}`,
        filePath: `agents/${name}.md`,
    };
}

describe("mergeAgents", () => {
    it("returns built-in agents when no user agents", () => {
        const builtIn = [makeAgent("scout", "Built-in scout")];
        expect(mergeAgents(builtIn, [])).toEqual(builtIn);
    });

    it("adds user agents not in built-in", () => {
        const builtIn = [makeAgent("scout", "Built-in scout")];
        const user = [makeAgent("planner", "User planner")];
        const result = mergeAgents(builtIn, user);
        expect(result).toHaveLength(2);
        expect(result.map(a => a.name).sort()).toEqual(["planner", "scout"]);
    });

    it("user agent overrides built-in with same name", () => {
        const builtIn = [makeAgent("scout", "Built-in scout")];
        const user = [makeAgent("scout", "User-overridden scout")];
        const result = mergeAgents(builtIn, user);
        expect(result).toHaveLength(1);
        expect(result[0].description).toBe("User-overridden scout");
    });

    it("handles empty built-in", () => {
        const user = [makeAgent("custom", "Custom agent")];
        expect(mergeAgents([], user)).toEqual(user);
    });

    it("handles empty user", () => {
        const builtIn = [makeAgent("scout", "Scout")];
        expect(mergeAgents(builtIn, [])).toEqual(builtIn);
    });
});
