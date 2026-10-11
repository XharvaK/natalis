import { describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import { findOption, labelOf, optionsOf, refsOf, renderView, VIEW_TEXT_MAX } from "./options.js";

const TABLE: OptionObject[] = [
  { object: "Test kettle", object_id: "obj-kettle", where: "here, 2.0 m", acts: [
    { ref: "a1", guid64: "111", text: "Boil water" },
    { ref: "a2", guid64: "112", text: "Tidy up", opens: "a screen only you can use" },
  ] },
  { object: "Test bench", object_id: "obj-bench", noWay: "no way to get there from here", acts: [
    { ref: "a3", guid64: "211", text: "Sit down" },
  ] },
];

describe("reading a stored table", () => {
  it("keeps only well-formed objects, and offers nothing for anything else", () => {
    expect(optionsOf(undefined)).toEqual([]);
    expect(optionsOf("not a list")).toEqual([]);
    expect(optionsOf([{ object: "x", object_id: "y", acts: [] }, { object: 1 }, null])).toEqual([{ object: "x", object_id: "y", acts: [] }]);
  });

  it("lists every ref in order, and finds an act by its exact ref only", () => {
    expect(refsOf(TABLE)).toEqual(["a1", "a2", "a3"]);
    expect(findOption(TABLE, "a3")?.act.text).toBe("Sit down");
    expect(findOption(TABLE, "A3")).toBeNull();
    expect(findOption(TABLE, "a")).toBeNull();
    expect(findOption(TABLE, "a33")).toBeNull();
  });

  it("labels an act with its words and its object", () => {
    expect(labelOf(findOption(TABLE, "a1")!)).toBe("Boil water (Test kettle)");
  });
});

describe("rendering a view", () => {
  it("shows what the game shows, then each choice with its ref, and says what is not shown", () => {
    const text = renderView({
      world: "slot3",
      percepts: [{ kind: "sim_arrives", salience: 0.9, facts: { subject: "Pim Dorrow", count: 2 } }],
      options: TABLE,
    });
    expect(text).toContain("The game (slot3) shows:");
    expect(text).toContain("- sim arrives: subject Pim Dorrow, count 2");
    expect(text).toContain("Choices you can name with game_act, by ref:");
    expect(text).toContain("- Test kettle (here, 2.0 m): a1 Boil water; a2 Tidy up [a screen only you can use]");
    expect(text).toContain("- Test bench [no way to get there from here]: a3 Sit down");
  });

  it("says so when the view offers no choices, and states answer rules in plain words", () => {
    const quiet = renderView({ world: "slot3", percepts: [{ kind: "mood", salience: 0.1, facts: {} }], options: [] });
    expect(quiet).toContain("The game offers no choices in this view.");
    const asked = renderView({
      world: "slot3",
      percepts: [{ kind: "question", salience: 0.8, facts: {} }],
      options: [{
        object: "The game asks: a test", object_id: "dialog:q1", acts: [{ ref: "a1", guid64: "501", text: "Red" }],
        answer_rules: { select: { min: 1, max: 1 }, text: [{ name: "title", label: "Title", min_length: 1, max_length: 10, numeric: false, min_value: null, max_value: null, profanity_checked: false }] },
      }],
    });
    expect(asked).toContain('Answer rules: pick 1 to 1 row(s); type "title" (Title), 1 to 10 characters.');
  });

  it("keeps the view within its size, and says how many percepts it left out", () => {
    const long = "z".repeat(80);
    const percepts = Array.from({ length: 32 }, (_, index) => ({ kind: `kind_${index}`, salience: 0.5, facts: { a: long, b: long, c: long } }));
    const text = renderView({ world: "slot3", percepts, options: [] });
    expect(text.length).toBeLessThanOrEqual(VIEW_TEXT_MAX + 200);
    expect(text).toMatch(/more not shown\)/);
  });
});
