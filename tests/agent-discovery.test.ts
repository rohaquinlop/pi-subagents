import { describe, it, expect } from "vitest";
import { mergeAgents, parseAgentMd, substitutePlaceholders, formatConnectorContext, type AgentConfig } from "../lib/helpers";

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

describe("parseAgentMd", () => {
    it("parses connector from frontmatter with surrounding quotes stripped", () => {
        const content = `---\nname: scout\ndescription: Fast recon\ntools: read,ls\nmodel: deepseek-v4-flash\nthinking: medium\nconnector: "## Key findings\\n\\n{output}"\n---\nYou are a scout agent.`;
        const result = parseAgentMd(content, "agents/scout.md");
        expect(result).not.toBeNull();
        // Frontmatter is line-based, so a multi-line template has to be written
        // with escapes. They are resolved here rather than reaching the prompt
        // verbatim as the two characters `\` and `n`.
        expect(result!.connector).toBe("## Key findings\n\n{output}");
    });

    it("resolves tab and quote escapes in connector", () => {
        const content = `---\nname: scout\ndescription: Fast recon\ntools: read,ls\nmodel: deepseek-v4-flash\nthinking: medium\nconnector: "## \\"Findings\\"\\tsummary:\\n{output}"\n---\nYou are a scout agent.`;
        const result = parseAgentMd(content, "agents/scout.md");
        expect(result!.connector).toBe('## "Findings"\tsummary:\n{output}');
    });

    it("treats a doubled backslash as a literal backslash, not an escape", () => {
        const content = `---\nname: scout\ndescription: Fast recon\ntools: read,ls\nmodel: deepseek-v4-flash\nthinking: medium\nconnector: "C:\\\\nested\\n{output}"\n---\nYou are a scout agent.`;
        const result = parseAgentMd(content, "agents/scout.md");
        // `\\` collapses to a single backslash and the following `n` stays a
        // plain character — only the standalone `\n` becomes a newline.
        expect(result!.connector).toBe("C:\\nested\n{output}");
    });

    it("preserves unrecognized escape sequences as written", () => {
        const content = `---\nname: scout\ndescription: Fast recon\ntools: read,ls\nmodel: deepseek-v4-flash\nthinking: medium\nconnector: "100\\% done\\n{output}"\n---\nYou are a scout agent.`;
        const result = parseAgentMd(content, "agents/scout.md");
        expect(result!.connector).toBe("100\\% done\n{output}");
    });

    it("returns undefined connector when not present", () => {
        const content = `---
name: scout
description: Fast recon
tools: read,ls
model: deepseek-v4-flash
thinking: medium
---
You are a scout agent.`;
        const result = parseAgentMd(content, "agents/scout.md");
        expect(result).not.toBeNull();
        expect(result!.connector).toBeUndefined();
    });
});

describe("substitutePlaceholders", () => {
    it("replaces {previous} with prior output", () => {
        const result = substitutePlaceholders("Based on {previous}, do X", "found stuff");
        expect(result).toBe("Based on found stuff, do X");
    });

    it("replaces multiple {previous} occurrences", () => {
        const result = substitutePlaceholders("{previous} and {previous}", "data");
        expect(result).toBe("data and data");
    });

    it("truncates at maxContextChars", () => {
        const longOutput = "x".repeat(20000);
        const result = substitutePlaceholders("{previous}", longOutput, 16000);
        expect(result).toBe("x".repeat(16000) + "\n\n[Context truncated for pipeline]");
    });

    it("does not truncate when under limit", () => {
        const result = substitutePlaceholders("{previous}", "short", 16000);
        expect(result).toBe("short");
    });

    it("returns task unchanged when no placeholder present", () => {
        const result = substitutePlaceholders("No placeholder here", "ignored");
        expect(result).toBe("No placeholder here");
    });
});

describe("formatConnectorContext", () => {
    it("applies connector template with {output}", () => {
        const result = formatConnectorContext("raw output", "## Findings\n\n{output}");
        expect(result).toBe("## Findings\n\nraw output");
    });

    it("returns raw output when no template provided", () => {
        const result = formatConnectorContext("raw output", undefined);
        expect(result).toBe("raw output");
    });

    it("handles template with multiple {output} placeholders", () => {
        const result = formatConnectorContext("data", "{output} vs {output}");
        expect(result).toBe("data vs data");
    });
});
