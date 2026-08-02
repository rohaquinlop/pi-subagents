/**
 * Extension configuration loading.
 *
 * Config is read from two locations, lowest precedence first:
 *
 *   1. `<package>/config.json`  — next to index.ts, inside node_modules
 *   2. `~/.pi/agent/pi-subagents.config.json` — the user's pi directory
 *
 * The package-local file is convenient for a quick local tweak but cannot be
 * relied on: it sits inside `node_modules`, so it is typically gitignored and is
 * replaced whenever the package updates. Anything meant to persist — most
 * obviously `modelTiers`, whose whole purpose is to outlive a provider switch —
 * belongs in the user-level file, which is why that one wins on conflict.
 *
 * This mirrors how agent definitions already resolve: package built-ins first,
 * then `~/.pi/agent/extensions/agents/` overriding them by name.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExtensionConfig {
	maxConcurrency?: number;
	subagentTimeoutMs?: number;      // wall-clock, default 600000 (10 min). 0 = disabled.
	subagentIdleTimeoutMs?: number;  // no-stdout watchdog, default 300000 (5 min). 0 = disabled.
	maxSubagentDepth?: number;       // max nesting depth, default 8. Hard backstop against recursion loops.
	envAllowlist?: string[];         // additional env var names to pass through to child processes
	envExtra?: Record<string, string>; // extra key-value pairs to inject into child process env
	extraDangerousPatterns?: string[]; // additional regex patterns to block in safe_bash
	safeCommands?: string[];         // commands to always allow in safe_bash
	modelTiers?: Record<string, string>; // tier name → model spec, for `model: $tier` in agent files
}

/** Filename used for the user-level config inside the pi agent directory. */
export const USER_CONFIG_FILENAME = "pi-subagents.config.json";

/**
 * Config file paths in ascending precedence order.
 *
 * `home` is passed in rather than read from the environment so tests can point
 * this at a fixture directory.
 */
export function resolveConfigPaths(extDir: string, home: string | undefined): string[] {
	const paths = [path.join(extDir, "config.json")];
	if (home) {
		paths.push(path.join(home, ".pi", "agent", USER_CONFIG_FILENAME));
	}
	return paths;
}

/**
 * Read and merge config files, later paths overriding earlier ones.
 *
 * Merging is shallow: a key present in the user file replaces the package
 * file's value outright rather than being combined with it. That keeps
 * precedence predictable — reasoning about a half-merged `modelTiers` map
 * spread across two files is worse than simply overriding it.
 *
 * A missing file is normal and silent. An unreadable or malformed one warns and
 * is skipped: losing configuration to a stray comma with no indication is far
 * more confusing than a line on stderr.
 */
export function loadExtensionConfig(paths: string[]): ExtensionConfig {
	let config: ExtensionConfig = {};

	for (const configPath of paths) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				config = { ...config, ...parsed };
			} else {
				console.warn(`[pi-subagents] ignoring ${configPath}: expected a JSON object`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[pi-subagents] ignoring ${configPath}: ${message}`);
		}
	}

	return config;
}
