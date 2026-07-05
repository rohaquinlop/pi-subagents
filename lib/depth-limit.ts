/**
 * Depth-limiting logic for subagent nesting.
 *
 * Pure helper functions for checking and propagating subagent depth.
 * Extracted for testability — the actual depth enforcement happens in
 * buildPiArgs() in index.ts.
 */

export interface DepthCheckResult {
    allowed: boolean;
    newDepth: number;
    error?: string;
}

/**
 * Check whether a new subagent spawn is allowed given the current depth and max.
 *
 * @param currentDepth The current nesting depth (from PI_SUBAGENT_DEPTH env var)
 * @param maxDepth The maximum allowed depth (from config or default of 8)
 * @returns DepthCheckResult with allowed flag, newDepth, and optional error message
 */
export function checkDepth(currentDepth: number, maxDepth: number): DepthCheckResult {
    const newDepth = currentDepth + 1;
    if (newDepth > maxDepth) {
        return {
            allowed: false,
            newDepth,
            error:
                `Subagent depth limit exceeded (${newDepth} > ${maxDepth}). ` +
                `This likely indicates a recursion loop in agent delegation. ` +
                `Set maxSubagentDepth in config.json to increase the limit.`,
        };
    }
    return { allowed: true, newDepth };
}
