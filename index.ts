/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: scout, researcher, worker.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import "./tools/safe-bash";

import type { AgentConfig, AgentUsage, PipelineStepResult, PipelineResult, LoopIterationResult, LoopResult } from "./lib/types";
import { discoverAgents, mergeAgents, substitutePlaceholders, formatConnectorContext } from "./lib/helpers";
import { zeroUsage, accumulateUsage, validateAgents, MAX_LOOP_CONTEXT, parseJudgeVerdict } from "./lib/pipeline-helpers";
import { buildSubagentErrorContent, buildPipelineErrorContent, buildLoopErrorContent } from "./lib/error-helpers";
import { detectCycle, LOOP_ERROR_PREFIX } from "./lib/loop-detector";
import { extractCycleSignature, LOOP_PRIOR_ITERATIONS_HEADER } from "./lib/cycle-signature";
import { validateAgentGraphAcyclicity } from "./lib/agent-graph";
import { checkDepth } from "./lib/depth-limit";

interface ToolEvent {
	tool: string;
	args: string;
	/** Matches the producing tool_execution_start/update/end event. */
	toolCallId?: string;
	/**
	 * "running" while between tool_execution_start and tool_execution_end; flipped
	 * to "done" on end. We store every in-flight call in recentTools (keyed by
	 * toolCallId) rather than a single current-tool slot, because pi-agent-core
	 * dispatches a turn's tool calls in parallel via Promise.all — a single slot
	 * would let the second start overwrite the first.
	 */
	status: "running" | "done";
	/**
	 * Live progress of subagents spawned by this tool call. Populated only for
	 * `subagent` tool calls, from the `partialResult.details.results` payload of
	 * `tool_execution_update` events (and refreshed once more from the end
	 * event's final results). Recursive: each child's own progress may carry
	 * further children via its `recentTools[i].children`.
	 */
	children?: AgentResult[];
}

interface AgentProgress {
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	/**
	 * Chronological log of tool calls — running and done interleaved. The
	 * renderer prefixes running entries with `▸` and done ones with `  `.
	 */
	recentTools: ToolEvent[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
	warning?: string;
	retriedAfterLoop?: boolean;
}

interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	contextWindow?: number;
	usage: AgentUsage;
}

interface Details {
	results?: AgentResult[];
	pipelineResult?: PipelineResult & { currentStep?: number };
	loopResult?: LoopResult & { currentIteration?: number };
}

// ── Config ─────────────────────────────────────────────────────────────

interface ExtensionConfig {
	maxConcurrency?: number;
	subagentTimeoutMs?: number;      // wall-clock, default 600000 (10 min). 0 = disabled.
	subagentIdleTimeoutMs?: number;  // no-stdout watchdog, default 300000 (5 min). 0 = disabled.
	maxSubagentDepth?: number;       // max nesting depth, default 8. Hard backstop against recursion loops.
}

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;     // 10 minutes
const DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

let extensionConfig: ExtensionConfig = {};

function loadConfig(): ExtensionConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as ExtensionConfig;
		}
	} catch {}
	return {};
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Directories for user-defined agents (merged over built-ins by name)
const USER_AGENTS_DIR = path.join(process.env.HOME || "~", ".pi", "agent", "extensions", "agents");

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(process.env.HOME || "~", ".pi", "agent", "extensions");

/**
 * Dynamically discover tool-to-extension mappings by scanning EXT_BASE
 * for pi.registerTool({ name: "...", ... }) calls in every extension file.
 *
 * Scans both directory-based extensions (dir/index.ts) and single-file
 * extensions (dir.ts). Skips built-in tool re-registrations (e.g.
 * compact-tool-renderer's rendering overrides) and provider-only files.
 * Falls back to hardcoded entries for tools in non-standard locations
 * (safe_bash in TOOLS_DIR, subagent in EXT_DIR).
 */
function buildCustomToolExtensions(): Record<string, string> {
	const map: Record<string, string> = {};

	try {
		const entries = fs.readdirSync(EXT_BASE, { withFileTypes: true });
		for (const entry of entries) {
			let extPath: string | undefined;

			if (entry.isDirectory()) {
				const indexPath = path.join(EXT_BASE, entry.name, "index.ts");
				if (fs.existsSync(indexPath)) extPath = indexPath;
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				// Skip provider-only extensions (they register no tools)
				if (entry.name === "nan-builders.ts") continue;
				extPath = path.join(EXT_BASE, entry.name);
			}

			if (!extPath) continue;

			const content = fs.readFileSync(extPath, "utf-8");
			// Extract tool names from pi.registerTool({ name: "toolname", ... }) calls
			const toolNameRe = /name:\s*"([^"]+)"/g;
			let match: RegExpExecArray | null;
			while ((match = toolNameRe.exec(content)) !== null) {
				const toolName = match[1];
				// Skip built-in tool re-registrations (e.g. compact-tool-renderer
				// which overrides read/write/edit/bash/grep/ls/find rendering)
				if (!BUILTIN_TOOLS.has(toolName)) {
					map[toolName] = extPath;
				}
			}
		}
	} catch {
		// EXT_BASE might not exist yet at module load time
	}

	// Hardcoded entries for tools in non-standard locations not under EXT_BASE
	map.safe_bash ??= path.join(TOOLS_DIR, "safe-bash.ts");
	map.subagent ??= path.join(EXT_DIR, "index.ts");

	return map;
}

const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = buildCustomToolExtensions();

interface ModelExtension {
	patterns: string[];
	path: string;
}

function buildModelExtensions(): ModelExtension[] {
	const result: ModelExtension[] = [];
	try {
		const entries = fs.readdirSync(EXT_BASE, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const pkgPath = path.join(EXT_BASE, entry.name, "package.json");
			if (!fs.existsSync(pkgPath)) continue;
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				const patterns: unknown = pkg?.pi?.appliesToModels;
				const extEntries: unknown = pkg?.pi?.extensions;
				if (!Array.isArray(patterns) || patterns.length === 0) continue;
				if (!patterns.every((p: unknown): p is string => typeof p === "string")) continue;
				if (!Array.isArray(extEntries) || extEntries.length === 0) continue;
				if (!extEntries.every((e: unknown): e is string => typeof e === "string")) continue;
				const extPath = path.join(EXT_BASE, entry.name, extEntries[0]);
				if (fs.existsSync(extPath)) {
					result.push({ patterns, path: extPath });
				}
			} catch {
				// skip corrupted package.json
			}
		}
	} catch {
		// skip if EXT_BASE doesn't exist
	}
	return result;
}

const MODEL_EXTENSIONS: ModelExtension[] = buildModelExtensions();

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];
let semaphore: Semaphore;

// Read once at module load. If we're a child subagent process whose parent
// pinned an allowlist, we silently ignore any agent (built-in OR registered
// later by a third-party extension) that isn't in the list.
const SUBAGENT_ALLOWLIST: string[] | undefined = (() => {
	const raw = process.env.PI_SUBAGENT_ALLOWED;
	if (!raw) return undefined;
	const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
})();

