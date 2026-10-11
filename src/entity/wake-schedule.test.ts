import { describe, expect, it } from "vitest";
import { clockOf, firstDailyOccurrence, instantOfLocal, isWakeRepeat, localDayOf, nextOccurrence, parseClock, WAKE_LIMIT } from "./wake-schedule.js";

const ISTANBUL = "Europe/Istanbul"; // UTC+3, no daylight saving
const LONDON = "Europe/London";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("clock text", () => {
  it("accepts HH:MM of the day and refuses anything else", () => {
    expect(parseClock("09:00")).toBe("09:00");
    expect(parseClock("23:59")).toBe("23:59");
    expect(parseClock("24:00")).toBeUndefined();
    expect(parseClock("9:00")).toBeUndefined();
    expect(parseClock("09:60")).toBeUndefined();
    expect(parseClock("noon")).toBeUndefined();
  });

  it("reads the local clock and day of an instant in a zone", () => {
    const instant = Date.UTC(2026, 9, 11, 6, 0); // 09:00 in Istanbul
    expect(clockOf(instant, ISTANBUL)).toBe("09:00");
    expect(localDayOf(instant, ISTANBUL)).toBe("2026-10-11");
    expect(clockOf(instant, undefined)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("knows the two repeat values and no others", () => {
    expect(isWakeRepeat("daily")).toBe(true);
    expect(isWakeRepeat("weekly")).toBe(true);
    expect(isWakeRepeat("hourly")).toBe(false);
    expect(isWakeRepeat(undefined)).toBe(false);
    expect(WAKE_LIMIT).toBe(100);
  });
});

describe("nextOccurrence", () => {
  it("moves a daily wake to the same local clock the next day", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0); // 09:00 Istanbul
    const next = nextOccurrence({ fromMs: fired, afterMs: fired, repeat: "daily", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 12, 6, 0));
  });

  it("moves a weekly wake seven days on, keeping the weekday", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired, repeat: "weekly", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 18, 6, 0));
  });

  it("keeps the local clock across the autumn change in London", () => {
    // 09:00 BST on Saturday 24 October 2026 is 08:00 UTC; the clocks go back the next morning.
    const fired = Date.UTC(2026, 9, 24, 8, 0);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired, repeat: "daily", clock: "09:00", timeZone: LONDON });
    expect(next).toBe(Date.UTC(2026, 9, 25, 9, 0)); // 09:00 GMT, one hour later in UTC
    expect(clockOf(next, LONDON)).toBe("09:00");
  });

  it("takes the first instant after a local time that does not exist in the spring", () => {
    // 01:30 GMT on 27 March 2027; the next day's 01:30 is skipped (01:00 GMT jumps to 02:00 BST).
    const fired = Date.UTC(2027, 2, 27, 1, 30);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired, repeat: "daily", clock: "01:30", timeZone: LONDON });
    expect(next).toBe(Date.UTC(2027, 2, 28, 1, 0));
    expect(clockOf(next, LONDON)).toBe("02:00");
  });

  it("returns to the wall-clock time after a spring gap", () => {
    const shifted = Date.UTC(2027, 2, 28, 1, 0); // 02:00 BST, the first instant after the gap
    const next = nextOccurrence({ fromMs: shifted, afterMs: shifted, repeat: "daily", clock: "01:30", timeZone: LONDON });
    expect(next).toBe(Date.UTC(2027, 2, 29, 0, 30)); // 01:30 BST
  });

  it("fires once after a long downtime and moves to the next future occurrence, with no burst", () => {
    const fired = Date.UTC(2026, 9, 1, 6, 0); // 09:00 Istanbul, ten days before "now"
    const now = Date.UTC(2026, 9, 11, 11, 5); // 14:05 Istanbul
    const next = nextOccurrence({ fromMs: fired, afterMs: now, repeat: "daily", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 12, 6, 0));
  });

  it("skips missed weekly occurrences the same way", () => {
    const fired = Date.UTC(2026, 8, 13, 6, 0); // a Sunday, 09:00 Istanbul
    const now = Date.UTC(2026, 9, 11, 11, 5);
    const next = nextOccurrence({ fromMs: fired, afterMs: now, repeat: "weekly", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 18, 6, 0));
  });

  it("is strictly after now: an occurrence exactly at now is not repeated", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired + 5 * HOUR, repeat: "daily", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 12, 6, 0));
  });

  it("never returns the fired occurrence again when the timer fires a moment early", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired - 1, repeat: "daily", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBe(Date.UTC(2026, 9, 12, 6, 0));
  });

  it("works across ten years of downtime in a single step", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0);
    const now = fired + 10 * 365 * DAY;
    const next = nextOccurrence({ fromMs: fired, afterMs: now, repeat: "daily", clock: "09:00", timeZone: ISTANBUL });
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(DAY);
    expect(clockOf(next, ISTANBUL)).toBe("09:00");
  });

  it("uses the host's zone when none is given, and still moves forward", () => {
    const fired = Date.UTC(2026, 9, 11, 6, 0);
    const next = nextOccurrence({ fromMs: fired, afterMs: fired, repeat: "daily", clock: "09:00", timeZone: undefined });
    expect(next).toBeGreaterThan(fired);
    expect(next - fired).toBeLessThanOrEqual(DAY + HOUR);
  });
});

describe("instantOfLocal", () => {
  it("takes the first of the two instants of a local time that happens twice in the autumn", () => {
    // 01:30 happens twice on 25 October 2026 in London: once in BST (00:30 UTC) and once in GMT (01:30 UTC).
    const instant = instantOfLocal({ year: 2026, month: 10, day: 25 }, "01:30", LONDON);
    expect(instant).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });

  it("gives the plain instant for an ordinary local time", () => {
    expect(instantOfLocal({ year: 2026, month: 10, day: 11 }, "09:00", ISTANBUL)).toBe(Date.UTC(2026, 9, 11, 6, 0));
  });

  it("refuses a clock that is not HH:MM", () => {
    expect(() => instantOfLocal({ year: 2026, month: 10, day: 11 }, "9am", ISTANBUL)).toThrow(RangeError);
  });
});

describe("firstDailyOccurrence", () => {
  it("is today's clock when it is still ahead, and tomorrow's once it has passed or is exactly now", () => {
    const at = (iso: string): number => Date.parse(iso);
    expect(firstDailyOccurrence({ afterMs: at("2026-10-11T10:00:00Z"), clock: "14:00", timeZone: "UTC" })).toBe(at("2026-10-11T14:00:00Z"));
    expect(firstDailyOccurrence({ afterMs: at("2026-10-11T10:00:00Z"), clock: "09:00", timeZone: "UTC" })).toBe(at("2026-10-12T09:00:00Z"));
    expect(firstDailyOccurrence({ afterMs: at("2026-10-11T09:00:00Z"), clock: "09:00", timeZone: "UTC" })).toBe(at("2026-10-12T09:00:00Z"));
  });

  it("reads the clock in the zone given, across a zone's offset", () => {
    // 09:00 in Tokyo (UTC+9) on 12 October is 00:00 UTC.
    expect(firstDailyOccurrence({ afterMs: Date.parse("2026-10-11T10:00:00Z"), clock: "09:00", timeZone: "Asia/Tokyo" })).toBe(
      Date.parse("2026-10-12T00:00:00Z"),
    );
  });
});
