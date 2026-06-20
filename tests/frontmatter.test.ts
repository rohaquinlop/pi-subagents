import { describe, it, expect } from "vitest";
import { parseAgentMd } from "../lib/helpers";

describe("parseAgentMd", () => {
    it("parses valid frontmatter + system prompt", () => {
        const md = `---
name: test-agent
description: A test agent
tools: read, write
model: deepseek-v4-flash
thinking: medium
---
You are a test agent.`;
        const result = parseAgentMd(md, "test.md");
        expect(result).not.toBeNull();
        expect(result!.name).toBe("test-agent");
        expect(result!.description).toBe("A test agent");
        expect(result!.tools).toEqual(["read", "write"]);
        expect(result!.model).toBe("deepseek-v4-flash");
        expect(result!.thinking).toBe("medium");
        expect(result!.systemPrompt).toBe("You are a test agent.");
    });

    it("parses subagent_agents field", () => {
        const md = `---
name: worker
description: Worker agent
tools: read, write, subagent
model: deepseek-v4-flash
thinking: medium
subagent_agents: scout, researcher
---
System prompt here.`;
        const result = parseAgentMd(md, "worker.md");
        expect(result).not.toBeNull();
        expect(result!.subagentAgents).toEqual(["scout", "researcher"]);
    });

    it("returns null for missing frontmatter", () => {
        const md = "Just a regular markdown file.";
        expect(parseAgentMd(md, "test.md")).toBeNull();
    });

    it("returns null when required fields are missing", () => {
        const md = `---
name: incomplete
---
No description or tools.`;
        expect(parseAgentMd(md, "test.md")).toBeNull();
    });

    it("handles single tool", () => {
        const md = `---
name: simple
description: Simple
tools: read
model: deepseek-v4-flash
thinking: low
---
Prompt.`;
        const result = parseAgentMd(md, "simple.md");
        expect(result!.tools).toEqual(["read"]);
    });

    it("trims whitespace from tool names", () => {
        const md = `---
name: messy
description: Messy whitespace
tools: read ,  write ,  edit
model: deepseek-v4-flash
thinking: medium
---
Prompt.`;
        const result = parseAgentMd(md, "messy.md");
        expect(result!.tools).toEqual(["read", "write", "edit"]);
    });
});
