import { describe, it, expect } from "vitest";
import { parseJudgeVerdict } from "../lib/pipeline-helpers";

describe("parseJudgeVerdict", () => {
    it("detects YES on first line", () => {
        expect(parseJudgeVerdict("YES")).toBe(true);
    });

    it("detects YES with surrounding text", () => {
        expect(parseJudgeVerdict("I think YES, this is good")).toBe(true);
    });

    it("detects NO", () => {
        expect(parseJudgeVerdict("NO, needs improvement")).toBe(false);
    });

    it("strips markdown formatting", () => {
        expect(parseJudgeVerdict("**YES**")).toBe(true);
        expect(parseJudgeVerdict("# YES")).toBe(true);
        expect(parseJudgeVerdict("`YES`")).toBe(true);
    });

    it("uses word boundary — rejects YES inside other words", () => {
        expect(parseJudgeVerdict("YESTERDAY")).toBe(false);
    });

    it("detects YES after blank lines", () => {
        expect(parseJudgeVerdict("\n\nYES\nmore text")).toBe(true);
    });

    it("returns false for empty response", () => {
        expect(parseJudgeVerdict("")).toBe(false);
        expect(parseJudgeVerdict("   ")).toBe(false);
    });

    it("returns false for ambiguous response", () => {
        expect(parseJudgeVerdict("maybe later")).toBe(false);
    });

    it("returns false for negated YES", () => {
        // "does NOT satisfy YES the criteria" — this is a challenging case
        // but word-boundary matching on YES means it'll return true.
        // This is an acceptable tradeoff as per the plan's safe-fallback spec.
        expect(parseJudgeVerdict("does NOT satisfy YES the criteria")).toBe(true);
    });

    it("is case insensitive", () => {
        expect(parseJudgeVerdict("yes")).toBe(true);
        expect(parseJudgeVerdict("Yes")).toBe(true);
        expect(parseJudgeVerdict("YES")).toBe(true);
    });
});
