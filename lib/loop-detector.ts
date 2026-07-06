/**
 * Cycle detector for tool-call streams. Watches a sliding window of
 * tool-call signatures for a sub-sequence of length P repeated 3 times
 * (P in [1,8]). Catches an agent stuck in a tool-call loop without
 * imposing any count cap on legitimate work. Purely parent-side.
 */
const WINDOW_SIZE = 24;
const MIN_PATTERN_LEN = 1;
const MAX_PATTERN_LEN = 8;
const REPETITIONS = 3;

/**
 * Prefix for loop-detection error messages. Shared as a constant so that
 * both the error-generation site (in index.ts) and the retry-detection site
 * use the same string, avoiding fragile substring matching.
 */
export const LOOP_ERROR_PREFIX = "Subagent stuck in a tool-call loop";

export interface CycleResult {
    cycle: boolean;
    pattern?: string[];   // the repeating sub-sequence of signatures (length P)
}

/**
 * Detect whether `newSig` completes a 3× cycle. Pure: does NOT mutate `history`.
 * The caller pushes `newSig` onto its own history AFTER calling this.
 */
export function detectCycle(history: string[], newSig: string): CycleResult {
    const window = [...history, newSig];
    const start = Math.max(0, window.length - WINDOW_SIZE);
    const w = window.slice(start);
    for (let p = MIN_PATTERN_LEN; p <= MAX_PATTERN_LEN; p++) {
        const needed = p * REPETITIONS;
        if (w.length < needed) continue;
        const tail = w.slice(-needed);
        const pattern = tail.slice(0, p);
        let isCycle = true;
        for (let i = 0; i < p; i++) {
            if (pattern[i] !== tail[p + i] || pattern[i] !== tail[2 * p + i]) {
                isCycle = false;
                break;
            }
        }
        if (isCycle) return { cycle: true, pattern };
    }
    return { cycle: false };
}
