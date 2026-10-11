import { describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import { BRIEF_MAX, choicesSignature, findOption, labelOf, optionsOf, perceptSentence, refsOf, renderView, VIEW_TEXT_MAX, viewBrief } from "./options.js";

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
    expect(text).toContain("Choices you can name with game_act, by ref:");
    expect(text).toContain("- Test kettle (here, 2.0 m): a1 Boil water; a2 Tidy up [a screen only you can use]");
    expect(text).toContain("- Test bench [no way to get there from here]: a3 Sit down");
  });

  it("says each percept kind in plain words, with the game's own names humanised and no numbers for needs or rooms", () => {
    const text = renderView({
      world: "slot3",
      percepts: [
        { kind: "need", salience: 0.6, facts: { subject: "social", band: "distress", value: 5 } },
        { kind: "need", salience: 0.6, facts: { subject: "hunger", band: "ok", value: 61 } },
        { kind: "need", salience: 0.6, facts: { subject: "fun", band: "full", value: 99 } },
        { kind: "need", salience: 0.6, facts: { subject: "energy", band: "critical", value: 2 } },
        { kind: "moodlet", salience: 0.7, facts: { subject: "mood", from: "Mood_Sad", to: "Mood_Flirty" } },
        { kind: "interaction", salience: 0.5, facts: {
          subject: "sim", bucket: "started", affordance_text: "<class 'sims4.tuning.instances.mirror_GussyUp'>", origin: "her_choice",
        } },
        { kind: "interaction", salience: 0.5, facts: {
          subject: "sim", bucket: "ended", affordance_text: "<class 'sims4.tuning.instances.sim-stand'>", origin: "game", code: "finished", detail: "ok",
        } },
        { kind: "interaction", salience: 0.5, facts: { subject: "sim", bucket: "started", affordance_text: "<class 'x.y'>", origin: "native_reaction" } },
        { kind: "presence", salience: 0.5, facts: {
          subject: "1", bucket: "arrived", name: "Mara Quill", distance_m: "49.2", doing: "<class 'sims4.tuning.instances.sim-stand'>", role: "guest",
        } },
        { kind: "presence", salience: 0.5, facts: { subject: "2", bucket: "left", name: "Tobin Ash" } },
        { kind: "env", salience: 0.4, facts: { subject: "self", object: "9", bucket: "room", from_room: "4" } },
        { kind: "posture", salience: 0.4, facts: { subject: "self", bucket: "Sitting" } },
        { kind: "sleep_onset", salience: 1, facts: { onset_minute: 1320 } },
        { kind: "gap", salience: 1, facts: { subject: "session", lost: "3" } },
      ],
      options: [],
    });
    expect(text).toContain("- Social: very low.");
    expect(text).toContain("- Hunger: fine.");
    expect(text).toContain("- Fun: full.");
    expect(text).toContain("- Energy: critical.");
    expect(text).toContain("- Mood: flirty now (was sad).");
    expect(text).toContain("- Started: mirror gussy up (your act).");
    expect(text).toContain("- Ended: sim stand (the game). Result code finished, detail ok.");
    expect(text).toContain("- Started: y (the game, on its own).");
    expect(text).toContain("- Mara Quill arrived, 49 m away, sim stand (guest).");
    expect(text).toContain("- Tobin Ash left.");
    expect(text).toContain("- She moved rooms.");
    expect(text).toContain("- Posture: sitting.");
    expect(text).toContain("- She fell asleep.");
    expect(text).toContain("- Part of the game's feed was missed.");
    expect(text).not.toContain("subject");
    expect(text).not.toContain("value");
  });

  it("keeps the old line for a kind it does not know", () => {
    const text = renderView({ world: "slot3", percepts: [{ kind: "sim_arrives", salience: 0.9, facts: { subject: "Pim Dorrow", count: 2 } }], options: [] });
    expect(text).toContain("- sim arrives: subject Pim Dorrow, count 2");
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
    const percepts = Array.from({ length: 100 }, (_, index) => ({ kind: `kind_${index}`, salience: 0.5, facts: { a: long, b: long, c: long } }));
    const text = renderView({ world: "slot3", percepts, options: [] });
    expect(text.length).toBeLessThanOrEqual(VIEW_TEXT_MAX + 200);
    expect(text).toMatch(/more not shown\)/);
  });
});

