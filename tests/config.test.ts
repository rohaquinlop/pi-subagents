import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveConfigPaths,
	loadExtensionConfig,
	USER_CONFIG_FILENAME,
} from "../lib/config";

describe("resolveConfigPaths", () => {
	it("puts the package config first and the user config last", () => {
		const paths = resolveConfigPaths("/pkg/pi-subagents", "/home/me");
		expect(paths).toEqual([
			path.join("/pkg/pi-subagents", "config.json"),
			path.join("/home/me", ".pi", "agent", USER_CONFIG_FILENAME),
		]);
	});

	it("omits the user path when HOME is unset", () => {
		// Order matters: later paths win, so the user path must come second.
		const paths = resolveConfigPaths("/pkg/pi-subagents", undefined);
		expect(paths).toEqual([path.join("/pkg/pi-subagents", "config.json")]);
	});
});

describe("loadExtensionConfig", () => {
	let dir: string;
	let pkgConfig: string;
	let userConfig: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-config-"));
		pkgConfig = path.join(dir, "config.json");
		userConfig = path.join(dir, "user.json");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns an empty config when nothing exists", () => {
		expect(loadExtensionConfig([pkgConfig, userConfig])).toEqual({});
	});

	it("reads a single config file", () => {
		fs.writeFileSync(pkgConfig, JSON.stringify({ maxConcurrency: 2 }));
		expect(loadExtensionConfig([pkgConfig, userConfig])).toEqual({ maxConcurrency: 2 });
	});

	it("lets the later path override the earlier one", () => {
		fs.writeFileSync(pkgConfig, JSON.stringify({ maxConcurrency: 2, maxSubagentDepth: 4 }));
		fs.writeFileSync(userConfig, JSON.stringify({ maxConcurrency: 9 }));
		expect(loadExtensionConfig([pkgConfig, userConfig])).toEqual({
			maxConcurrency: 9,
			maxSubagentDepth: 4,
		});
	});

	it("replaces modelTiers wholesale rather than merging entries", () => {
		// Shallow by design — a tier map stitched together from two files would be
		// far harder to reason about than one that simply wins.
		fs.writeFileSync(pkgConfig, JSON.stringify({ modelTiers: { fast: "a/b", deep: "c/d" } }));
		fs.writeFileSync(userConfig, JSON.stringify({ modelTiers: { fast: "x/y" } }));
		expect(loadExtensionConfig([pkgConfig, userConfig]).modelTiers).toEqual({ fast: "x/y" });
	});

	it("skips a malformed file, warns, and keeps the rest", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(pkgConfig, "{ not json");
		fs.writeFileSync(userConfig, JSON.stringify({ maxConcurrency: 3 }));

		expect(loadExtensionConfig([pkgConfig, userConfig])).toEqual({ maxConcurrency: 3 });
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain(pkgConfig);
	});

	it("rejects a JSON array, which would otherwise spread into numeric keys", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(pkgConfig, JSON.stringify(["nope"]));
		expect(loadExtensionConfig([pkgConfig])).toEqual({});
		expect(warn).toHaveBeenCalledOnce();
	});

	it("rejects a JSON scalar", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(pkgConfig, "42");
		expect(loadExtensionConfig([pkgConfig])).toEqual({});
		expect(warn).toHaveBeenCalledOnce();
	});

	it("survives a null config without throwing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fs.writeFileSync(pkgConfig, "null");
		expect(loadExtensionConfig([pkgConfig])).toEqual({});
		expect(warn).toHaveBeenCalledOnce();
	});
});