export function registerAgent(config: AgentConfig): void {
	if (SUBAGENT_ALLOWLIST && !SUBAGENT_ALLOWLIST.includes(config.name)) return;
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };



/**
 * Load all agents from both built-in and user directories.
 *
 * 1. Load built-in agents from pi-subagents/agents/
 * 2. Load user-defined agents from ~/.pi/agent/extensions/agents/
 *    User agents with the same name as a built-in replace it.
 *
 * The SUBAGENT_ALLOWLIST filter (applied later in the default export)
 * still restricts which agents child subagent processes can see.
 */
function loadAgents(): AgentConfig[] {
	const builtIn = discoverAgents(AGENTS_DIR);
	const user = discoverAgents(USER_AGENTS_DIR);
	return mergeAgents(builtIn, user);
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
	if (!contextWindow) return `${formatTokens(tokens)} ctx`;
	const pct = (tokens / contextWindow) * 100;
	const maxStr = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`;
	return `${pct.toFixed(1)}%/${maxStr}`;
}

function formatToolPreview(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
		case "safe_bash":
			return `$ ${((args.command as string) || "").slice(0, 80)}`;
		case "read":
			return `read ${(args.path as string) || ""}`;
		case "write":
			return `write ${(args.path as string) || ""}`;
		case "edit":
			return `edit ${(args.path as string) || ""}`;
		case "grep":
			return `grep ${(args.pattern as string) || ""}`;
		case "find":
			return `find ${(args.pattern as string) || ""}`;
		case "ls":
			return `ls ${(args.path as string) || "."}`;
		case "web_search":
			return `search "${(args.query as string) || ""}"`;
		case "web_fetch":
			return `fetch ${(args.url as string) || ""}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 60)}`;
		}
	}
}

function truncLine(text: string, maxWidth: number): string {
	// Collapse embedded newlines first so we render exactly one visible line.
	// We can't strip them inside `text` directly (would also touch ANSI escapes
	// like "\x1b[0m"), so we only target literal \r and \n outside of escapes.
	if (text.includes("\n") || text.includes("\r")) {
		text = text.replace(/\r?\n/g, "↵ ");
	}
	if (visibleWidth(text) <= maxWidth) return text;
	// Simple truncation - strip to fit
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip ANSI escape sequences
		if (ch === "\x1b") {
			const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) {
			return result + "…";
		}
		result += ch;
		width++;
	}
	return result;
}

// ── Subagent Execution ────────────────────────────────────────────────

/**
 * Match a model string against a glob-style pattern (supports only `*` as wildcard).
 * Pattern "deepseek-*" matches "nan/deepseek-v4-flash" and "deepseek-v4-pro".
 * Plain strings without wildcards match the provider name (portion before `/`).
 */
function matchModelPattern(model: string, pattern: string): boolean {
	const slashIdx = model.indexOf("/");
	const hasProvider = slashIdx !== -1;
	const modelId = hasProvider ? model.slice(slashIdx + 1) : model;
	const provider = hasProvider ? model.slice(0, slashIdx) : "";

	// Pattern without wildcards: match against provider name
	if (!pattern.includes("*") && hasProvider) {
		return provider.toLowerCase() === pattern.toLowerCase();
	}

	// Glob pattern: match against model ID
	// Escape regex-special characters, then convert escaped * back to .*
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
	const regex = new RegExp("^" + escaped + "$", "i");
	return regex.test(modelId);
}

async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	cwd: string,
): Promise<{ args: string[]; tempDir: string; childEnv: NodeJS.ProcessEnv }> {
	const piBin = resolvePiBinary();

	// Depth check (before resource allocation to avoid temp-dir leaks on throw)
	const currentDepth = parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10);
	const maxDepth = extensionConfig.maxSubagentDepth ?? 8;
	const depthResult = checkDepth(currentDepth, maxDepth);
	if (!depthResult.allowed) {
		throw new Error(depthResult.error!);
	}

	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];

	// Separate builtin tools from custom tools. Both kinds share the same
	// --tools allowlist in pi; --no-tools would disable extension tools too.
	const allowlist: string[] = [];
	const extensionPaths = new Set<string>();

	// The nan-builders extension registers the "nan" provider.
	// Child processes need it to use nan models.
	const NAN_BUILDERS_EXT = path.join(EXT_BASE, "nan-builders.ts");
	if (fs.existsSync(NAN_BUILDERS_EXT)) {
		extensionPaths.add(NAN_BUILDERS_EXT);
	}

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) {
			allowlist.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			allowlist.push(tool);
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Use --no-extensions then add only what we need
	args.push("--no-extensions");

	if (allowlist.length > 0) {
		// --tools is a unified allowlist that applies to built-in, extension, and custom tools.
		args.push("--tools", allowlist.join(","));
	} else {
		// Agent declared no tools — disable everything.
		args.push("--no-tools");
	}

	// Auto-load model-specific extensions (e.g. deepseek-cache)
	for (const me of MODEL_EXTENSIONS) {
		for (const pattern of me.patterns) {
			if (matchModelPattern(agent.model, pattern)) {
				extensionPaths.add(me.path);
				break;
			}
		}
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	args.push("--models", agent.model);
	args.push("--thinking", agent.thinking);
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	// Always mark child processes so extensions (register-agents.ts) can detect
	// them and skip tool blocking. Child agents need full tool access.
	const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_IS_SUBAGENT: "1" };

	// If this agent has a spawn allowlist, restrict which agents the child sees
	if (agent.tools.includes("subagent") && agent.subagentAgents && agent.subagentAgents.length > 0) {
		childEnv.PI_SUBAGENT_ALLOWED = agent.subagentAgents.join(",");
	}

	childEnv.PI_SUBAGENT_DEPTH = String(depthResult.newDepth);

	return { args: [piBin.command, ...args], tempDir, childEnv };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

/** Collapse any whitespace run (incl. newlines) into a single space. Used to
 *  keep tool-arg previews to one renderable line in collapsed view. */
function flatten(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// Per-event hard cap on stored arg previews. Even in expanded view we don't
// want a 50KB bash heredoc sitting in memory per tool call across last-20
// `recentTools` slots per agent across N agents. A few KB covers any realistic
// command; anything longer is almost certainly a generated payload the user
// doesn't need to read inline anyway.
const MAX_ARG_PREVIEW = 4000;

// Hard cap on recentTools entries to prevent unbounded memory growth in
// long-running subagents. Generous for expanded-view history; matches the
// callHistory trim pattern.
const MAX_RECENT_TOOLS = 50;

function extractToolArgsPreview(args: Record<string, unknown>): string {
	const cap = (s: string) => (s.length > MAX_ARG_PREVIEW ? s.slice(0, MAX_ARG_PREVIEW) + "…" : s);
	if (args.command) return cap(flatten(String(args.command)));
	if (args.path) return cap(flatten(String(args.path)));
	if (args.query) return `"${cap(flatten(String(args.query)))}"`;
	if (args.url) return cap(flatten(String(args.url)));
	if (args.pattern) return cap(flatten(String(args.pattern)));
	// `subagent` tool args: show which agent(s) it's calling, not the full task body.
	if (args.agent) return flatten(String(args.agent));
	if (Array.isArray(args.tasks)) {
		const names = (args.tasks as Array<{ agent?: string }>)
			.map((t) => t?.agent || "?")
			.join(", ");
		return `parallel(${names})`;
	}
	return cap(flatten(JSON.stringify(args)));
}

async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (progress: AgentProgress, usage: AgentResult["usage"], finalExitCode?: number) => void,
): Promise<AgentResult> {
	const { args, tempDir, childEnv } = await buildPiArgs(agent, task, cwd);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const result: AgentResult = {
		agent: agent.name,
		task,
		output: "",
		exitCode: 0,
		model: agent.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: agent.name,
			status: "running",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.(progress, result.usage);
	}, 150);

	const MAX_ATTEMPTS = 2; // 1 initial attempt + 1 retry
	const MAX_PARTIAL_CONTEXT = 4000;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const isRetry = attempt > 1;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(command, spawnArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		});

		let buf = "";
		let stderrBuf = "";
		let resolved = false;
		let wallTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let inFlightToolCount = 0;
		let childClosed = false;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		let callHistory: string[] = [];	// sliding window of tool-call signatures for cycle detection
		// NOTE: Cycle detection is PER-CHILD — each runSubagent() call has its own
		// fresh callHistory. Cross-step loops in pipeline (A→B→A→B) and cross-iteration
		// re-delegation in loop are NOT caught by the tool-call detector. They are
		// bounded instead by: pipeline's 2-5 step cap, loop's 2-5 iteration cap, the
		// depth cap (default 8), and wall-clock (10 min) + idle (5 min) timeouts.
		// This is a deliberate tradeoff — per-child detection avoids false positives
		// from parallel siblings sharing history.

		const safeResolve = (code: number) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(wallTimer);
			clearTimeout(idleTimer);
			clearTimeout(sigkillTimer);
			if (signal) signal.removeEventListener("abort", abortKill);
			resolve(code);
		};

		// Wall-clock timeout
		const timeoutMs = extensionConfig.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			wallTimer = setTimeout(() => {
				if (!progress.error) progress.error = `Subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
				proc.kill("SIGTERM");
				clearTimeout(sigkillTimer);
				sigkillTimer = setTimeout(() => {
					if (!childClosed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
		}

		// Idle (no-stdout) watchdog
		const idleMs = extensionConfig.subagentIdleTimeoutMs ?? DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS;
		const resetIdle = () => {
			if (idleMs <= 0) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				if (!progress.error) progress.error = `Subagent idle for ${Math.round(idleMs / 1000)}s — likely stuck`;
				proc.kill("SIGTERM");
				clearTimeout(sigkillTimer);
				sigkillTimer = setTimeout(() => {
					if (!childClosed) proc.kill("SIGKILL");
				}, 5000);
			}, idleMs);
		};
		resetIdle();

		const pauseIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		};
		const resumeIdle = () => {
			if (inFlightToolCount === 0) resetIdle();
		};

		const MAX_STDERR_BYTES = 100_000;

		const processLine = (line: string) => {
			if (inFlightToolCount === 0) resetIdle();
			if (!line.trim()) return;
			try {
				const evt = JSON.parse(line) as any;
				progress.durationMs = Date.now() - startTime;

				if (evt.type === "tool_execution_start") {
					inFlightToolCount++;
					pauseIdle();
					progress.toolCount++;
					progress.recentTools.push({
						tool: evt.toolName,
						args: extractToolArgsPreview((evt.args || {}) as Record<string, unknown>),
						toolCallId: evt.toolCallId,
						status: "running",
					});
					// Trim oldest completed entries, but never evict an in-flight tool —
					// otherwise tool_execution_end's .find(toolCallId) would no-op and leave a
					// permanently-"running" ghost.
					while (progress.recentTools.length > MAX_RECENT_TOOLS) {
						const idx = progress.recentTools.findIndex((t) => t.status !== "running");
						if (idx === -1) break; // only running entries left — don't evict in-flight
						progress.recentTools.splice(idx, 1);
					}
					// ── Cycle detection (parent-side, context-free) ──
					// Signature = toolName + args preview. Two calls with different args
					// (different file, or same file different content) → different sig.
					const sig = extractCycleSignature(evt.toolName, (evt.args || {}) as Record<string, unknown>);
					const cycleResult = detectCycle(callHistory, sig);
					callHistory.push(sig);
					if (callHistory.length > 24) callHistory = callHistory.slice(-24);

					if (cycleResult.cycle) {
						const toolNames = (cycleResult.pattern || []).map((s) => {
							const colonIdx = s.indexOf(":");
							return colonIdx >= 0 ? s.slice(0, colonIdx) : s;
						});
						const patternStr = toolNames.join("→");
						if (!progress.error) {
							progress.error = `${LOOP_ERROR_PREFIX}: repeating ${patternStr}`;
						}
						proc.kill("SIGTERM");
						clearTimeout(sigkillTimer);
						sigkillTimer = setTimeout(() => {
							if (!childClosed) proc.kill("SIGKILL");
						}, 5000);
					}
					fireUpdate();
				}

				// Subagents emit `tool_execution_update` while their own subagent tool
				// runs — the partial result carries the live nested AgentResult[]. We
				// surface that as `children` on the in-flight ToolEvent so the renderer
				// can inline grandchild activity beneath the parent's tool row.
				if (evt.type === "tool_execution_update") {
					const partial = evt.partialResult as { details?: { results?: unknown } } | undefined;
					const nested = partial?.details?.results;
					if (evt.toolName === "subagent" && Array.isArray(nested) && evt.toolCallId) {
						const hit = progress.recentTools.find((t) => t.toolCallId === evt.toolCallId);
						if (hit) {
							hit.children = nested as AgentResult[];
							fireUpdate();
						}
					}
				}

				if (evt.type === "tool_execution_end") {
					const hit = evt.toolCallId
						? progress.recentTools.find((t) => t.toolCallId === evt.toolCallId)
						: undefined;
					if (hit) {
						hit.status = "done";
						// Prefer the end event's final results over the last throttled
						// update — throttling can drop the trailing update, leaving stale
						// children visible on a tool that has actually completed.
						const finalResult = evt.result as { details?: { results?: unknown } } | undefined;
						const finalChildren = finalResult?.details?.results;
						if (evt.toolName === "subagent" && Array.isArray(finalChildren)) {
							hit.children = finalChildren as AgentResult[];
						}
					}
					inFlightToolCount = Math.max(0, inFlightToolCount - 1);
					resumeIdle();
					fireUpdate();
				}

				if (evt.type === "tool_result_end") {
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							// Context-window gauge: snapshot of the LATEST assistant turn's usage,
							// NOT a cumulative sum across turns. Each turn re-sends the whole
							// conversation as input + cacheRead, so one assistant message already
							// represents the current context size. Summing across N turns would
							// inflate the displayed % by roughly Nx (the bug this replaced).
							// Matches pi's `calculateContextTokens` in core/compaction/compaction.js:
							// prefer the provider-reported totalTokens, fall back to the 4-component sum.
							progress.tokens = (u as { totalTokens?: number }).totalTokens
								|| (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							// Extract just the prose "thinking" text — skip code blocks
							const proseLines: string[] = [];
							let inCodeBlock = false;
							for (const line of text.split("\n")) {
								if (line.trimStart().startsWith("```")) {
									inCodeBlock = !inCodeBlock;
									continue;
								}
								if (!inCodeBlock && line.trim()) {
									proseLines.push(line.trim());
								}
							}
							if (proseLines.length > 0) {
								progress.lastMessage = proseLines.slice(0, 3).join(" ");
							}
						}
					}

					fireUpdate();
				}
			} catch {
				// Non-JSON lines are expected
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});

		proc.stderr.on("data", (d: Buffer) => {
			if (stderrBuf.length >= MAX_STDERR_BYTES) return;
			stderrBuf += d.toString();
			if (stderrBuf.length >= MAX_STDERR_BYTES) {
				stderrBuf = stderrBuf.slice(0, MAX_STDERR_BYTES) + "\n[stderr truncated]";
			}
		});

		proc.on("close", (code) => {
			childClosed = true;
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			} else if (code === 0 && stderrBuf.trim()) {
				// Non-fatal: surface stderr (e.g. deprecation warnings) on a successful exit.
				progress.warning = stderrBuf.trim().slice(0, 2000);
			}
			safeResolve(code ?? 1);
		});

		proc.on("error", () => safeResolve(1));

		const abortKill = () => {
			proc.kill("SIGTERM");
			clearTimeout(sigkillTimer);
			sigkillTimer = setTimeout(() => {
				if (!childClosed) proc.kill("SIGKILL");
			}, 3000);
		};
		if (signal) {
			if (signal.aborted) abortKill();
			else signal.addEventListener("abort", abortKill, { once: true });
		}
		});

		// Cleanup temp dir after this attempt
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		result.exitCode = exitCode;
		progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
		progress.durationMs = Date.now() - startTime;

		// Push the terminal status to the live renderer so the TUI doesn't keep
		// showing "running" after the child has exited. Pass exitCode so callers
		// that hold a live result object (the subagent tool) can sync its exitCode
		// and render the correct icon instead of the -1 placeholder.
		onUpdate?.(progress, result.usage, exitCode);

		if (progress.error) result.output = result.output || `Error: ${progress.error}`;

		// Truncate output if very large
		if (result.output.length > DEFAULT_MAX_BYTES) {
			const trunc = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			result.output = trunc.content;
			if (trunc.truncated) {
				result.output += "\n\n[Output truncated]";
			}
		}

		// Check if this was a loop error eligible for retry
		const isLoopError = progress.error?.startsWith(LOOP_ERROR_PREFIX);

		if (isLoopError && attempt < MAX_ATTEMPTS) {
			// Note: result.output is overwritten (we want the best attempt's output),
			// but result.usage accumulates (we want total cost across all attempts).
			// Build retry task with partial context from the failed attempt
			const partialOutput = (result.output || "").slice(0, MAX_PARTIAL_CONTEXT);
			const retryContext = partialOutput
				? `\n\n## Partial output from previous (looped) attempt:\n${partialOutput}`
				: "";
			task = `${task}${retryContext}`;

			// Reset progress state for retry attempt
			progress.status = "running";
			progress.error = undefined;
			progress.retriedAfterLoop = true;
			progress.recentTools = [];
			progress.toolCount = 0;
			progress.tokens = 0;
			progress.lastMessage = "";

			continue; // retry with fresh callHistory
		}

		// Success or non-loop failure — return result
		return result;
	}

	// Graceful degradation: retry loop exhausted, return best partial result
	const degradedResult: AgentResult = {
		...result,
		output: result.output || "(no output)",
		progress: {
			...progress,
			status: "failed" as const,
			error: "Subagent failed after retry. Returning partial results.",
		},
	};
	return degradedResult;
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) { clearTimeout(timer); timer = undefined; }
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

