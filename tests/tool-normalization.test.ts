import { describe, it, expect } from "vitest";
import { normalizeTools } from "../lib/helpers";

describe("normalizeTools", () => {
    it("splits comma-separated string", () => {
        expect(normalizeTools("read, write, edit")).toEqual(["read", "write", "edit"]);
    });

    it("returns single tool as array", () => {
        expect(normalizeTools("read")).toEqual(["read"]);
    });

    it("trims whitespace", () => {
        expect(normalizeTools(" read ,  write ")).toEqual(["read", "write"]);
    });

    it("filters empty entries", () => {
        expect(normalizeTools("read,,write")).toEqual(["read", "write"]);
    });

    it("handles already normalized array", () => {
        expect(normalizeTools(["read", "write"])).toEqual(["read", "write"]);
    });
});
