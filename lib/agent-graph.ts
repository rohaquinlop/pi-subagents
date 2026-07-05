/**
 * Agent graph validation — detects cycles in agent delegation graphs.
 *
 * Uses WHITE/GRAY/BLACK DFS coloring to detect back edges (GRAY neighbor = cycle).
 * Returns null if acyclic, or a human-readable cycle string if cyclic.
 */
import type { AgentConfig } from "./types";

type Color = "white" | "gray" | "black";

/**
 * Validate that the agent delegation graph is acyclic.
 *
 * Builds a directed graph from agent.subagentAgents references and runs
 * DFS cycle detection. Handles: self-loops, 2-node cycles, N-node cycles,
 * disconnected components, and references to agents not in the graph
 * (skipped — they're external/leaf nodes).
 *
 * @param agents Array of agent configurations
 * @returns null if acyclic, or a human-readable cycle string like
 *          "Cycle detected in agent delegation graph: A → B → A"
 */
export function validateAgentGraphAcyclicity(agents: AgentConfig[]): string | null {
    // Build adjacency list from agent configs
    const agentNames = new Set(agents.map((a) => a.name));
    const graph = new Map<string, string[]>();

    for (const agent of agents) {
        const targets = agent.subagentAgents ?? [];
        // Filter out references to non-existent agents (external/leaf nodes)
        graph.set(agent.name, targets.filter((t) => agentNames.has(t)));
    }

    // WHITE/GRAY/BLACK DFS coloring
    const color = new Map<string, Color>();
    const parent = new Map<string, string | null>();

    for (const name of agentNames) {
        color.set(name, "white");
    }

    // DFS from each unvisited node (handles disconnected components)
    for (const start of agentNames) {
        if (color.get(start) !== "white") continue;

        // Iterative DFS using explicit stack
        // Stack entries: [node, iterator index into neighbors]
        const stack: Array<{ node: string; neighborIdx: number }> = [];
        stack.push({ node: start, neighborIdx: 0 });
        color.set(start, "gray");
        parent.set(start, null);

        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = graph.get(frame.node) ?? [];

            if (frame.neighborIdx < neighbors.length) {
                const neighbor = neighbors[frame.neighborIdx];
                frame.neighborIdx++;

                if (color.get(neighbor) === "gray") {
                    // Back edge found — reconstruct cycle path
                    const cyclePath = reconstructCyclePath(stack, neighbor);
                    return `Cycle detected in agent delegation graph: ${cyclePath}`;
                }

                if (color.get(neighbor) === "white") {
                    color.set(neighbor, "gray");
                    parent.set(neighbor, frame.node);
                    stack.push({ node: neighbor, neighborIdx: 0 });
                }
                // If black, it's a cross/forward edge — skip
            } else {
                // All neighbors explored — backtrack
                color.set(frame.node, "black");
                stack.pop();
            }
        }
    }

    return null;
}

/**
 * Reconstruct the cycle path from the DFS stack when a back edge is found.
 * The back edge goes from the current top of stack to `target`.
 * The cycle is: target → ... → top → target
 */
function reconstructCyclePath(
    stack: Array<{ node: string; neighborIdx: number }>,
    target: string,
): string {
    // Find target in the stack
    let targetIdx = -1;
    for (let i = 0; i < stack.length; i++) {
        if (stack[i].node === target) {
            targetIdx = i;
            break;
        }
    }

    if (targetIdx === -1) {
        // Self-loop case: target is the current node
        return `${target} → ${target}`;
    }

    // Build path from target to current top, then back to target
    const path: string[] = [];
    for (let i = targetIdx; i < stack.length; i++) {
        path.push(stack[i].node);
    }
    path.push(target);

    return path.join(" → ");
}