/**
 * Process-wide cap on simultaneous `runSubagent` calls. Each `execute()` of the
 * `subagent` tool is independent (pi runs LLM tool calls via `Promise.all`), so
 * we serialize at the `runSubagent` boundary. Per-process scope only — nested
 * subagent processes have their own semaphore, so the cap applies to direct
 * children, not the whole tree (which keeps things deadlock-free).
 */
class Semaphore {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((r) => this.waiters.push(r));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			const next = this.waiters.shift();
			if (next) next();
		}
	}
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];
type Component = ReturnType<typeof Text.prototype.render> extends string[] ? Text : any;

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
	depth: number = 0,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";
	const nested = depth > 0;

	// Indent prefix for nested levels. ANSI escapes are zero-width so this works
	// with colored content. Children are visually offset by 2 spaces per depth.
	const indent = nested ? "  ".repeat(depth) : "";
	// Available width shrinks with indent so truncLine still fits one line.
	const innerW = Math.max(20, w - indent.length);

	// `line(content)`: emit one indented, optionally-truncated row.
	// In expanded mode we still indent but don't truncate — the Text component
	// wraps and we want every wrapped line to share the same left margin, so we
	// keep the indent as a hard prefix on the first line only (pi-tui Text
	// doesn't expose a per-line gutter). Wrapping at depth is rare anyway since
	// the lines that wrap (lastMessage, full output) only render at depth 0.
	const addLine = (content: string) => {
		if (expanded) {
			c.addChild(new Text(indent + content, 0, 0));
		} else {
			c.addChild(new Text(indent + truncLine(content, innerW), 0, 0));
		}
	};

	// Header: icon + agent + stats (always one line)
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatDuration(prog.durationMs)}`;
	const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
	addLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`);

	// NOTE: the task body used to be rendered here at depth 0 (truncated when
	// collapsed, full when expanded). It's now owned by `renderCall` above this
	// block in the same tool shell — the call header shows the truncated
	// preview when collapsed and the full streaming prompt when expanded — so
	// repeating it here would duplicate the prompt on screen. Nested children
	// never rendered Task in the first place; the parent's recentTools row
	// above each child already conveys the dispatch.

	// Helper for rendering one tool row + recursively rendering its children.
	const renderToolRow = (
		toolName: string,
		args: string,
		children: AgentResult[] | undefined,
		isCurrent: boolean,
	) => {
		const body = args ? `${toolName}: ${args}` : toolName;
		if (isCurrent) {
			addLine(theme.fg("warning", `▸ ${body}`));
		} else {
			addLine(theme.fg("muted", `  ${body}`));
		}
		if (children && children.length > 0) {
			for (const child of children) {
				c.addChild(renderAgentProgress(child, theme, expanded, w, depth + 1));
			}
		}
	};

	// Tool log — running and done interleaved in chronological order. Running
	// entries get the `▸` marker; done ones get a muted `  ` prefix. Children
	// (live subagent activity) render inline beneath each row.
	//
	// In collapsed view, show only the latest 6 tool calls to keep output
	// compact. Expanded view (ctrl+o) shows everything.
	const MAX_COLLAPSED_TOOLS = 6;
	const toolsToShow = expanded
		? prog.recentTools
		: prog.recentTools.slice(-MAX_COLLAPSED_TOOLS);
	const hiddenCount = expanded ? 0 : Math.max(0, prog.recentTools.length - MAX_COLLAPSED_TOOLS);

	if (hiddenCount > 0) {
		addLine(theme.fg("muted", `  … ${hiddenCount} earlier tool call${hiddenCount === 1 ? "" : "s"}`));
	}

	for (const t of toolsToShow) {
		renderToolRow(t.tool, t.args, t.children, t.status === "running");
	}

	// Latest assistant message (prose "thinking"). Rendered at every depth so a
	// nested subagent's current thought sits at the bottom of its own indented
	// block, mirroring how the master box shows it under all tool rows. At depth
	// 0 we precede it with a blank line for visual separation from the tool log;
	// at depth>=1 we skip the spacer so the row stays grouped with the child's
	// tool list above and doesn't break the visual run between sibling children.
	if (prog.lastMessage) {
		if (!nested) c.addChild(new Spacer(1));
		addLine(theme.fg("text", prog.lastMessage));
	}

	// Expanded final output — only at depth 0. Nested levels are summarized via
	// their own tool list; the master-level result block is enough context.
	if (!nested && !isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
	}

	// Usage line. Includes the context %/max gauge at every depth — each
	// subagent carries its own model/contextWindow and its own token count, so
	// the gauge is meaningful per-row even for nested children.
	if (!nested) c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(r.usage.input)}`));
	if (r.usage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(r.usage.output)}`));
	if (r.usage.cacheRead) usageParts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
	if (r.usage.cacheWrite) usageParts.push(theme.fg("dim", `W${formatTokens(r.usage.cacheWrite)}`));
	if (r.usage.cost) usageParts.push(theme.fg("dim", `$${r.usage.cost.toFixed(3)}`));
	if (prog.tokens > 0) {
		const ctxStr = formatContextUsage(prog.tokens, r.contextWindow);
		const pct = r.contextWindow ? (prog.tokens / r.contextWindow) * 100 : 0;
		const coloredCtx = pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
		usageParts.push(coloredCtx);
	}
	if (usageParts.length) {
		addLine(usageParts.join(" "));
	}

	// Error
	if (prog.error) {
		addLine(theme.fg("error", `Error: ${prog.error}`));
	}

	if (prog.warning) {
		addLine(theme.fg("warning", `Warning: ${prog.warning}`));
	}

	return c;
}

