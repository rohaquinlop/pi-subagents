/**
 * Error-message helpers for subagent tool returns.
 *
 * pi-agent-core drops the `isError` flag on normal tool returns, so `content`
 * is the only reliable channel to communicate failure context back to the main
 * LLM. These helpers build clear, actionable messages so the LLM can retry,
 * redirect, or report.
 */

/** Minimal shape the helper needs from a subagent result. */
interface SubagentErrorResult {
	agent: string;
	exitCode: number;
	output: string;
	progress: {
		error?: string;
		lastMessage?: string;
		retriedAfterLoop?: boolean;
	};
}

/**
 * Build a clear, actionable error message for the main LLM when a single
 * subagent fails. The `content` channel is the only reliable one (pi-agent-core
 * drops a returned `isError` flag on normal tool returns), so this must carry
 * enough context for the LLM to retry, redirect, or report.
 */
export function buildSubagentErrorContent(result: SubagentErrorResult): string {
	const parts: string[] = [];
	parts.push(`[Subagent error] Agent "${result.agent}" failed (exit code ${result.exitCode}).`);
	if (result.progress.retriedAfterLoop) {
		parts.push("Note: Subagent was retried after loop detection with partial context.");
	}
	if (result.progress.error) {
		parts.push(`Error: ${result.progress.error}`);
	}
	if (result.progress.lastMessage) {
		parts.push(`Last message: ${result.progress.lastMessage}`);
	}
	if (result.output && result.output !== "(no output)") {
		parts.push(`Output:\n${result.output}`);
	}
	return parts.join("\n");
}

export function buildPipelineErrorContent(
	stepIndex: number,
	stepAgent: string,
	result: { exitCode: number; output: string; progress: { error?: string } },
): string {
	return [
		`Pipeline failed at step ${stepIndex + 1} (agent: ${stepAgent}).`,
		`Exit code: ${result.exitCode}`,
		result.progress.error ? `Error: ${result.progress.error}` : null,
		result.output ? `Output:\n${result.output}` : "(no output)",
	].filter(Boolean).join("\n");
}

export function buildLoopErrorContent(
	iteration: number,
	agentName: string,
	result: { exitCode: number; output: string; progress: { error?: string } },
): string {
	return [
		`Loop failed at iteration ${iteration + 1} (agent: ${agentName}).`,
		`Exit code: ${result.exitCode}`,
		result.progress.error ? `Error: ${result.progress.error}` : null,
		result.output ? `Output:\n${result.output}` : "(no output)",
	].filter(Boolean).join("\n");
}
