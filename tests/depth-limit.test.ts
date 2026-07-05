import { describe, it, expect } from "vitest";
import { checkDepth } from "../lib/depth-limit";

describe("checkDepth", () => {
    it("allows depth 0 with default max 8", () => {
        const result = checkDepth(0, 8);
        expect(result.allowed).toBe(true);
        expect(result.newDepth).toBe(1);
        expect(result.error).toBeUndefined();
    });

    it("allows depth 7 with default max 8", () => {
        const result = checkDepth(7, 8);
        expect(result.allowed).toBe(true);
        expect(result.newDepth).toBe(8);
        expect(result.error).toBeUndefined();
    });

    it("blocks depth 8 with default max 8 (would exceed limit)", () => {
        const result = checkDepth(8, 8);
        expect(result.allowed).toBe(false);
        expect(result.newDepth).toBe(9);
        expect(result.error).toBeDefined();
        expect(result.error).toContain("9 > 8");
    });

    it("respects custom max depth", () => {
        const result = checkDepth(5, 5);
        expect(result.allowed).toBe(false);
        expect(result.newDepth).toBe(6);
        expect(result.error).toBeDefined();
        expect(result.error).toContain("6 > 5");
    });

    it("allows depth just below custom max", () => {
        const result = checkDepth(4, 5);
        expect(result.allowed).toBe(true);
        expect(result.newDepth).toBe(5);
    });

    it("allows depth 0 with max 1", () => {
        const result = checkDepth(0, 1);
        expect(result.allowed).toBe(true);
        expect(result.newDepth).toBe(1);
    });

    it("blocks depth 1 with max 1", () => {
        const result = checkDepth(1, 1);
        expect(result.allowed).toBe(false);
        expect(result.newDepth).toBe(2);
    });

    it("error message mentions recursion loop", () => {
        const result = checkDepth(10, 8);
        expect(result.error).toContain("recursion loop");
    });

    it("error message mentions config.json", () => {
        const result = checkDepth(10, 8);
        expect(result.error).toContain("config.json");
    });

    it("error message mentions maxSubagentDepth", () => {
        const result = checkDepth(10, 8);
        expect(result.error).toContain("maxSubagentDepth");
    });

    it("always increments depth by 1", () => {
        for (let i = 0; i < 20; i++) {
            const result = checkDepth(i, 100);
            expect(result.newDepth).toBe(i + 1);
        }
    });
});
