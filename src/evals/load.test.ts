import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalCases } from "./load.js";

describe("seed eval cases", () => {
  it("every case in evals/cases parses, with unique names", () => {
    const cases = loadEvalCases(join(__dirname, "..", "..", "evals", "cases"));
    expect(cases.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });
});
