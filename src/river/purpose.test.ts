import { describe, expect, it } from "vitest";
import { isLive, purposeOf } from "./purpose.js";

describe("turn purpose", () => {
  it("reflect is a known purpose", () => {
    expect(purposeOf({ data: { purpose: "reflect" } })).toBe("reflect");
  });

  it("counts a reflect row as live, so only eval and replay are left out", () => {
    expect(isLive({ data: { purpose: "reflect" } })).toBe(true);
    expect(isLive({ data: { purpose: "eval" } })).toBe(false);
    expect(isLive({ data: { purpose: "replay" } })).toBe(false);
  });
});