describe("rendering the choices of a whole lot", () => {
  const LOT: OptionObject[] = [
    { object: "Test fridge", object_id: "o1", where: "here, 1.0 m", near: true, acts: [{ ref: "a1", guid64: "1", text: "Cook" }] },
    { object: "Test mailbox", object_id: "o2", room: "Test hall", acts: [{ ref: "a2", guid64: "2", text: "Check the mail" }] },
    { object: "Test lamp", object_id: "o3", room: "Test attic", acts: [{ ref: "a3", guid64: "3", text: "All lights on" }] },
    { object: "Test door", object_id: "o4", acts: [{ ref: "a4", guid64: "4", text: "Open" }] },
  ];

  it("lists the near objects first, then the rest grouped by room, and says what the game left out", () => {
    const text = renderView({ world: "slot3", percepts: [], options: LOT, optionsCut: { objects: 3, rooms: ["Test garden"] } });
    const near = text.indexOf("- Test fridge (here, 1.0 m): a1 Cook");
    const elsewhere = text.indexOf("Elsewhere on the lot:");
    expect(near).toBeGreaterThan(-1);
    expect(near).toBeLessThan(elsewhere);
    expect(text).toContain("Test hall:\n- Test mailbox: a2 Check the mail");
    expect(text).toContain("Test attic:\n- Test lamp: a3 All lights on");
    expect(text).toContain("Other rooms:\n- Test door: a4 Open");
    expect(text.indexOf("Test hall:")).toBeLessThan(text.indexOf("Test attic:"));
    expect(text.endsWith("The game left out 3 more choice object(s) on the lot, in Test garden.")).toBe(true);
  });

  it("says the rooms it left out as not named when the game named none", () => {
    const text = renderView({ world: "slot3", percepts: [], options: LOT, optionsCut: { objects: 2, rooms: [] } });
    expect(text).toContain("The game left out 2 more choice object(s) on the lot, in rooms it did not name.");
  });

  it("gives the choices in full only when they differ from the last view on the thread, ignoring distances", () => {
    const sig = choicesSignature(LOT);
    const moved = LOT.map((object) => ({ ...object, where: object.where ? "9 m" : object.where }));
    const same = renderView({ world: "slot3", percepts: [], options: moved, lastChoices: sig, optionsCut: { objects: 1, rooms: ["Test garden"] } });
    expect(same).toContain("Choices: the same as in the last view.");
    expect(same).not.toContain("Test mailbox");
    expect(same.endsWith("The game left out 1 more choice object(s) on the lot, in Test garden.")).toBe(true);
    const grown = renderView({
      world: "slot3", percepts: [], options: [...LOT, { object: "Test rug", object_id: "o5", acts: [{ ref: "a5", guid64: "5", text: "Sit" }] }], lastChoices: sig,
    });
    expect(grown).toContain("Test rug");
    expect(grown).not.toContain("the same as in the last view");
    expect(renderView({ world: "slot3", percepts: [], options: LOT })).toContain("Test mailbox");
  });

  it("counts a change in a choice's words, its no-way or its opens as a change", () => {
    const sig = choicesSignature(LOT);
    const opens = LOT.map((object) => (object.object === "Test door" ? { ...object, acts: [{ ...object.acts[0]!, opens: "a screen only you can use" }] } : object));
    expect(choicesSignature(opens)).not.toBe(sig);
    const worded = LOT.map((object) => (object.object === "Test door" ? { ...object, acts: [{ ...object.acts[0]!, text: "Close" }] } : object));
    expect(choicesSignature(worded)).not.toBe(sig);
    expect(choicesSignature(LOT.map((object) => ({ ...object, where: "3 m" })))).toBe(sig);
    expect(choicesSignature([])).toBe("");
  });

  it("names the view's size as twenty thousand characters", () => {
    expect(VIEW_TEXT_MAX).toBe(20_000);
  });
});

describe("the brief of an older view", () => {
  it("gives the percept lines only, in the words the view shows them, with no body and no choices", () => {
    const brief = viewBrief([
      { kind: "sim_arrives", salience: 0, facts: { subject: "Pim Dorrow" } },
      { kind: "sleep_onset", salience: 0, facts: {} },
    ]);
    expect(brief).toBe("- sim arrives: subject Pim Dorrow\n- She fell asleep.");
  });

  it("says An earlier view. when there are no percept lines", () => {
    expect(viewBrief([])).toBe("An earlier view.");
  });

  it("stays short, and says how many percepts it left out", () => {
    const long = "z".repeat(80);
    const percepts = Array.from({ length: 100 }, (_, index) => ({ kind: `kind_${index}`, salience: 0, facts: { a: long, b: long } }));
    const brief = viewBrief(percepts);
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX + 100);
    expect(brief).toMatch(/more not shown\)/);
  });
});

