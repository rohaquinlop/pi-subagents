import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

// A child that ignores SIGTERM and stays alive (must be SIGKILLed).
const SIGTERM_IGNORER =
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

describe("subagent timeout escalation (mirrors runSubagent)", () => {
    it(
        "force-kills a SIGTERM-ignoring child via the childClosed-guarded SIGKILL",
        async () => {
            const proc = spawn(process.execPath, ["-e", SIGTERM_IGNORER], {
                stdio: "ignore",
            });

            let childClosed = false;

            const exitCode = await new Promise<number>((resolve) => {
                proc.on("close", (code) => {
                    childClosed = true;
                    resolve(code ?? 1);
                });

                // First attempt: graceful SIGTERM (mirrors runSubagent's wall-clock
                // / idle timeout path).
                proc.kill("SIGTERM");

                // Grace period — if child hasn't exited, escalate to SIGKILL.
                // This mirrors runSubagent's `if (!childClosed) proc.kill("SIGKILL")`.
                setTimeout(() => {
                    if (!childClosed) proc.kill("SIGKILL");
                }, 200);
            });

            expect(childClosed).toBe(true);
            // Killed by signal → non-zero exit code
            expect(exitCode).not.toBe(0);
        },
        5000,
    );

    it(
        "does NOT send SIGKILL when the child exits during the SIGTERM grace period",
        async () => {
            // The child exits cleanly on its own (exit 0) after 50ms.
            // We send SIGTERM before that, but the child should exit on its
            // own before the grace period fires, so SIGKILL is never sent.
            const proc = spawn(
                process.execPath,
                ["-e", "setTimeout(() => process.exit(0), 50);"],
                { stdio: "ignore" },
            );

            let childClosed = false;
            let sigkillSent = false;

            const exitCode = await new Promise<number>((resolve) => {
                proc.on("close", (code) => {
                    childClosed = true;
                    resolve(code ?? 1);
                });

                // Send SIGTERM after child has started — child will still exit
                // on its own (exit 0) before the grace-period SIGKILL fires.
                setTimeout(() => {
                    proc.kill("SIGTERM");
                }, 20);

                // Grace period — child should already be gone, so this branch
                // must NOT execute.
                setTimeout(() => {
                    if (!childClosed) {
                        sigkillSent = true;
                        proc.kill("SIGKILL");
                    }
                }, 300);
            });

            expect(childClosed).toBe(true);
            expect(sigkillSent).toBe(false);
            // Exit code is 1 (signal-killed by SIGTERM) — the important point
            // is that SIGKILL was never sent because the child exited first.
        },
        5000,
    );
});
