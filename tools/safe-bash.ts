/**
 * Safe bash extension for worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_SAFE_BASH_TIMEOUT_S = 300; // 5 minutes — kills stuck commands instead of relying on the 10-min wall-clock

const SAFE_COMMANDS = new Set([
	"ls", "cat", "head", "tail", "grep", "awk", "sed", "sort", "uniq",
	"wc", "echo", "printf", "pwd", "cd", "find", "which", "whoami",
	"date", "true", "false", "test", "[",
	"git", "npm", "npx", "node", "bun", "pnpm", "yarn", "uv", "pip",
	"python", "python3", "tsc", "vitest", "jest", "eslint", "prettier",
	"cargo", "rustc", "go", "make", "cmake",
]);

// Runtime-configurable additions (set via configureSafeBash)
let extraDangerousPatterns: RegExp[] = [];
let extraSafeCommands: Set<string> = new Set();

const DANGEROUS_PATTERNS = [
	// rm with -exec (e.g. find / -exec rm -rf {} \;)
	/\s-exec\s+(rm|dd|mkfs)\b/,

	// Original patterns
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\S*)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\S*)/,
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,

	// eval/source
	/\beval\s/,
	/\bsource\s/,
	/\.\s+.*\$\{/,

	// Piping to interpreters
	/\|\s*(ba)?sh\b/,
	/\|\s*zsh\b/,
	/\|\s*python[23]?\b/,
	/\|\s*perl\b/,
	/\|\s*node\b/,
	/\|\s*php\b/,

	// base64 decode to shell
	/base64\s+(-d|--decode)\s*\|\s*(ba)?sh/,
	/base64\s+(-d|--decode)\s*\|\s*zsh/,
	/echo\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64\s+(-d|--decode)/,

	// Command substitution
	/\$\(.*\b(rm|dd|mkfs|sudo|curl|wget|nc|ncat|netcat|id|whoami|chmod|cat)\b/,
	/`.*\b(rm|dd|mkfs|sudo|curl|wget|nc|ncat|netcat|id|whoami|chmod|cat)\b/,

	// Reverse shells
	/\bnc\s+.*-l/,
	/\bncat\s+.*-l/,
	/\bnetcat\s+.*-l/,
	/\bnc\s+.*-e\s*(\/bin\/)?(ba)?sh/,
	/\bncat\s+.*--exec\s*(\/bin\/)?(ba)?sh/,

	// curl/wget to executable locations
	/\b(curl|wget)\s.*-o\s*(\/usr|\/bin|\/sbin|\/etc|\/tmp|~)/,
	/\b(curl|wget)\s.*>\s*(\/usr|\/bin|\/sbin|\/etc|\/tmp|~)/,

	// Redirect to sensitive files
	/>\s*\/etc\//,
	/>\s*\/usr\//,
	/>\s*\/boot\//,
	/>>\s*\/etc\/(passwd|shadow|sudoers)/,

	// Firewall
	/\biptables\b/,
	/\bufw\b/,

	// Secret-leaking commands (blocked — expose env vars with credentials)
	/\benv\b/,
	/\bprintenv\b/,
];

export function configureSafeBash(opts: { extraDangerousPatterns?: string[]; safeCommands?: string[] }) {
	if (opts.extraDangerousPatterns) {
		patternLoop:
		for (const raw of opts.extraDangerousPatterns) {
			// Parse "/pattern/flags" format
			const m = /^\/(.*)\/(g?i?m?s?u?y?)$/.exec(raw);
			try {
				const regex = m ? new RegExp(m[1], m[2]) : new RegExp(raw);
				// Don't duplicate patterns that are already in the built-in set
				for (const existing of DANGEROUS_PATTERNS) {
					if (existing.source === regex.source && existing.flags === regex.flags) continue patternLoop;
				}
				extraDangerousPatterns.push(regex);
			} catch {
				console.error(`[safe_bash] ignoring invalid extraDangerousPattern: ${raw}`);
			}
		}
	}
	if (opts.safeCommands) {
		for (const cmd of opts.safeCommands) {
			extraSafeCommands.add(cmd);
		}
	}
}

/** Reset runtime config — exported for testing only. */
export function _resetSafeBashConfig() {
	extraDangerousPatterns = [];
	extraSafeCommands = new Set();
}

export function isDangerous(command: string): string | null {
	// Strip line continuations and inline comments
	const normalized = command.replace(/\\\n/g, " ").replace(/#.*$/gm, "");

	// Variable expansion normalization: replace ${var} and $var with X
	const expanded = normalized
		.replace(/\$\{[^}]*\}/g, "X")
		.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "X");

	// ALWAYS check dangerous patterns on both raw and expanded command
	// (SAFE_COMMANDS never bypasses these checks)
	const allPatterns = [...DANGEROUS_PATTERNS, ...extraDangerousPatterns];
	for (const pattern of allPatterns) {
		if (pattern.test(normalized) || pattern.test(expanded)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}

	return null;
}

/** Returns true if a command name is in the safe set (built-in + configured). */
export function isSafeCommand(commandName: string): boolean {
	return SAFE_COMMANDS.has(commandName) || extraSafeCommands.has(commandName);
}

export default function (pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 300s/5min; pass a larger value for builds/tests/installs)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			const timeout = params.timeout ?? DEFAULT_SAFE_BASH_TIMEOUT_S;
			return bashTool.execute(toolCallId, { ...params, timeout }, signal, onUpdate);
		},
	});
}
