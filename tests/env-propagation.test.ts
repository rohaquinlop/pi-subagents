import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildChildEnv, ENV_ALLOWLIST_BASE } from "../index";

describe("buildChildEnv", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Save env vars we'll modify
		for (const key of ["MY_CUSTOM_VAR", "MY_SECRET", "NOT_ALLOWLISTED"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		// Restore env vars
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
	});

	it("passes through allowlisted env vars", () => {
		// HOME is in the allowlist and should be present in most environments
		const env = buildChildEnv({});
		expect(env.HOME).toBe(process.env.HOME);
		expect(env.PATH).toBe(process.env.PATH);
	});

	it("does NOT pass through non-allowlisted vars", () => {
		process.env.NOT_ALLOWLISTED = "should-not-appear";
		const env = buildChildEnv({});
		expect(env.NOT_ALLOWLISTED).toBeUndefined();
	});

	it("always sets PI_IS_SUBAGENT via overrides", () => {
		const env = buildChildEnv({ PI_IS_SUBAGENT: "1" });
		expect(env.PI_IS_SUBAGENT).toBe("1");
	});

	it("sets PI_SUBAGENT_ALLOWED when provided in overrides", () => {
		const env = buildChildEnv({
			PI_IS_SUBAGENT: "1",
			PI_SUBAGENT_ALLOWED: "scout,worker",
		});
		expect(env.PI_SUBAGENT_ALLOWED).toBe("scout,worker");
	});

	it("sets PI_SUBAGENT_DEPTH when provided in overrides", () => {
		const env = buildChildEnv({
			PI_IS_SUBAGENT: "1",
			PI_SUBAGENT_DEPTH: "2",
		});
		expect(env.PI_SUBAGENT_DEPTH).toBe("2");
	});

	it("overrides take precedence over allowlisted values", () => {
		process.env.PI_IS_SUBAGENT = "original";
		const env = buildChildEnv({ PI_IS_SUBAGENT: "overridden" });
		expect(env.PI_IS_SUBAGENT).toBe("overridden");
	});

	it("extraAllowlist adds custom vars to pass through", () => {
		process.env.MY_CUSTOM_VAR = "custom-value";
		const env = buildChildEnv({}, ["MY_CUSTOM_VAR"]);
		expect(env.MY_CUSTOM_VAR).toBe("custom-value");
	});

	it("extraAllowlist does NOT include vars not in process.env", () => {
		// MY_SECRET is not set in process.env
		const env = buildChildEnv({}, ["MY_SECRET"]);
		expect(env.MY_SECRET).toBeUndefined();
	});

	it("extraAllowlist vars can be overridden by overrides", () => {
		process.env.MY_CUSTOM_VAR = "original";
		const env = buildChildEnv({ MY_CUSTOM_VAR: "overridden" }, ["MY_CUSTOM_VAR"]);
		expect(env.MY_CUSTOM_VAR).toBe("overridden");
	});

	it("envAllowlist config adds custom vars (combined test)", () => {
		process.env.MY_SECRET = "secret-value";
		const env = buildChildEnv(
			{ PI_IS_SUBAGENT: "1", PI_SUBAGENT_DEPTH: "1" },
			["MY_SECRET"],
		);
		expect(env.MY_SECRET).toBe("secret-value");
		expect(env.PI_IS_SUBAGENT).toBe("1");
		expect(env.PI_SUBAGENT_DEPTH).toBe("1");
	});

	it("envExtra config injects extra key-value pairs via overrides", () => {
		const env = buildChildEnv({
			PI_IS_SUBAGENT: "1",
			CUSTOM_KEY: "custom_value",
			ANOTHER_KEY: "another_value",
		});
		expect(env.CUSTOM_KEY).toBe("custom_value");
		expect(env.ANOTHER_KEY).toBe("another_value");
	});

	it("ENV_ALLOWLIST_BASE contains expected provider keys", () => {
		expect(ENV_ALLOWLIST_BASE.has("OPENAI_API_KEY")).toBe(true);
		expect(ENV_ALLOWLIST_BASE.has("ANTHROPIC_API_KEY")).toBe(true);
		expect(ENV_ALLOWLIST_BASE.has("DEEPSEEK_API_KEY")).toBe(true);
		expect(ENV_ALLOWLIST_BASE.has("GITHUB_TOKEN")).toBe(true);
		expect(ENV_ALLOWLIST_BASE.has("BRAVE_API_KEY")).toBe(true);
	});

	it("ENV_ALLOWLIST_BASE does NOT contain arbitrary vars", () => {
		expect(ENV_ALLOWLIST_BASE.has("NOT_A_REAL_VAR")).toBe(false);
		expect(ENV_ALLOWLIST_BASE.has("DB_PASSWORD")).toBe(false);
		expect(ENV_ALLOWLIST_BASE.has("AWS_SESSION_TOKEN")).toBe(false);
	});

	it("does not leak non-allowlisted process.env into child env", () => {
		process.env.MY_SECRET = "sensitive-data";
		process.env.NOT_ALLOWLISTED = "also-sensitive";
		const env = buildChildEnv({ PI_IS_SUBAGENT: "1" });
		expect(env.MY_SECRET).toBeUndefined();
		expect(env.NOT_ALLOWLISTED).toBeUndefined();
	});
});
