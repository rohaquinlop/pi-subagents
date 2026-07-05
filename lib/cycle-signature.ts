/**
 * Cycle-detection signature builder for tool calls.
 *
 * Unlike `extractToolArgsPreview` (optimized for TUI display), this module
 * retains distinguishing arguments so that different calls doing different
 * work produce different signatures (no false positives) while identical
 * re-invocations collapse (true positives preserved).
 */
import * as crypto from "node:crypto";

/**
 * Header injected by the loop tool when accumulating prior iteration context
 * into a subagent task. Shared here so normalizeTaskForSignature stays in sync
 * with the injection site in index.ts — changing one without the other would
 * silently break loop-context stripping (false-negative loop detection).
 */
export const LOOP_PRIOR_ITERATIONS_HEADER = "## Prior iterations:";

/**
 * Deterministic 48-bit fingerprint (12 hex chars) via SHA-256.
 * Used for cycle-detection signatures: same input → same fingerprint,
 * different inputs → different fingerprints (collision-resistant enough
 * for a 24-entry sliding window).
 */
export function taskFingerprint(str: string): string {
    return crypto.createHash("sha256").update(str, "utf8").digest("hex").slice(0, 12);
}

/**
 * Conservatively normalize a subagent task string for cycle-signature hashing.
 * Strips injected connector context (## Prior iterations:, ## Key findings,
 * ## Implementation results, ## Research findings) which varies per invocation
 * but is not the "real" task, then collapses whitespace and lowercases.
 * Preserves the core task instruction.
 *
 * Limitation: only strips the 4 known headers. A user-defined agent with a
 * connector header NOT in this set would leave its {previous} content in the
 * task hash, causing two identical logical tasks with varying prior context to
 * produce different hashes — the detector could miss a loop (false negative).
 * This is a deliberate tradeoff (conservative normalization preserves real task
 * instructions; aggressive stripping risks over-collapsing different tasks).
 * Residual risk is bounded by loop/pipeline/depth/timeout caps.
 */
export function normalizeTaskForSignature(task: string): string {
    const stripped = task
        .replace(new RegExp(LOOP_PRIOR_ITERATIONS_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*$", "m"), "")
        .replace(/## Key findings[\s\S]*$/m, "")
        .replace(/## Implementation results[\s\S]*$/m, "")
        .replace(/## Research findings[\s\S]*$/m, "");
    return stripped.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Collapse any whitespace run (incl. newlines) into a single space. */
function flatten(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

const MAX_CYCLE_SIG_COMPONENT = 120;

/**
 * Build a cycle-detection signature for a tool call. Unlike extractToolArgsPreview
 * (optimized for TUI display), this retains distinguishing arguments so that
 * different calls doing different work produce different signatures (no false
 * positives) while identical re-invocations collapse (true positives preserved).
 * Components are capped to bound memory in the 24-entry sliding window.
 */
export function extractCycleSignature(toolName: string, args: Record<string, unknown>): string {
    const cap = (s: string, max: number = MAX_CYCLE_SIG_COMPONENT) =>
        s.length > max ? s.slice(0, max) : s;

    switch (toolName) {
        case "bash":
        case "safe_bash": {
            const cmd = cap(flatten(String(args.command || "")));
            const cwd = args.cwd ? `:${cap(flatten(String(args.cwd)), 60)}` : "";
            return `${toolName}:${cmd}${cwd}`;
        }
        case "read": {
            // Include offset (and limit) so pagination of the same file is progress, not a loop.
            const p = cap(flatten(String(args.path || "")));
            const offset = args.offset ?? 0;
            const limit = args.limit ?? "";
            return `read:${p}@${offset}${limit !== "" ? "/" + limit : ""}`;
        }
        case "write": {
            const p = cap(flatten(String(args.path || "")));
            const contentHash = args.content
                ? taskFingerprint(String(args.content).slice(0, 1000))
                : "nocontent";
            return `write:${p}:${contentHash}`;
        }
        case "edit": {
            const p = cap(flatten(String(args.path || "")));
            let body = "";
            if (Array.isArray(args.edits) && args.edits.length > 0) {
                body = (args.edits as Array<{ newText?: string; new_string?: string }>)
                    .map((e) => String(e?.newText || e?.new_string || ""))
                    .join("\n");
            } else {
                body = String(args.newText || args.new_string || args.content || "");
            }
            const contentHash = body ? taskFingerprint(body.slice(0, 500)) : "noedit";
            return `edit:${p}:${contentHash}`;
        }
        case "grep": {
            const pat = cap(flatten(String(args.pattern || "")));
            const p = args.path ? `:${cap(flatten(String(args.path)), 60)}` : "";
            const ex = args.exclude ? `!${cap(flatten(String(args.exclude)), 40)}` : "";
            return `grep:${pat}${p}${ex}`;
        }
        case "find":
        case "fffind": {
            const pat = cap(flatten(String(args.pattern || "")));
            const p = args.path ? `:${cap(flatten(String(args.path)), 60)}` : "";
            return `${toolName}:${pat}${p}`;
        }
        case "ffgrep": {
            const pat = cap(flatten(String(args.pattern || "")));
            const p = args.path ? `:${cap(flatten(String(args.path)), 60)}` : "";
            return `ffgrep:${pat}${p}`;
        }
        case "ls": {
            return `ls:${cap(flatten(String(args.path || ".")))}`;
        }
        case "web_search": {
            return `web_search:${cap(flatten(String(args.query || "")))}`;
        }
        case "web_fetch": {
            return `web_fetch:${cap(flatten(String(args.url || "")))}`;
        }
        case "subagent": {
            // CRITICAL: include task fingerprint so different delegations are distinguishable.
            const agent = flatten(String(args.agent || ""));
            const taskHash = args.task
                ? taskFingerprint(normalizeTaskForSignature(String(args.task)))
                : "notask";
            return `subagent:${agent}:${taskHash}`;
        }
        case "gh_cli": {
            return `gh_cli:${cap(flatten(String(args.command || "")))}`;
        }
        case "read_pdf": {
            return `read_pdf:${cap(flatten(String(args.path || "")))}`;
        }
        case "clarification_ui": {
            return `clarification_ui:${cap(flatten(JSON.stringify(args)))}`;
        }
        default: {
            const s = JSON.stringify(args);
            return `${toolName}:${cap(flatten(s))}`;
        }
    }
}