// ── Pipeline Execution ────────────────────────────────────────────────

async function runPipeline(
	steps: Array<{ agent: string; task: string; connector?: string }>,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (stepIndex: number, progress: AgentProgress, usage: AgentUsage) => void,
): Promise<PipelineResult> {
	const results: PipelineStepResult[] = [];
	let previousOutput = "";
	let totalUsage = zeroUsage();
	const startTime = Date.now();

	for (let i = 0; i < steps.length; i++) {
		if (signal?.aborted) break;

		const step = steps[i];
		const agent = agents.find((a) => a.name === step.agent);
		if (!agent) {
			const errMsg = `Unknown agent: ${step.agent}`;
			results.push({
				agent: step.agent, task: step.task, output: `Error: ${errMsg}`,
				exitCode: 1, usage: zeroUsage(), durationMs: 0,
			});
			return {
				steps: results, finalOutput: previousOutput || "(no output)",
				stoppedAt: i, error: errMsg,
				totalUsage, totalDurationMs: Date.now() - startTime,
			};
		}

		// Build task with {previous} substitution
		let taskWithContext = step.task;
		if (previousOutput && taskWithContext.includes("{previous}")) {
			// Apply connector formatting if available (step-level overrides agent-level)
			const connector = step.connector ?? agent.connector;
			const formattedOutput = formatConnectorContext(previousOutput, connector);
			taskWithContext = substitutePlaceholders(step.task, formattedOutput);
		}

		const stepStart = Date.now();
		const result = await semaphore.run(() =>
			runSubagent(agent, taskWithContext, cwd, signal, (progress, usage) => {
				onUpdate?.(i, progress, usage);
			}),
		);

		const stepResult: PipelineStepResult = {
			agent: step.agent, task: step.task, output: result.output,
			exitCode: result.exitCode, usage: result.usage,
			durationMs: Date.now() - stepStart,
		};
		results.push(stepResult);
		totalUsage = accumulateUsage(totalUsage, result.usage);
		previousOutput = result.output;

		// Stop on error — surface the failing step's error as finalOutput (the pipeline
		// tool returns finalOutput as content, so the main LLM sees the actual failure,
		// not the previous step's success text).
		if (result.exitCode !== 0 || result.progress.error) {
			const errorDetail = buildPipelineErrorContent(i, step.agent, result);
			return {
				steps: results, finalOutput: errorDetail,
				stoppedAt: i, error: result.progress.error || `Agent ${step.agent} exited with code ${result.exitCode}`,
				totalUsage, totalDurationMs: Date.now() - startTime,
			};
		}
	}

	return {
		steps: results, finalOutput: previousOutput || "(no output)",
		totalUsage, totalDurationMs: Date.now() - startTime,
	};
}

