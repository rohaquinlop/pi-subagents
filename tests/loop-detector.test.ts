import { describe, it, expect } from "vitest";
import { detectCycle } from "../lib/loop-detector";

describe("detectCycle", () => {
    it("returns no cycle on varied work", () => {
        const history = ["read:src/a.ts", "edit:src/a.ts:v1", "bash:npm test", "read:src/b.ts", "edit:src/b.ts:v2", "bash:npm run build"];
        expect(detectCycle(history, "grep:pattern-X").cycle).toBe(false);
    });

    it("detects a 3× repetition of a length-3 pattern", () => {
        const pattern = ["read:f.ts", "edit:f.ts:v1", "bash:npm test"];
        // 2 full reps + first 2 of 3rd = 8 entries; newSig completes the 3rd rep (9th)
        const history = [...pattern, ...pattern, pattern[0], pattern[1]];
        const result = detectCycle(history, pattern[2]);
        expect(result.cycle).toBe(true);
        expect(result.pattern).toEqual(pattern);
    });

    it("detects a 3× repetition of a length-2 pattern", () => {
        const pattern = ["read:f.ts", "edit:f.ts:v1"];
        // 2 full reps + first 1 of 3rd = 5 entries; newSig completes the 3rd rep (6th)
        const history = [...pattern, ...pattern, pattern[0]];
        const result = detectCycle(history, pattern[1]);
        expect(result.cycle).toBe(true);
        expect(result.pattern).toEqual(pattern);
    });

    it("does NOT trigger on a 2× repetition (legitimate double-check)", () => {
        const pattern = ["read:f.ts", "edit:f.ts:v1", "bash:npm test"];
        // 2 full reps = 6 entries; newSig starts the 3rd (7th) — only 2 reps completed
        const history = [...pattern, ...pattern];
        const result = detectCycle(history, pattern[0]);
        expect(result.cycle).toBe(false);
    });

    it("does NOT trigger when a repeating tool is interleaved with different tools", () => {
        const history = ["grep:X", "read:f1.ts", "edit:f1.ts:c1", "grep:X", "read:f2.ts", "edit:f2.ts:c2"];
        expect(detectCycle(history, "grep:X").cycle).toBe(false);
    });

    it("detects cycle when same file edited 6× with SAME content (P=2, identical sigs)", () => {
        const sig = "edit:f.ts:same-content";
        // 5 entries; newSig is 6th → 3× [sig,sig] (P=2, needed=6)
        const history = [sig, sig, sig, sig, sig];
        const result = detectCycle(history, sig);
        expect(result.cycle).toBe(true);
    });

    it("does NOT trigger when same file edited 3× with DIFFERENT content", () => {
        const history = ["edit:f.ts:v1", "edit:f.ts:v2", "edit:f.ts:v3", "edit:f.ts:v4"];
        expect(detectCycle(history, "edit:f.ts:v5").cycle).toBe(false);
    });

    it("handles window boundary (old entries dropped, recent cycle still detected)", () => {
        const filler = Array.from({ length: 24 }, (_, i) => `read:file-${i}.ts`);
        const pattern = ["read:f.ts", "edit:f.ts:c", "bash:test"];
        // 24 filler + 2 full reps + first 2 of 3rd = 32; newSig completes 3rd rep (33rd)
        const history = [...filler, ...pattern, ...pattern, pattern[0], pattern[1]];
        const result = detectCycle(history, pattern[2]);
        expect(result.cycle).toBe(true);
        expect(result.pattern).toEqual(pattern);
    });

    it("returns no cycle on empty history", () => {
        expect(detectCycle([], "read:f.ts").cycle).toBe(false);
    });

    it("returns no cycle with a single entry", () => {
        expect(detectCycle(["read:f.ts"], "read:f.ts").cycle).toBe(false);
    });

    it("detects cycle at maximum pattern length P=8", () => {
        const pattern = ["grep:x", "read:a.ts", "edit:a.ts:v1", "bash:t1", "read:b.ts", "edit:b.ts:v1", "bash:t2", "grep:x"];
        // 2 full reps + first 7 of 3rd = 23; newSig completes 3rd rep (24th)
        const history = [...pattern, ...pattern, ...pattern.slice(0, 7)];
        const result = detectCycle(history, pattern[7]);
        expect(result.cycle).toBe(true);
        expect(result.pattern).toEqual(pattern);
        expect(result.pattern!.length).toBe(8);
    });

    it("does NOT trigger on pattern length P=9 (exceeds MAX_PATTERN_LEN)", () => {
        const pattern = Array.from({ length: 9 }, (_, i) => `tool-${i}:arg`);
        // 3 full reps of a 9-element pattern (27 entries) — but P=9 is excluded
        const history = [...pattern, ...pattern, ...pattern.slice(0, 8)];
        const result = detectCycle(history, pattern[8]);
        expect(result.cycle).toBe(false);
    });
});
