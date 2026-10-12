import { describe, expect, it } from "vitest";
import { formatDuration, timeFacts } from "./time-facts.js";

const ZONE = "Europe/Istanbul";
// 2026-10-11 14:05 in Istanbul (UTC+3, no daylight saving) is 11:05 UTC.
const NOW = Date.UTC(2026, 9, 11, 11, 5);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("timeFacts", () => {
  it("is a core time section at priority 100", () => {
    const section = timeFacts({ nowMs: NOW, timeZone: ZONE });

    expect(section.name).toBe("time");
    expect(section.core).toBe(true);
    expect(section.priority).toBe(100);
  });

  it("states the time in the given zone, with the zone named", () => {
    const section = timeFacts({ nowMs: NOW, timeZone: ZONE });

    expect(section.text.split("\n")[0]).toBe("Now: Sunday 2026-10-11 14:05 (Europe/Istanbul).");
  });

  it("uses the zone it is given, not UTC, across the day boundary", () => {
    // 22:30 UTC on Sunday is 01:30 on Monday in Istanbul.
    const late = Date.UTC(2026, 9, 11, 22, 30);
    const section = timeFacts({ nowMs: late, timeZone: ZONE });

    expect(section.text.split("\n")[0]).toBe("Now: Monday 2026-10-12 01:30 (Europe/Istanbul).");
  });

  it("names the host's zone when none is given, and still formats the time", () => {
    const section = timeFacts({ nowMs: NOW });

    expect(section.text.split("\n")[0]).toMatch(/^Now: \w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)\.$/);
  });

  it("rejects an unknown zone with a plain error", () => {
    expect(() => timeFacts({ nowMs: NOW, timeZone: "Mars/Olympus" })).toThrow(/Unknown time zone: Mars\/Olympus/);
  });

  it("says how long since the last turn here and since the owner last wrote", () => {
    const section = timeFacts({
      nowMs: NOW,
      timeZone: ZONE,
      lastTurnHereMs: NOW - (3 * HOUR + 12 * MIN),
      lastOwnerMessageMs: NOW - 25 * MIN,
    });

    expect(section.text).toContain("Since your last turn here: 3 h 12 min.");
    expect(section.text).toContain("Since your summoner last wrote: 25 min.");
  });

  it("says plainly when there is no earlier turn here or no owner message", () => {
    const section = timeFacts({ nowMs: NOW, timeZone: ZONE });

    expect(section.text).toContain("You have no earlier turn here.");
    expect(section.text).toContain("Your summoner has not written to you yet.");
    expect(section.text).not.toContain("Since");
  });

  it("says when the next wakes are, in order, with the reason and how far away", () => {
    const section = timeFacts({
      nowMs: NOW,
      timeZone: ZONE,
      nextWakes: [
        { atMs: NOW + 2 * HOUR, why: "check the garden" },
        { atMs: NOW + 30 * HOUR, why: "" },
      ],
    });

    expect(section.text).toContain(
      "Your next wakes: Sunday 2026-10-11 16:05 (in 2 h): check the garden; Monday 2026-10-12 20:05 (in 1 d 6 h).",
    );
  });

  it("shows a repeating wake with its clock and rhythm, then its next occurrence", () => {
    const section = timeFacts({
      nowMs: NOW,
      timeZone: ZONE,
      nextWakes: [{ atMs: NOW + 2 * HOUR, why: "water the plants", repeat: "daily", clock: "16:05" }],
    });

    expect(section.text).toContain("Your next wakes: 16:05 daily, next Sunday 2026-10-11 16:05 (in 2 h): water the plants.");
  });

  it("shows each wake's id, in the form cancel_wake takes, after its time and before its reason", () => {
    const section = timeFacts({
      nowMs: NOW,
      timeZone: ZONE,
      nextWakes: [
        { id: "643c9508", atMs: NOW + 2 * HOUR, why: "check the garden" },
        { id: "a1b2c3d4", atMs: NOW + 5 * HOUR, why: "water", repeat: "daily", clock: "19:05" },
      ],
    });

    expect(section.text).toContain(
      "Your next wakes: Sunday 2026-10-11 16:05 (in 2 h) (id 643c9508): check the garden; 19:05 daily, next Sunday 2026-10-11 19:05 (in 5 h) (id a1b2c3d4): water.",
    );
  });

  it("sorts wakes by time, and shows a wake that is already due as due now", () => {
    const section = timeFacts({
      nowMs: NOW,
      timeZone: ZONE,
      nextWakes: [
        { atMs: NOW + HOUR, why: "later" },
        { atMs: NOW - MIN, why: "overdue" },
      ],
    });

    const line = section.text.split("\n").find((l) => l.startsWith("Your next wakes:")) ?? "";
    expect(line.indexOf("overdue")).toBeLessThan(line.indexOf("later"));
    expect(line).toContain("(due now): overdue");
  });

  it("says there are no wakes when the list is missing or empty", () => {
    expect(timeFacts({ nowMs: NOW, timeZone: ZONE }).text).toContain("You have no wakes scheduled.");
    expect(timeFacts({ nowMs: NOW, timeZone: ZONE, nextWakes: [] }).text).toContain("You have no wakes scheduled.");
  });

  it("reads a last turn that is in the future as just now, not as negative time", () => {
    const section = timeFacts({ nowMs: NOW, timeZone: ZONE, lastTurnHereMs: NOW + HOUR });

    expect(section.text).toContain("Since your last turn here: under a minute.");
  });
});