// ── Loop Execution ─────────────────────────────────────────────────────

async function runLoop(
	agentName: string,
	task: string,
	maxIterations: number,
	judge: { agent: string; criteria: string } | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (iteration: number, progress: AgentProgress, usage: AgentUsage) => void,
): Promise<LoopResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) throw new Error(`Unknown agent: ${agentName}`);

	const iterations: LoopIterationResult[] = [];
	let priorOutputs: string[] = [];
	let stoppedBecause: LoopResult["stoppedBecause"] = "max_iterations";
	let totalUsage = zeroUsage();
	const startTime = Date.now();

	for (let i = 0; i < maxIterations; i++) {
		if (signal?.aborted) break;

		// Build task with accumulated context
		let fullTask = task;
		if (priorOutputs.length > 0) {
			// Enforce MAX_LOOP_CONTEXT budget: drop oldest iterations first
			let totalContext = 0;
			let keptOutputs: string[] = [];
			for (let j = priorOutputs.length - 1; j >= 0; j--) {
				const block = `--- Iteration ${j + 1} output ---\n${priorOutputs[j]}`;
				if (totalContext + block.length <= MAX_LOOP_CONTEXT) {
					keptOutputs.unshift(block);
					totalContext += block.length;
				} else {
					break;
				}
			}
			const contextBlock = keptOutputs.join("\n\n");
			fullTask = `${task}\n\n${LOOP_PRIOR_ITERATIONS_HEADER}\n${contextBlock}`;
		}

		const iterStart = Date.now();
		const result = await semaphore.run(() =>
			runSubagent(agent, fullTask, cwd, signal, (progress, usage) => {
				onUpdate?.(i, progress, usage);
			}),
		);

		const iterResult: LoopIterationResult = {
			iteration: i + 1, output: result.output,
			exitCode: result.exitCode, usage: result.usage,
			durationMs: Date.now() - iterStart,
		};
		totalUsage = accumulateUsage(totalUsage, result.usage);

		// Judge evaluation (if configured)
		if (judge && result.exitCode === 0 && !result.progress.error) {
			const judgeAgent = agents.find((a) => a.name === judge.agent);
			if (judgeAgent) {
				const judgePrompt = `Evaluate this output against the criteria below. Respond with YES if satisfied, or NO with specific feedback.\n\nCriteria: ${judge.criteria}\n\nOutput to evaluate:\n${result.output}`;
				const judgeResult = await semaphore.run(() =>
					runSubagent(judgeAgent, judgePrompt, cwd, signal),
				);
				totalUsage = accumulateUsage(totalUsage, judgeResult.usage);

				// Parse judge verdict
				const satisfied = parseJudgeVerdict(judgeResult.output);

				iterResult.judgeVerdict = { satisfied, response: judgeResult.output };

				if (satisfied) {
					iterations.push(iterResult);
					stoppedBecause = "judge_satisfied";
					return {
						iterations, finalOutput: result.output,
						stoppedBecause, totalUsage, totalDurationMs: Date.now() - startTime,
					};
				}
			}
		}

		iterations.push(iterResult);
		priorOutputs.push(result.output);

		if (result.exitCode !== 0 || result.progress.error) {
			stoppedBecause = "error";
			const errorDetail = buildLoopErrorContent(i, agentName, result);
			return {
				iterations, finalOutput: errorDetail,
				stoppedBecause, totalUsage, totalDurationMs: Date.now() - startTime,
			};
		}
	}

	return {
		iterations, finalOutput: priorOutputs[priorOutputs.length - 1] || "(no output)",
		stoppedBecause: "max_iterations",
		totalUsage, totalDurationMs: Date.now() - startTime,
	};
}

