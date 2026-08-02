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
 * Resolves backslash escape sequences in a single-line frontmatter value.
 *
 * Frontmatter is read line by line, so a multi-line template has to be written
 * with escapes: `connector: "## Header\n\n{output}"`. Without this step those
 * two characters reach the prompt verbatim and the header renders as
 * `## Header\n\n<output>` on one line.
 *
 * Runs in a single pass so `\\n` yields a literal backslash followed by `n`
 * rather than a newline. Unrecognized escapes are preserved as written.
 */
function unescapeFrontmatterValue(value: string): string {
    return value.replace(/\\(.)/g, (_match, ch: string) => {
        switch (ch) {
            case "n": return "\n";
            case "t": return "\t";
            case "r": return "\r";
            case "\\": return "\\";
            case '"': return '"';
            default: return `\\${ch}`;
        }
    });
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
    const connector = fields.connector
        ? unescapeFrontmatterValue(fields.connector.replace(/^"|"$/g, ""))
        : undefined;

    return { name, description, tools, model, thinking, systemPrompt, filePath, subagentAgents, connector };
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
 * Replace {previous} placeholder in a task string with the prior step's output.
 * Truncation happens here — this is the single truncation point.
 */
export function substitutePlaceholders(
    task: string,
    previousOutput: string,
    maxContextChars: number = 16000,
): string {
    const truncated = previousOutput.length > maxContextChars
        ? previousOutput.slice(0, maxContextChars) + "\n\n[Context truncated for pipeline]"
        : previousOutput;
    return task.replace(/\{previous\}/g, truncated);
}

/**
 * Format an agent's output using its connector template.
 * Pure formatting function — does NOT truncate. Truncation is handled
 * by substitutePlaceholders() before this is called.
 */
export function formatConnectorContext(
    output: string,
    connectorTemplate?: string,
): string {
    if (!connectorTemplate) return output;
    return connectorTemplate.replace(/\{output\}/g, output);
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
