import type { AgentConfig, AgentUsage } from "./types";

/**
 * Create a zeroed-out AgentUsage object.
 */
export function zeroUsage(): AgentUsage {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Accumulate usage from one step/iteration into the running total.
 */
export function accumulateUsage(total: AgentUsage, step: AgentUsage): AgentUsage {
    return {
        input: total.input + step.input,
        output: total.output + step.output,
        cacheRead: total.cacheRead + step.cacheRead,
        cacheWrite: total.cacheWrite + step.cacheWrite,
        cost: total.cost + step.cost,
        turns: total.turns + step.turns,
    };
}

/**
 * Validate that all referenced agent names exist in the loaded agents array.
 * Returns the first missing agent name, or null if all are valid.
 */
export function validateAgents(
    agentNames: string[],
    agents: AgentConfig[],
): string | null {
    for (const name of agentNames) {
        if (!agents.some((a) => a.name === name)) return name;
    }
    return null;
}

/**
 * Maximum total characters for accumulated loop context (prior iteration outputs).
 * When exceeded, oldest iterations are dropped first, keeping only the last 2–3.
 */
export const MAX_LOOP_CONTEXT = 48000;

/**
 * Parse a judge agent's response to determine if it signals satisfaction.
 * Extracts the first non-empty line, strips markdown formatting, and checks
 * for word-boundary YES match. Returns false on any parse failure.
 */
export function parseJudgeVerdict(response: string): boolean {
    const firstLine = response.split('\n').find(l => l.trim()) || '';
    const cleaned = firstLine.replace(/[*_`#]/g, '').trim().toUpperCase();
    return /\bYES\b/.test(cleaned);
}
