import { describe, expect, it } from "vitest";
import { DAY_RECORD_MAX, dayRecordLines, hasDayRecord, personLine } from "./day-record.js";

/** An invented day as the helper's diary digest sends it: one frame, two acts, a count of the rest. */
const DAY = {
  v: 1,
  from_minute: 0,
  to_minute: 1440,
  frames: [{
    day: 3,
    acts: 4,
    slept: ["23:10:00.000 day:2 week:0"],
    woke: ["07:02:00.000 day:3 week:0"],
    company: ["Mara Quill", "Pim Dorrow"],
    body_on_its_own: { "Eat Fizz": 2, "Sim Stand": 4 },
  }],
  acts: [
    {
      act_id: "a-1",
      at: "14:20:00.000 day:3 week:0",
      minutes: 45,
      what: "Brew Glimmer",
      by: "user_intent",
      needs: { Gloop: 30, Zing: -10 },
      moodlets: ["Zingy"],
      reactions: ["Flurbed"],
      people: [{ who: "Mara Quill", role: "target" }, { who: "Pim Dorrow", role: "reactor" }],
    },
    { act_id: "a-2", at: "18:00:00.000 day:3 week:0", minutes: 5, what: "Fizz Watch", by: "body" },
  ],
  also: { "Quax Dance": 3 },
  omitted: 2,
};

describe("the game's record of the day, as her full view shows it", () => {
  it("renders the frame, the acts in plain words, the counts, and says what was not listed", () => {
    const lines = dayRecordLines(DAY);
    expect(lines).toEqual([
      "The game's record of your day (facts only):",
      "- Day 3: slept 23:10, woke 07:02; with Mara Quill, Pim Dorrow; your body on its own: eat fizz ×2, sim stand ×4.",
      "- 14:20, 45 min: brew glimmer (your act); gloop +30, zing -10; you felt: zingy; reactions: flurbed; with Mara Quill (the one it was for), Pim Dorrow (reacted).",
      "- 18:00, 5 min: fizz watch (the game, on its own).",
      "Also: quax dance ×3. (2 more not listed.)",
    ]);
  });

  it("says nothing at all when the record holds no act and no frame, and never throws on a malformed record", () => {
    expect(dayRecordLines(undefined)).toEqual([]);
    expect(dayRecordLines("day")).toEqual([]);
    expect(dayRecordLines([])).toEqual([]);
    expect(dayRecordLines({ frames: "x", acts: [null, 7, "act"], also: [], omitted: "two" })).toEqual([]);
    expect(dayRecordLines({ acts: [{ at: "bad", minutes: "many", what: 9, needs: null, people: [{}] }, { what: "Brew Glimmer" }] }))
      .toEqual([
        "The game's record of your day (facts only):",
        "- brew glimmer.",
      ]);
  });

  it("skips a part it cannot read and keeps the rest of the line", () => {
    const lines = dayRecordLines({ acts: [{ at: "09:05:00.000 day:0 week:0", what: "Brew Glimmer", needs: { Gloop: "lots", Zing: 5 }, people: [{ who: "Mara Quill", role: "bystander" }] }] });
    expect(lines[1]).toBe("- 09:05: brew glimmer; zing +5; with Mara Quill.");
  });

  it("caps the section at 4,000 characters and says how many lines the cap left out", () => {
    const act = { at: "10:00:00.000 day:0 week:0", minutes: 1, what: "Brew Glimmer", by: "body" };
    const lines = dayRecordLines({ acts: Array.from({ length: 200 }, () => act) });
    const text = lines.join("\n");
    expect(text.length).toBeLessThanOrEqual(DAY_RECORD_MAX + 60);
    expect(lines.at(-1)).toMatch(/^- \(\d+ more not shown\.\)$/);
  });

  it("says whether a view carries a record that can be shown", () => {
    expect(hasDayRecord(DAY)).toBe(true);
    expect(hasDayRecord({})).toBe(false);
    expect(hasDayRecord(undefined)).toBe(false);
  });
});

describe("a person in the game's record, as a memory line", () => {
  it("counts the acts together and gives the last time in the Lar's zone", () => {
    const stamp = (ms: number) => String(ms);
    expect(personLine({ who: "Mara Quill", acts: 12, last_at_ms: 1_800_000_000_000 }, stamp)).toBe("Mara Quill: 12 acts together, last at 1800000000000.");
    expect(personLine({ who: "Pim Dorrow", acts: 1, last_at_ms: 5 }, stamp)).toBe("Pim Dorrow: 1 act together, last at 5.");
    expect(personLine({ acts: 1 }, stamp)).toBeUndefined();
  });

  it("drops a game token from a name in the record, so no brace reaches her", () => {
    const stamp = (ms: number) => String(ms);
    expect(personLine({ who: "Mara {0.SimFirstName} Quill", acts: 2, last_at_ms: 7 }, stamp)).toBe("Mara Quill: 2 acts together, last at 7.");
    expect(personLine({ who: "{0.SimFirstName}", acts: 2, last_at_ms: 7 }, stamp)).toBeUndefined();
  });
});
