import { describe, it, expect } from "vitest";
import {
	resolveAgentModel,
	formatModelSpec,
	isTierReference,
	isInheritReference,
	INHERIT_MODEL,
} from "../lib/model-tiers";

describe("resolveAgentModel", () => {
	it("passes a concrete model spec through untouched", () => {
		const result = resolveAgentModel("deepseek/deepseek-v4-flash");
		expect(result).toEqual({ ok: true, model: "deepseek/deepseek-v4-flash" });
	});

	it("passes a bare model id through untouched", () => {
		// Provider-less specs are legal in agent files; resolution must not invent one.
		expect(resolveAgentModel("deepseek-v4-flash")).toEqual({
			ok: true,
			model: "deepseek-v4-flash",
		});
	});

	it("resolves inherit to the session model", () => {
		const result = resolveAgentModel("inherit", { sessionModel: "xiaomi/mimo-v2.5" });
		expect(result).toEqual({ ok: true, model: "xiaomi/mimo-v2.5" });
	});

	it("matches inherit case-insensitively and ignores surrounding space", () => {
		const result = resolveAgentModel("  Inherit  ", { sessionModel: "a/b" });
		expect(result).toEqual({ ok: true, model: "a/b" });
	});

	it("fails clearly when inherit has no session model to point at", () => {
		const result = resolveAgentModel("inherit");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/no session model is active/);
	});

	it("resolves a tier reference", () => {
		const result = resolveAgentModel("$fast", {
			tiers: { fast: "deepseek/deepseek-v4-flash" },
		});
		expect(result).toEqual({ ok: true, model: "deepseek/deepseek-v4-flash" });
	});

	it("matches tier names case-insensitively", () => {
		const result = resolveAgentModel("$DEEP", { tiers: { deep: "a/b" } });
		expect(result).toEqual({ ok: true, model: "a/b" });
	});

	it("accepts tier keys written with a leading $", () => {
		const result = resolveAgentModel("$fast", { tiers: { $fast: "a/b" } });
		expect(result).toEqual({ ok: true, model: "a/b" });
	});

	it("resolves a tier that points at inherit", () => {
		const result = resolveAgentModel("$fast", {
			tiers: { fast: "inherit" },
			sessionModel: "xiaomi/mimo-v2.5",
		});
		expect(result).toEqual({ ok: true, model: "xiaomi/mimo-v2.5" });
	});

	it("resolves a tier that points at another tier", () => {
		const result = resolveAgentModel("$recon", {
			tiers: { recon: "$fast", fast: "a/b" },
		});
		expect(result).toEqual({ ok: true, model: "a/b" });
	});

	it("names the known tiers when one is missing", () => {
		const result = resolveAgentModel("$nope", { tiers: { fast: "a/b", deep: "c/d" } });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("$nope");
		expect(!result.ok && result.error).toContain("$fast, $deep");
	});

	it("says so explicitly when no tiers are configured at all", () => {
		const result = resolveAgentModel("$fast");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/No modelTiers are configured/);
	});

	it("detects a direct tier cycle instead of looping", () => {
		const result = resolveAgentModel("$a", { tiers: { a: "$a" } });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/defined in terms of itself/);
	});

	it("detects an indirect tier cycle", () => {
		const result = resolveAgentModel("$a", { tiers: { a: "$b", b: "$c", c: "$a" } });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/defined in terms of itself/);
	});

	it("ignores tier entries with empty or non-string values", () => {
		const result = resolveAgentModel("$fast", {
			tiers: { fast: "   ", deep: "a/b" } as Record<string, string>,
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("$deep");
	});

	it("treats a bare $ as a literal model rather than a tier", () => {
		// `$` alone has no tier name to look up, so it is not a reference.
		expect(isTierReference("$")).toBe(false);
		expect(resolveAgentModel("$")).toEqual({ ok: true, model: "$" });
	});
});

describe("formatModelSpec", () => {
	it("joins provider and id", () => {
		expect(formatModelSpec({ provider: "deepseek", id: "deepseek-v4-flash" }))
			.toBe("deepseek/deepseek-v4-flash");
	});

	it("returns undefined for a missing or partial model", () => {
		expect(formatModelSpec(undefined)).toBeUndefined();
		expect(formatModelSpec({ provider: "deepseek" })).toBeUndefined();
		expect(formatModelSpec({ id: "deepseek-v4-flash" })).toBeUndefined();
	});
});

describe("reference predicates", () => {
	it("identifies inherit references", () => {
		expect(isInheritReference(INHERIT_MODEL)).toBe(true);
		expect(isInheritReference("INHERIT")).toBe(true);
		expect(isInheritReference("inheritance/model")).toBe(false);
	});

	it("identifies tier references", () => {
		expect(isTierReference("$fast")).toBe(true);
		expect(isTierReference("deepseek/v4")).toBe(false);
	});
});
