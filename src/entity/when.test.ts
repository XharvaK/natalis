import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, whenText } from "./when.js";

const now = Date.parse("2026-10-25T19:00:00Z"); // 22:00 in Istanbul

describe("whenText", () => {
  it("shows only the time for a moment earlier today in the zone", () => {
    expect(whenText(Date.parse("2026-10-25T07:00:00Z"), now, "Europe/Istanbul")).toBe("10:00");
  });
  it("shows the date and the age for an earlier day", () => {
    expect(whenText(Date.parse("2026-10-24T07:01:00Z"), now, "Europe/Istanbul")).toBe("2026-10-24 10:01, 1 day ago");
    expect(whenText(Date.parse("2026-10-20T07:01:00Z"), now, "Europe/Istanbul")).toBe("2026-10-20 10:01, 5 days ago");
  });
  it("uses Europe/Istanbul when no zone is given, by local midnight not 24 hours", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Istanbul");
    // 2026-10-24 21:30 UTC is 00:30 on the 25th in Istanbul: today there.
    expect(whenText(Date.parse("2026-10-24T21:30:00Z"), now, undefined)).toBe("00:30");
    expect(whenText(Date.parse("2026-10-24T20:30:00Z"), now, undefined)).toBe("2026-10-24 23:30, 1 day ago");
  });
});

describe("whenText round 6", () => {
  it("N2: a row stamped on a later day reads with its date, not as today", () => {
    expect(whenText(now + 2 * 86_400_000, now, "Europe/Istanbul")).toMatch(/^2026-10-27 22:00/);
  });
});
