/**
 * Pure helper functions for agent discovery, frontmatter parsing, and tool normalization.
 * These functions use only Node.js built-ins (fs, path) — no pi package imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./types";

export type { AgentConfig };

/**
 * Converts comma-separated tool strings to arrays, handles trimming.
 * Accepts either a string or an already-normalized array.
 */
export function normalizeTools(tools: string | string[]): string[] {
    if (Array.isArray(tools)) return tools;
    return tools.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Parses a markdown file with YAML frontmatter into an AgentConfig.
 * Returns null if the file has no valid frontmatter or is missing required fields.
 */
export function parseAgentMd(content: string, filePath: string): AgentConfig | null {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = match[1];
    const systemPrompt = match[2].trim();

    // Parse frontmatter lines
    const fields: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        fields[key] = value;
    }

    const name = fields.name;
    const description = fields.description;
    const toolsRaw = fields.tools;
    const model = fields.model;
    const thinking = fields.thinking;

    if (!name || !description || !toolsRaw || !model || !thinking) return null;

    const tools = normalizeTools(toolsRaw);
    const subagentAgents = fields.subagent_agents
        ? normalizeTools(fields.subagent_agents)
        : undefined;

    return { name, description, tools, model, thinking, systemPrompt, filePath, subagentAgents };
}

/**
 * Scans a directory for .md files and parses them into AgentConfigs.
 * Returns only successfully parsed agents (invalid files are silently skipped).
 */
export function discoverAgents(agentsDir: string): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!fs.existsSync(agentsDir)) return agents;

    for (const entry of fs.readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(agentsDir, entry);
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const agent = parseAgentMd(content, filePath);
            if (agent) agents.push(agent);
        } catch {
            // Skip files that can't be read
        }
    }
    return agents;
}

/**
 * Merges built-in and user agents. User agents override built-in agents with the same name.
 */
export function mergeAgents(builtIn: AgentConfig[], user: AgentConfig[]): AgentConfig[] {
    const byName = new Map<string, AgentConfig>();
    for (const agent of builtIn) {
        byName.set(agent.name, agent);
    }
    for (const agent of user) {
        byName.set(agent.name, agent);
    }
    return Array.from(byName.values());
}

/**
 * Parses PI_SUBAGENT_ALLOWED env var into a Set of agent names.
 * Returns null if the env var is not set or empty (meaning no restriction).
 */
export function parseAllowlist(envVar: string | undefined): Set<string> | null {
    if (!envVar) return null;
    const list = envVar.split(",").map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? new Set(list) : null;
}
