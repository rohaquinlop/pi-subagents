import { describe, it, expect } from "vitest";
import { parseAllowlist } from "../lib/helpers";

describe("parseAllowlist", () => {
    it("returns null for undefined env var", () => {
        expect(parseAllowlist(undefined)).toBeNull();
    });

    it("parses comma-separated list", () => {
        const result = parseAllowlist("scout,worker");
        expect(result).not.toBeNull();
        expect(result!.has("scout")).toBe(true);
        expect(result!.has("worker")).toBe(true);
        expect(result!.has("researcher")).toBe(false);
    });

    it("trims whitespace", () => {
        const result = parseAllowlist(" scout , worker ");
        expect(result!.has("scout")).toBe(true);
        expect(result!.has("worker")).toBe(true);
    });

    it("handles single entry", () => {
        const result = parseAllowlist("scout");
        expect(result!.size).toBe(1);
        expect(result!.has("scout")).toBe(true);
    });

    it("handles empty string as no restriction", () => {
        const result = parseAllowlist("");
        expect(result).toBeNull();
    });
});
