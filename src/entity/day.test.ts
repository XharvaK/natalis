import { describe, expect, it } from "vitest";
import { dayKey, msUntilNextDay, startOfDayMs } from "./day.js";

describe("dayKey", () => {
  it("names the local calendar day of a moment, in the zone it is given", () => {
    const late = Date.parse("2026-10-11T21:30:00Z");
    expect(dayKey(late, "UTC")).toBe("2026-10-11");
    // Istanbul is three hours ahead of UTC, so the same moment is already the next day there.
    expect(dayKey(late, "Europe/Istanbul")).toBe("2026-10-12");
  });

  it("uses the host's zone when none is given, as YYYY-MM-DD", () => {
    expect(dayKey(Date.now(), undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("msUntilNextDay", () => {
  it("counts the time left until the next local midnight", () => {
    expect(msUntilNextDay(Date.parse("2026-10-11T23:59:30Z"), "UTC")).toBe(30_000);
    expect(msUntilNextDay(Date.parse("2026-10-11T00:00:00.250Z"), "UTC")).toBe(86_399_750);
  });

  it("follows the entity's zone, not UTC", () => {
    // 21:00 UTC is exactly midnight in Istanbul, so a full day is left there.
    expect(msUntilNextDay(Date.parse("2026-10-11T21:00:00Z"), "Europe/Istanbul")).toBe(86_400_000);
  });

  it("never returns less than one second", () => {
    expect(msUntilNextDay(Date.parse("2026-10-11T23:59:59.999Z"), "UTC")).toBeGreaterThanOrEqual(1000);
  });
});

describe("startOfDayMs", () => {
  it("is the local midnight that began the day of a moment, in the zone given", () => {
    // 21:30 UTC is already 00:30 the next day in Istanbul, so that day began three hours and thirty minutes earlier.
    const late = Date.parse("2026-10-11T21:30:00Z");
    expect(startOfDayMs(late, "UTC")).toBe(Date.parse("2026-10-11T00:00:00Z"));
    expect(startOfDayMs(late, "Europe/Istanbul")).toBe(Date.parse("2026-10-11T21:00:00Z"));
  });
});