describe("the game's notices and her own changes, as plain sentences", () => {
  it("says a notice of the game with its title, and without one", () => {
    expect(perceptSentence({ kind: "notice", salience: 1, facts: { title: "Bills are due", text: "Pay them soon." } }))
      .toBe("The game says: Bills are due: Pay them soon.");
    expect(perceptSentence({ kind: "notice", salience: 1, facts: { text: "Pay them soon" } })).toBe("The game says: Pay them soon.");
  });

  it("says a change to her own self as the text was sent, with a full stop only when it has none", () => {
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Skill: Cooking 4 (was 3)." } })).toBe("Skill: Cooking 4 (was 3).");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "New want: Learn to cook" } })).toBe("New want: Learn to cook.");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Was that a want?" } })).toBe("Was that a want?");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Done!" } })).toBe("Done!");
  });

  it("falls back to the old line for a notice or a self change that is malformed", () => {
    const malformed: Array<{ kind: string; facts: Record<string, unknown> }> = [
      { kind: "notice", facts: {} },
      { kind: "notice", facts: { text: 3 } },
      { kind: "notice", facts: { text: "" } },
      { kind: "notice", facts: { title: "Bills are due" } },
      { kind: "notice", facts: { title: 5, text: "Pay them soon" } },
      { kind: "notice", facts: { title: "", text: "Pay them soon" } },
      { kind: "self", facts: {} },
      { kind: "self", facts: { text: "   " } },
      { kind: "self", facts: { text: 4 } },
    ];
    for (const percept of malformed) {
      expect(perceptSentence({ ...percept, salience: 0.5 })).toBeUndefined();
    }
    const text = renderView({
      world: "slot3", options: [], percepts: [{ kind: "notice", salience: 1, facts: { text: 3 } }, { kind: "self", salience: 1, facts: {} }],
    });
    expect(text).toContain("- notice: text 3");
    expect(text).toContain("- self");
  });

  it("shows both in a view and in a brief, as their sentences", () => {
    const percepts = [
      { kind: "notice", salience: 1, facts: { title: "Bills are due", text: "Pay them soon." } },
      { kind: "self", salience: 0.5, facts: { text: "New want: Learn to cook" } },
    ];
    const text = renderView({ world: "slot3", percepts, options: [] });
    expect(text).toContain("- The game says: Bills are due: Pay them soon.\n- New want: Learn to cook.");
    expect(viewBrief(percepts)).toBe("- The game says: Bills are due: Pay them soon.\n- New want: Learn to cook.");
  });
});

describe("the look she asked for", () => {
  it("says it is the look she asked for, whatever its facts say", () => {
    expect(perceptSentence({ kind: "look", salience: 1, facts: { subject: "self", object: "", bucket: "asked" } })).toBe("This is the look you asked for.");
    expect(perceptSentence({ kind: "look", salience: 1, facts: {} })).toBe("This is the look you asked for.");
  });
});

describe("the game's record of the day in a view", () => {
  const DAY = {
    v: 1, from_minute: 0, to_minute: 1440,
    frames: [{ day: 3, acts: 1, slept: ["23:10:00.000 day:2 week:0"], woke: [], company: [], body_on_its_own: {} }],
    acts: [], also: {}, omitted: 0,
  };
  const SECTION = "The game's record of your day (facts only):\n- Day 3: slept 23:10.";

  it("comes after her body block and before what the game shows, in the full view", () => {
    const text = renderView({
      world: "slot3", percepts: [{ kind: "sleep_onset", salience: 1, facts: {} }], options: [], portrait: { mood: "Zesty" }, day: DAY,
    });
    expect(text).toBe(`Your body now:\nMood: zesty.\n\n${SECTION}\n\nThe game (slot3) shows:\n- She fell asleep.\n\nThe game offers no choices in this view.`);
  });

  it("is not shown when the view carries no record, so the view reads as before", () => {
    const text = renderView({ world: "slot3", percepts: [], options: [], portrait: { mood: "Zesty" } });
    expect(text).not.toContain("record of your day");
  });

  it("gives an older view one brief line that the record came with it, and nothing more of the record", () => {
    expect(viewBrief([{ kind: "sleep_onset", salience: 0, facts: {} }], true)).toBe("- She fell asleep.\n- The game's record of your day came with this view.");
    expect(viewBrief([], true)).toBe("- The game's record of your day came with this view.");
    expect(viewBrief([])).toBe("An earlier view.");
  });
});