describe("formatDuration", () => {
  it("writes minutes, hours with minutes, hours alone, and days", () => {
    expect(formatDuration(0)).toBe("under a minute");
    expect(formatDuration(59_999)).toBe("under a minute");
    expect(formatDuration(MIN)).toBe("1 min");
    expect(formatDuration(25 * MIN)).toBe("25 min");
    expect(formatDuration(3 * HOUR + 12 * MIN)).toBe("3 h 12 min");
    expect(formatDuration(3 * HOUR)).toBe("3 h");
    expect(formatDuration(26 * HOUR)).toBe("1 d 2 h");
    expect(formatDuration(48 * HOUR)).toBe("2 d");
  });
});

describe("the age line", () => {
  it("says the Lar's age on the line after the Now line, when its natalis is given", () => {
    const section = timeFacts({ nowMs: NOW, timeZone: ZONE, bornMs: NOW - 3 * 24 * HOUR });

    expect(section.text.split("\n")[1]).toBe("Your age: 3 days.");
  });

  it("leaves the age out when no natalis is given", () => {
    expect(timeFacts({ nowMs: NOW, timeZone: ZONE }).text).not.toContain("Your age");
  });

  it("changes on a day step, and only then", () => {
    const born = NOW - 3 * 24 * HOUR;
    const sameDay = timeFacts({ nowMs: NOW + 5 * HOUR, timeZone: ZONE, bornMs: born }).text;
    const nextDay = timeFacts({ nowMs: NOW + 24 * HOUR, timeZone: ZONE, bornMs: born }).text;

    expect(sameDay.split("\n")[1]).toBe("Your age: 3 days.");
    expect(nextDay.split("\n")[1]).toBe("Your age: 4 days.");
  });
});

describe("the wakes, with the place each was set in (CORE3-8)", () => {
  it("says where a wake was set, in the board's place name, and a daily rhythm wake as the rhythm's", () => {
    const NOW = Date.parse("2026-10-12T09:00:00Z");
    const section = timeFacts({
      nowMs: NOW,
      timeZone: "UTC",
      nextWakes: [
        { id: "a1b2c3d4", atMs: NOW + 3_600_000, why: "Tell the summoner.", scheduledIn: "discord:room:general" },
        { id: "e5f6a7b8", atMs: NOW + 7_200_000, why: "Your daily rhythm.", scheduledIn: "self" },
      ],
    });
    expect(section.text).toContain("(id a1b2c3d4), set in discord:room:general: Tell the summoner.");
    expect(section.text).toContain("(id e5f6a7b8), set by your daily rhythm: Your daily rhythm.");
  });
});