// ── Pipeline / Loop Rendering ─────────────────────────────────────────

function renderPipelineResult(
	result: PipelineResult,
	theme: Theme,
	expanded: boolean,
	w: number,
): Container {
	const c = new Container();

	// Header
	c.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("pipeline"))} — ${result.steps.length} steps · ${formatDuration(result.totalDurationMs)}`,
		0, 0,
	));
	c.addChild(new Spacer(1));

	// Steps
	for (let i = 0; i < result.steps.length; i++) {
		const step = result.steps[i];
		const icon = step.exitCode === 0
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");

		if (!expanded) {
			const arrow = i < result.steps.length - 1 && result.steps[i].exitCode === 0 && result.stoppedAt === undefined
				? theme.fg("dim", " → ")
				: "";
			c.addChild(new Text(
				`  ${icon} ${theme.fg("accent", step.agent)}${arrow}`,
				0, 0,
			));
		} else {
			c.addChild(new Text(
				`  ${icon} ${theme.fg("accent", step.agent)} — ${formatDuration(step.durationMs)}`,
				0, 0,
			));
			c.addChild(new Text(
				`    ${theme.fg("dim", "Task:")} ${truncLine(step.task, w - 20)}`,
				0, 0,
			));
			if (step.output) {
				c.addChild(new Spacer(1));
				const mdTheme = getMarkdownTheme();
				c.addChild(new Markdown(step.output, 2, 0, mdTheme));
			}
			if (i < result.steps.length - 1 && result.stoppedAt === undefined) {
				c.addChild(new Text(theme.fg("dim", "  ↓"), 0, 0));
			}
		}
	}

	// Show running indicator if pipeline is still executing
	if (result.currentStep !== undefined && result.currentStep >= result.steps.length) {
		if (!expanded) {
			const hasCompletedSteps = result.steps.length > 0;
			const lastCompletedOk = hasCompletedSteps && result.steps[result.steps.length - 1].exitCode === 0;
			const arrow = hasCompletedSteps && lastCompletedOk ? theme.fg("dim", " → ") : "";
			c.addChild(new Text(
				`  ${arrow}${theme.fg("warning", "⟳")} ${theme.fg("dim", "running...")}`,
				0, 0,
			));
		}
	}

	// Error message if pipeline failed
	if (result.error) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("error", `Stopped at step ${(result.stoppedAt ?? 0) + 1}: ${result.error}`), 0, 0));
	}

	// Usage summary
	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (result.totalUsage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(result.totalUsage.input)}`));
	if (result.totalUsage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(result.totalUsage.output)}`));
	if (result.totalUsage.cost) usageParts.push(theme.fg("dim", `$${result.totalUsage.cost.toFixed(3)}`));
	if (usageParts.length) c.addChild(new Text(usageParts.join(" "), 0, 0));

	return c;
}

function renderLoopResult(
	result: LoopResult,
	theme: Theme,
	expanded: boolean,
	w: number,
): Container {
	const c = new Container();

	const stoppedLabel = result.stoppedBecause === "judge_satisfied"
		? theme.fg("success", "judge satisfied")
		: result.stoppedBecause === "error"
			? theme.fg("error", "stopped (error)")
			: theme.fg("dim", `max ${result.iterations.length} iterations`);

	// Header
	c.addChild(new Text(
		`${theme.fg("toolTitle", theme.bold("loop"))} — ${result.iterations.length} iterations · ${stoppedLabel} · ${formatDuration(result.totalDurationMs)}`,
		0, 0,
	));
	c.addChild(new Spacer(1));

	// Iterations
	result.iterations.forEach((iter, idx) => {
		const icon = iter.exitCode === 0
			? theme.fg("success", "✓")
			: theme.fg("error", "✗");

		const verdictStr = iter.judgeVerdict
			? (iter.judgeVerdict.satisfied
				? theme.fg("success", " (YES)")
				: theme.fg("warning", " (NO)"))
			: "";

		if (!expanded) {
			const isLast = idx === result.iterations.length - 1;
			const arrow = isLast ? "" : theme.fg("dim", " → ");
			c.addChild(new Text(
				`  ${icon} ${theme.fg("accent", `Iteration ${iter.iteration}`)}${verdictStr}${arrow}`,
				0, 0,
			));
		} else {
			c.addChild(new Text(
				`  ${icon} ${theme.fg("accent", `Iteration ${iter.iteration}`)}${verdictStr} — ${formatDuration(iter.durationMs)}`,
				0, 0,
			));
			if (iter.output) {
				const mdTheme = getMarkdownTheme();
				c.addChild(new Markdown(iter.output, 2, 0, mdTheme));
			}
			if (iter.judgeVerdict && !iter.judgeVerdict.satisfied) {
				c.addChild(new Text(theme.fg("dim", "  ↓ refine"), 0, 0));
			}
		}
	});

	// Show running indicator if loop is still executing
	if (result.currentIteration !== undefined && result.currentIteration >= result.iterations.length) {
		if (!expanded) {
			const hasCompleted = result.iterations.length > 0;
			const arrow = hasCompleted ? theme.fg("dim", " → ") : "";
			c.addChild(new Text(
				`  ${arrow}${theme.fg("warning", "⟳")} ${theme.fg("dim", "refining...")}`,
				0, 0,
			));
		}
	}

	// Usage summary
	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (result.totalUsage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(result.totalUsage.input)}`));
	if (result.totalUsage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(result.totalUsage.output)}`));
	if (result.totalUsage.cost) usageParts.push(theme.fg("dim", `$${result.totalUsage.cost.toFixed(3)}`));
	if (usageParts.length) c.addChild(new Text(usageParts.join(" "), 0, 0));

	return c;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	extensionConfig = loadConfig();
	semaphore = new Semaphore(extensionConfig.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	agents = loadAgents();

	// Validate agent graph acyclicity (warning only — depth cap backstops recursion)
	const cycleError = validateAgentGraphAcyclicity(agents);
	if (cycleError) {
		console.error(`[pi-subagents] WARNING: ${cycleError}`);
		console.error(`[pi-subagents] The depth cap (maxSubagentDepth=${extensionConfig.maxSubagentDepth ?? 8}) prevents infinite recursion, but this agent configuration should be fixed.`);
	}

	// If spawned as a child by a parent subagent process, PI_SUBAGENT_ALLOWED
	// pins which agents we're allowed to expose. Filter the registry now, before
	// any tool description sees the agent list — the child LLM should not even
	// know that other agents exist.
	if (SUBAGENT_ALLOWLIST) {
		agents = agents.filter((a) => SUBAGENT_ALLOWLIST.includes(a.name));
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a subagent to complete a task. Subagents have NO context from the current conversation — include all necessary context in the task description.",
		promptSnippet: "Run subagents for delegated tasks",
		promptGuidelines: [
			"Parallel tool calls are your primary parallelism mechanism — put multiple independent read/fetch/search calls in one function_calls block. Don't use subagents to parallelize simple I/O.",
			"Use subagent to delegate *reasoning and decisions*: codebase exploration (scout), web research (researcher), or isolated code changes (worker)",
			"For multiple independent subagent tasks, emit multiple `subagent` tool calls in the same turn — they run in parallel automatically.",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description",
			"When a subagent returns an error, read it carefully. For transient failures (timeout, API/network), retry once with the same task plus 'Previous attempt failed with: {error}'. For structural failures (wrong approach, missing context), simplify the task or switch agents. If it persists after retry, report to the user with the specific error.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to invoke" }),
			task: Type.String({ description: "Task description" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;

			if (!params.agent || !params.task) {
				throw new Error("`subagent` requires both `agent` and `task`. To fan out work, emit multiple `subagent` tool calls in the same turn — they run in parallel.");
			}

			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
			}

			const [provider, modelId] = (agent.model || "").split("/");
			const contextWindow = provider && modelId ? ctx.modelRegistry.find(provider, modelId)?.contextWindow : undefined;
			const liveResult: AgentResult = {
				agent: params.agent,
				task: params.task,
				output: "",
				exitCode: -1,
				model: agent.model,
				contextWindow,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				progress: { agent: params.agent, status: "running" as const, task: params.task, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
			};

			const result = await semaphore.run(() =>
				runSubagent(agent, params.task!, params.cwd ?? cwd, signal, (progress, usage, finalExitCode) => {
					liveResult.progress = progress;
					liveResult.usage = { ...usage };
					if (finalExitCode !== undefined) liveResult.exitCode = finalExitCode;
					onUpdate?.({
						content: [{ type: "text", text: "(running...)" }],
						details: { results: [liveResult] },
					});
				}),
			);

			result.contextWindow = contextWindow;
			const isError = result.exitCode !== 0 || !!result.progress.error;
			const contentText = isError
				? buildSubagentErrorContent(result)
				: (result.output || "(no output)");
			return {
				content: [{ type: "text", text: contentText }],
				details: { results: [result] },
				...(isError ? { isError: true } : {}),
			};
		},

		// ── Render: tool call header ──
		//
		// Two views, toggled by ctrl+o (pi flips `context.expanded` and re-invokes
		// this on every flip). pi-agent-core also re-invokes this on every streamed
		// args delta, so in the expanded branch the full task text grows token by
		// token while the master LLM is still writing the prompt — mirroring how
		// `write`/`edit` reveal their `content` field live.
		renderCall(args, theme, context) {
			// Collapsed view (default): single-line header + 60-char task preview.
			if (!context.expanded) {
				if (!args.agent) {
					return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
				}
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
					0, 0,
				);
			}

			// Expanded view: header + full streaming task body. Reuse the previous
			// Container so we don't allocate on every streamed token (same pattern
			// the built-in write/edit tools use via context.lastComponent).
			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			const agentLabel = args.agent ? ` ${theme.fg("accent", args.agent)}` : "";
			const cwdLabel = args.cwd ? theme.fg("dim", ` (cwd: ${args.cwd})`) : "";
			c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${agentLabel}${cwdLabel}`, 0, 0));
			if (args.task) {
				c.addChild(new Spacer(1));
				// Plain Text wraps to terminal width. Markdown would also work but
				// the task prompt is the master's raw instruction text, not authored
				// markdown, and parsing partial markdown mid-stream looks jittery.
				c.addChild(new Text(theme.fg("text", args.task), 0, 0));
			}
			return c;
		},

		// ── Render: result ──
		renderResult(result, options, theme, context) {
			const details = result.details as Details | undefined;
			if (!details) {
				const t = result.content[0];
				const text = t?.type === "text" ? t.text : "(no output)";
				return new Text(text.slice(0, 200), 0, 0);
			}

			const w = getTermWidth() - 4;
			const expanded = options.expanded;

			// Pipeline result
			if (details.pipelineResult) {
				return renderPipelineResult(details.pipelineResult, theme, expanded, w);
			}

			// Loop result
			if (details.loopResult) {
				return renderLoopResult(details.loopResult, theme, expanded, w);
			}

			// Single agent result (existing behavior)
			if (details.results?.length) {
				const c = new Container();
				c.addChild(renderAgentProgress(details.results[0], theme, expanded, w));
				return c;
			}

			// Fallback
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "(no output)";
			return new Text(text.slice(0, 200), 0, 0);
		},
	});

	// ── Pipeline Tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "pipeline",
		label: "Pipeline",
		description:
			"Run 2–5 agents in sequence. Each agent's output feeds as {previous} context into the next agent's task. Use for multi-stage workflows like scout → planner → worker.",
		promptSnippet: "Run sequential multi-agent pipelines",
		promptGuidelines: [
			"Use pipeline when a task naturally decomposes into sequential agent roles (e.g. explore → plan → implement → review).",
			"Each step receives the previous step's output automatically via {previous} placeholder substitution.",
			"Pipelines stop on first error. The finalOutput is the failing step's error detail.",
			"When a pipeline fails at a step, the error identifies which step and why. Retry the failing step with a simpler task, or re-scope the pipeline. Early-step (exploration) failures → retry the whole pipeline with a more focused scope.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name for this step" }),
					task: Type.String({ description: "Task description. Use {previous} to reference the prior step's output." }),
					connector: Type.Optional(Type.String({ description: "Override agent's default connector template for this step. Format: \"## Header\\n\\n{output}\"" })),
				}),
				{ minItems: 2, maxItems: 5, description: "Sequential steps (2–5). Each step's agent output feeds into the next step's task via {previous}." },
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for all agent processes" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;

			if (!params.steps || params.steps.length < 2) {
				throw new Error("pipeline requires at least 2 steps");
			}

			// Validate all agents exist
			const agentNames = params.steps.map((s: { agent: string }) => s.agent);
			const missing = validateAgents(agentNames, agents);
			if (missing) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown agent in pipeline: ${missing}. Available agents: ${available}`);
			}

			const liveResult: Details = {
				pipelineResult: {
					steps: [],
					currentStep: 0,
					finalOutput: "",
					totalUsage: zeroUsage(),
					totalDurationMs: 0,
				},
			};

			const result = await runPipeline(
				params.steps,
				cwd,
				signal,
				(stepIndex, progress, usage) => {
					const pResult = liveResult.pipelineResult!;
					pResult.currentStep = stepIndex;
					// Update live result with latest step progress
					if (progress.status === "running") {
						// Ensure step slot exists for live rendering
						if (stepIndex === pResult.steps.length) {
							pResult.steps.push({
								agent: params.steps[stepIndex].agent,
								task: params.steps[stepIndex].task,
								output: "",
								exitCode: -1, // sentinel: not yet done
								usage,
								durationMs: progress.durationMs,
							});
						}
					}
					if (progress.status === "completed" || progress.status === "failed") {
						const stepResult: PipelineStepResult = {
							agent: params.steps[stepIndex].agent,
							task: params.steps[stepIndex].task,
							output: progress.lastMessage || "",
							exitCode: progress.status === "failed" ? 1 : 0,
							usage,
							durationMs: progress.durationMs,
						};
						// Replace placeholder or push
						while (pResult.steps.length <= stepIndex) {
							pResult.steps.push({...stepResult, output: "", exitCode: -1, usage: zeroUsage()});
						}
						pResult.steps[stepIndex] = stepResult;
					}
				onUpdate?.({
					content: [{ type: "text", text: `Pipeline: step ${stepIndex + 1}/${params.steps.length}` }],
					details: liveResult,
				});
			},
		);

			const isError = result.stoppedAt !== undefined;
			return {
				content: [{ type: "text", text: result.finalOutput || "(no output)" }],
				details: { pipelineResult: result },
				...(isError ? { isError: true } : {}),
			};
		},

		renderCall(args, theme, context) {
			if (!context.expanded) {
				if (!args.steps) {
					return new Text(theme.fg("toolTitle", theme.bold("pipeline")), 0, 0);
				}
				const stepNames = args.steps.map((s: { agent?: string }) => s?.agent || "?").join(" → ");
				return new Text(
					`${theme.fg("toolTitle", theme.bold("pipeline"))} ${theme.fg("accent", stepNames)}`,
					0, 0,
				);
			}

			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			const stepCount = args.steps?.length || 0;
			c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("pipeline"))} — ${stepCount} steps`, 0, 0));
			if (args.steps) {
				c.addChild(new Spacer(1));
				for (let i = 0; i < args.steps.length; i++) {
					const step = args.steps[i];
					const agentLabel = step.agent ? theme.fg("accent", step.agent) : "?";
					const taskPreview = step.task ? truncLine(step.task, 60) : "";
					c.addChild(new Text(`  ${theme.fg("dim", `${i + 1}.`)} ${agentLabel} ${theme.fg("dim", taskPreview)}`, 0, 0));
				}
			}
			return c;
		},
	});

	// ── Loop Tool ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "loop",
		label: "Loop",
		description:
			"Run the same agent 2–5 times, passing prior iteration outputs as context. Optionally use a judge agent to evaluate quality and stop early.",
		promptSnippet: "Run iterative refinement loops with optional judge",
		promptGuidelines: [
			"Use loop for tasks that benefit from iterative refinement (e.g. drafting → reviewing → polishing).",
			"Configure a judge agent to stop early when quality is sufficient, avoiding wasted iterations.",
			"Each iteration receives all prior outputs as context, enabling progressive improvement.",
			"When a loop iteration fails, the error shows which iteration. Reduce max_iterations or simplify the task; if the judge consistently rejects, refine the criteria or switch judge agent.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name to run in the loop" }),
			task: Type.String({ description: "Task description for each iteration" }),
			max_iterations: Type.Optional(Type.Number({ minimum: 2, maximum: 5, default: 3, description: "Maximum number of iterations (2–5, default 3)" })),
			judge: Type.Optional(Type.Object({
				agent: Type.String({ description: "Judge agent name" }),
				criteria: Type.String({ description: "Quality criteria. Judge responds YES if satisfied, NO otherwise." }),
			}, { description: "Optional judge agent to evaluate each iteration and stop early when quality is sufficient" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for agent processes" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const maxIterations = params.max_iterations ?? 3;

			// Validate agent exists
			const agentNames = [params.agent];
			if (params.judge) agentNames.push(params.judge.agent);
			const missing = validateAgents(agentNames, agents);
			if (missing) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown agent in loop: ${missing}. Available agents: ${available}`);
			}

			const liveResult: Details = {
				loopResult: {
					iterations: [],
					currentIteration: 0,
					finalOutput: "",
					stoppedBecause: "max_iterations",
					totalUsage: zeroUsage(),
					totalDurationMs: 0,
				},
			};

			const result = await runLoop(
				params.agent,
				params.task,
				maxIterations,
				params.judge,
				cwd,
				signal,
				(iteration, progress, usage) => {
					const lResult = liveResult.loopResult!;
					lResult.currentIteration = iteration;
					onUpdate?.({
						content: [{ type: "text", text: `Loop: iteration ${iteration + 1}/${maxIterations}` }],
						details: liveResult,
					});
				},
			);

			const isError = result.stoppedBecause === "error";
			return {
				content: [{ type: "text", text: result.finalOutput || "(no output)" }],
				details: { loopResult: result },
				...(isError ? { isError: true } : {}),
			};
		},

		renderCall(args, theme, context) {
			if (!context.expanded) {
				if (!args.agent) {
					return new Text(theme.fg("toolTitle", theme.bold("loop")), 0, 0);
				}
				const maxIter = args.max_iterations || 3;
				const judgeStr = args.judge ? ` (judge: ${theme.fg("accent", (args.judge as { agent?: string }).agent || "?")})` : "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("loop"))} ${theme.fg("accent", args.agent)} × ${maxIter}${judgeStr}`,
					0, 0,
				);
			}

			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			const maxIter = args.max_iterations || 3;
			c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("loop"))} ${theme.fg("accent", args.agent || "?")} × ${maxIter}`, 0, 0));
			if (args.task) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(theme.fg("text", args.task), 0, 0));
			}
			if (args.judge) {
				const j = args.judge as { agent?: string; criteria?: string };
				c.addChild(new Spacer(1));
				c.addChild(new Text(`${theme.fg("dim", "Judge:")} ${theme.fg("accent", j.agent || "?")} — ${theme.fg("dim", j.criteria || "")}`, 0, 0));
			}
			return c;
		},
	});
}
