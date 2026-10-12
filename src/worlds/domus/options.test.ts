import { describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import {
  BRIEF_MAX, choicesSignature, findOption, labelOf, optionsOf, perceptLine, perceptSentence, refsOf, renderView, unchangedLookLine,
  VIEW_TEXT_MAX, viewBrief,
} from "./options.js";

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
      percepts: [{ kind: "presence", salience: 0.9, facts: { bucket: "arrived", name: "Pim Dorrow", count: 2 } }],
      options: TABLE,
    });
    expect(text).toContain("The game shows:");
    expect(text).toContain("Choices you can name with game_act, by ref:");
    expect(text).toContain("- Test kettle (here, 2.0 m): a1 Boil water; a2 Tidy up [a screen only you can use]");
    expect(text).toContain("Other rooms:\n  No way to get there from here.\n- Test bench: a3 Sit down");
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
    expect(text).toContain("- You're desperately lonely.");
    expect(text).not.toContain("Hunger");
    expect(text).not.toContain("Fun");
    expect(text).toContain("- You're about to fall asleep where you stand.");
    expect(text).toContain("- Mood: flirty now (was sad).");
    expect(text).toContain("- Mirror gussy up started (your act).");
    expect(text).toContain("- Sim stand ended (the game).");
    expect(text).toContain("- Y started (the game, on its own).");
    expect(text).toContain("- Mara Quill arrived, 49 m away, sim stand (guest).");
    expect(text).toContain("- Tobin Ash left.");
    expect(text).toContain("- You moved rooms.");
    expect(text).toContain("- Posture: sitting.");
    expect(text).toContain("- You fell asleep.");
    expect(text).toContain("- Part of the game's feed was missed.");
    expect(text).not.toContain("subject");
    expect(text).not.toContain("value");
  });

  it("says a presence in plain words, and shows no line for a kind it does not know", () => {
    const text = renderView({ world: "slot3", percepts: [{ kind: "presence", salience: 0.9, facts: { bucket: "arrived", name: "Pim Dorrow", count: 2 } }], options: [] });
    expect(text).toContain("- Pim Dorrow arrived.");
    const unknown = renderView({ world: "slot3", percepts: [{ kind: "sim_arrives", salience: 0.9, facts: { subject: "Pim Dorrow" } }], options: [] });
    expect(unknown).not.toContain("sim arrives");
    expect(unknown).not.toContain("Pim Dorrow");
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
    const percepts = Array.from({ length: 100 }, () => ({ kind: "notice", salience: 0.5, facts: { text: long.repeat(2), title: long.repeat(2) } }));
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
    expect(text.endsWith("3 more things on the lot are not listed, to keep this view short.")).toBe(true);
  });

  it("says the game's choices are still coming, instead of a choices block, until its first whole menu", () => {
    const pending = renderView({ world: "slot3", percepts: [], options: [], choicesPending: true });
    expect(pending).toContain("\nThe game has not sent its choices yet. They come with a later view.");
    expect(pending).not.toContain("Choices you can name");
    expect(pending).not.toContain("offers no choices");
    const settled = renderView({ world: "slot3", percepts: [], options: [], choicesPending: false });
    expect(settled).toContain("The game offers no choices in this view.");
    expect(settled).not.toContain("has not sent its choices");
  });

  it("gives her queue its own group after the near objects, never under a room, and says Elsewhere only when objects follow it", () => {
    const queue: OptionObject = { object: "What you are doing", object_id: "queue:her", where: "your queue", acts: [{ ref: "a5", guid64: "5", text: "Sit down" }] };
    const text = renderView({ world: "slot3", percepts: [], options: [LOT[0]!, queue, LOT[1]!] });
    const near = text.indexOf("- Test fridge");
    const doing = text.indexOf("What you are doing now:\n- a5 Sit down");
    const elsewhere = text.indexOf("Elsewhere on the lot:");
    expect(near).toBeGreaterThan(-1);
    expect(near).toBeLessThan(doing);
    expect(doing).toBeLessThan(elsewhere);
    expect(text).not.toContain("Other rooms:");
    expect(text).toContain("Test hall:\n- Test mailbox: a2 Check the mail");

    const onlyQueue = renderView({ world: "slot3", percepts: [], options: [LOT[0]!, queue] });
    expect(onlyQueue).toContain("What you are doing now:");
    expect(onlyQueue).not.toContain("Elsewhere on the lot:");
    expect(renderView({ world: "slot3", percepts: [], options: [LOT[0]!] })).not.toContain("Elsewhere on the lot:");
  });

  it("says how many things the game left out, when it named no rooms", () => {
    const text = renderView({ world: "slot3", percepts: [], options: LOT, optionsCut: { objects: 2, rooms: [] } });
    expect(text).toContain("2 more things on the lot are not listed, to keep this view short.");
  });

  it("lists the choices in full on every view, ignoring distances, and says what the game left out", () => {
    const moved = LOT.map((object) => ({ ...object, where: object.where ? "9 m" : object.where }));
    const text = renderView({ world: "slot3", percepts: [], options: moved, optionsCut: { objects: 1, rooms: ["Test garden"] } });
    expect(text).toContain("Test mailbox");
    expect(text).not.toContain("the same as in the last view");
    expect(text.endsWith("1 more thing on the lot is not listed, to keep this view short.")).toBe(true);
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

  it("counts a move to another room, or into or out of near, as a change of choices (C7)", () => {
    const sig = choicesSignature(LOT);
    expect(choicesSignature(LOT.map((object) => ({ ...object, room: "Test kitchen" })))).not.toBe(sig);
    expect(choicesSignature(LOT.map((object) => ({ ...object, near: true })))).not.toBe(sig);
    const kitchen = LOT.map((object) => ({ ...object, room: "Test kitchen" }));
    expect(choicesSignature(kitchen)).not.toBe(choicesSignature(LOT.map((object) => ({ ...object, room: "Test hall" }))));
  });
});

describe("a look that changed nothing (D2)", () => {
  const CLOCK = { time: { weekday: "Monday", hour: 14, minute: 5 }, paused: false, clock_speed: "normal" };
  const LOOK = [{ kind: "look", salience: 1, facts: {} }];
  const OPTIONS: OptionObject[] = [{ object: "Test kettle", object_id: "obj-kettle", acts: [{ ref: "a1", guid64: "111", text: "Boil water" }] }];
  const SAME = choicesSignature(OPTIONS);

  it("answers a look that is only the look, with the same choices, in one line with the game's clock", () => {
    expect(unchangedLookLine({ percepts: LOOK, options: OPTIONS, lastChoices: SAME, portrait: CLOCK, hasDay: false }))
      .toBe("Your look: no change in the game since your last view, and the choices are the same. Game time: Monday 14:05, running (clock speed normal).");
  });

  it("says no clock when the portrait has none", () => {
    expect(unchangedLookLine({ percepts: LOOK, options: OPTIONS, lastChoices: SAME, portrait: undefined, hasDay: false }))
      .toBe("Your look: no change in the game since your last view, and the choices are the same.");
  });

  it("is not one line when anything else changed: another percept, other choices, a day record, or no earlier view to compare", () => {
    const other = [...LOOK, { kind: "need", salience: 0.5, facts: { subject: "social", band: "low" } }];
    expect(unchangedLookLine({ percepts: other, options: OPTIONS, lastChoices: SAME, portrait: CLOCK, hasDay: false })).toBeUndefined();
    const moved = [{ ...OPTIONS[0]!, room: "Test hall" }];
    expect(unchangedLookLine({ percepts: LOOK, options: moved, lastChoices: SAME, portrait: CLOCK, hasDay: false })).toBeUndefined();
    expect(unchangedLookLine({ percepts: LOOK, options: OPTIONS, lastChoices: SAME, portrait: CLOCK, hasDay: true })).toBeUndefined();
    expect(unchangedLookLine({ percepts: LOOK, options: OPTIONS, lastChoices: undefined, portrait: CLOCK, hasDay: false })).toBeUndefined();
    expect(unchangedLookLine({ percepts: LOOK, options: undefined, lastChoices: SAME, portrait: CLOCK, hasDay: false })).toBeUndefined();
    expect(unchangedLookLine({ percepts: [], options: OPTIONS, lastChoices: SAME, portrait: CLOCK, hasDay: false })).toBeUndefined();
  });
});

describe("the view's size", () => {
  it("names the view's size as twenty thousand characters", () => {
    expect(VIEW_TEXT_MAX).toBe(20_000);
  });
});

describe("the brief of an older view", () => {
  it("gives the percept lines only, in the words the view shows them, with no body and no choices", () => {
    const brief = viewBrief([
      { kind: "presence", salience: 0, facts: { bucket: "arrived", name: "Pim Dorrow" } },
      { kind: "sleep_onset", salience: 0, facts: {} },
    ]);
    expect(brief).toBe("- Pim Dorrow arrived.\n- You fell asleep.");
  });

  it("says An earlier view. when there are no percept lines", () => {
    expect(viewBrief([])).toBe("An earlier view.");
  });

  it("stays short, and says how many percepts it left out", () => {
    const long = "z".repeat(80);
    const percepts = Array.from({ length: 100 }, () => ({ kind: "notice", salience: 0, facts: { text: long, title: long } }));
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

  it("drops a game token from a notice, from an old-style fact line, and from the words of an act in a view", () => {
    expect(perceptSentence({ kind: "notice", salience: 1, facts: { title: "Tidy {1.Number}", text: "{0.SimFirstName} tidied up" } }))
      .toBe("The game says: Tidy: tidied up.");
    expect(perceptLine({ kind: "mystery", salience: 0, facts: { note: "{0.SimFirstName} came" } })).toBeUndefined();
    const view = renderView({
      world: "slot3", percepts: [], options: [{ object: "Test {0.SimFirstName} kettle", object_id: "obj-k", acts: [{ ref: "a1", guid64: "111", text: "Boil {1.Number} water" }] }],
    });
    expect(view).toContain("- Test kettle: a1 Boil water");
    expect(view).not.toMatch(/[{}]/);
  });

  it("says a need change as the feeling it is, and an ok need not at all", () => {
    const need = (facts: Record<string, unknown>) => perceptLine({ kind: "need", salience: 0.5, facts });
    expect(need({ subject: "Bladder", band: "low" })).toBe("- You need the toilet.");
    expect(need({ subject: "Comfort", band: "distress" })).toBe("- Comfort is bothering you badly.");
    expect(need({ subject: "hunger", value: 12 })).toBe("- You're starving.");
    expect(need({ subject: "hunger", band: "ok" })).toBeUndefined();
    expect(need({ band: "low" })).toBeUndefined();
  });

  it("says a change to her own self as the text was sent, with a full stop only when it has none", () => {
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Skill: Cooking 4 (was 3)." } })).toBe("Skill: Cooking 4 (was 3).");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "New want: Learn to cook" } })).toBe("New want: Learn to cook.");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Was that a want?" } })).toBe("Was that a want?");
    expect(perceptSentence({ kind: "self", salience: 0.5, facts: { text: "Done!" } })).toBe("Done!");
  });

  it("shows no line for a notice or a self change that is malformed, rather than its raw fields", () => {
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
    expect(text).not.toContain("- notice");
    expect(text).not.toContain("- self");
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
    expect(text).toBe(`Your body now:\nMood: zesty.\n\n${SECTION}\n\nThe game shows:\n- You fell asleep.\n\nThe game offers no choices in this view.`);
  });

  it("is not shown when the view carries no record, so the view reads as before", () => {
    const text = renderView({ world: "slot3", percepts: [], options: [], portrait: { mood: "Zesty" } });
    expect(text).not.toContain("record of your day");
  });

  it("gives an older view one brief line that the record came with it, and nothing more of the record", () => {
    expect(viewBrief([{ kind: "sleep_onset", salience: 0, facts: {} }], true)).toBe("- You fell asleep.\n- The game's record of your day came with this view.");
    expect(viewBrief([], true)).toBe("- The game's record of your day came with this view.");
    expect(viewBrief([])).toBe("An earlier view.");
  });

  it("says a change to the save, and the room you moved to, in the second person", () => {
    const text = viewBrief([
      { kind: "env", salience: 0, facts: { from_room: "Test Hall" } },
      { kind: "lineage", salience: 0, facts: { bucket: "Test Bucket", reason: "Test reason" } },
    ]);
    expect(text).toContain("- You moved rooms.");
    expect(text).toContain("- The game's save changed.");
    expect(text).not.toMatch(/\b(She|she|Her|her)\b/);
  });
});

describe("an option object's refusals, states and left-out acts (T3, T2)", () => {
  const KETTLE = {
    object: "Test kettle", object_id: "obj-kettle", acts: [{ ref: "a1", guid64: "111", text: "Boil water" }],
    refused: ["Boil water: refused: the water is off"], states: ["dirty", "broken"],
    left_out: ["Call Test Friend: left out: it is not on your phone list"],
  } as OptionObject;

  it("renders the states and the reasons as indented lines under the object, in that order", () => {
    const text = renderView({ world: "slot3", percepts: [], options: [KETTLE] });
    expect(text).toContain(
      "- Test kettle: a1 Boil water\n  States: dirty, broken.\n  Boil water: refused: the water is off\n  Left out of your phone: Call Test Friend (it is not on your phone list).",
    );
  });

  it("keeps a refusal that has a reason word for word, and says the ones with no reason as one count line", () => {
    const text = renderView({
      world: "slot3", percepts: [], options: [{ ...KETTLE, refused: ["Boil water: refused: the water is off", "Tidy up: refused: no reason given", "Sit: refused: no reason given"] }],
    });
    expect(text).toContain("  Boil water: refused: the water is off\n  2 more acts the game does not offer here now.");
    expect(text).not.toContain("no reason given");
    const one = renderView({ world: "slot3", percepts: [], options: [{ ...KETTLE, refused: ["Tidy up: refused: no reason given"] }] });
    expect(one).toContain("  1 more act the game does not offer here now.");
  });

  it("groups the left-out acts into one line by reason, naming a small group and counting a large one", () => {
    const text = renderView({
      world: "slot3",
      percepts: [],
      options: [{
        object: "Test phone", object_id: "obj-phone", near: true, acts: [{ ref: "a1", guid64: "1", text: "Call Mara" }],
        left_out: [
          "Ask on Date: left out: it takes you off the lot", "Test Cheat 1: left out: a debug or cheat act", "Hang Out: left out: it takes you off the lot",
          ...[2, 3, 4, 5, 6].map((n) => `Test Cheat ${n}: left out: a debug or cheat act`),
        ],
      }],
    });
    expect(text).toContain("  Left out of your phone: Ask on Date, Hang Out (it takes you off the lot); 6 acts (a debug or cheat act).");
  });

  it("adds the states, the refusals and the left-out acts to the choices, so a change lists them again", () => {
    const sig = choicesSignature([KETTLE]);
    expect(choicesSignature([{ ...KETTLE, refused: ["Boil water: refused: the water is cold"] }])).not.toBe(sig);
    expect(choicesSignature([{ ...KETTLE, states: ["dirty"] }])).not.toBe(sig);
    expect(choicesSignature([{ ...KETTLE, left_out: [] }])).not.toBe(sig);
    const again = renderView({ world: "slot3", percepts: [], options: [{ ...KETTLE, refused: ["Boil water: refused: the water is cold"] }] });
    expect(again).toContain("the water is cold");
    expect(again).not.toContain("the same as in the last view");
  });
});

describe("the view after the third audit: plain sentences, the whole cap, the choices", () => {
  const NEAR: OptionObject = { object: "Test kettle", object_id: "obj-kettle", where: "here, 1.0 m", near: true, acts: [{ ref: "a1", guid64: "1", text: "Boil water" }] };

  it("says an interaction in one plain sentence, with no code or detail word", () => {
    expect(perceptSentence({ kind: "interaction", salience: 1, facts: { bucket: "idle" } })).toBe("You are idle.");
    expect(perceptSentence({
      kind: "interaction", salience: 1, facts: { bucket: "act_rejected", affordance_text: "<class 'x.y.Test_Stove'>", code: "3", detail: "clock" },
    })).toBe("The game refused test stove.");
    expect(perceptSentence({ kind: "interaction", salience: 1, facts: { bucket: "act_unknown", code: "17" } })).toBe("It is not known what became of an act.");
    expect(perceptSentence({ kind: "interaction", salience: 1, facts: { bucket: "started", origin: "her_choice" } })).toBe("Your act started.");
    expect(perceptSentence({ kind: "interaction", salience: 1, facts: { bucket: "ended", origin: "game" } })).toBe("An act ended (the game).");
    expect(perceptSentence({ kind: "interaction", salience: 1, facts: { bucket: "act_never_started", affordance_text: "<class 'x.y.Test_Sit'>" } }))
      .toBe("Test sit never started.");
  });

  it("says a life-line record in one plain sentence, and says nothing for a save that continues her life", () => {
    expect(perceptSentence({ kind: "lineage", salience: 1, facts: { bucket: "BODY_GONE", reason: "DEAD", death_type: "DROWNED" } }))
      .toBe("You died in the game. The game gives the cause as drowned.");
    expect(perceptSentence({ kind: "lineage", salience: 1, facts: { bucket: "BODY_GONE", reason: "GHOST" } }))
      .toBe("You died in the game, and you are a ghost now.");
    expect(perceptSentence({ kind: "lineage", salience: 1, facts: { bucket: "CONTINUES_LAST_SAVE" } })).toBeUndefined();
    expect(perceptSentence({ kind: "lineage", salience: 1, facts: { bucket: "READ_FAILURE:KeyError" } })).toBe("The link to the game could not read the save.");
  });

  it("reads a need value sent as a string of digits as its number", () => {
    expect(perceptSentence({ kind: "need", salience: 1, facts: { subject: "hunger", value: "15" } })).toBe("You're starving.");
    expect(perceptSentence({ kind: "need", salience: 1, facts: { subject: "hunger", value: 15 } })).toBe("You're starving.");
  });

  it("adds the helper's count of acts past its line cap to that reason's count", () => {
    const text = renderView({
      world: "slot3", percepts: [], options: [{
        ...NEAR, left_out: ["Test Cheat 1: left out: a debug, cheat or test act", "61 more acts: left out: a debug, cheat or test act"],
      }],
    });
    expect(text).toContain("Left out of your phone: 62 acts (a debug, cheat or test act).");
  });

  it("says the game's choices are still coming, after the choices, when some are listed", () => {
    const text = renderView({ world: "slot3", percepts: [], options: [NEAR], choicesPending: true });
    expect(text.endsWith("More of the game's choices are still coming; these are the ones near you.")).toBe(true);
    expect(renderView({ world: "slot3", percepts: [], options: [NEAR] })).not.toContain("still coming");
  });

  it("does not say a percept the body block already says", () => {
    const text = renderView({
      world: "slot3", percepts: [{ kind: "need", salience: 1, facts: { subject: "hunger", value: 15 } }], options: [],
      portrait: { needs: { hunger: { value: 15 } } },
    });
    expect(text.split("You're starving.").length - 1).toBe(1);
  });

  it("keeps the whole view within its size, counting the choices, and cuts the farthest objects first", () => {
    const far: OptionObject[] = Array.from({ length: 400 }, (_, index) => ({
      object: `Test thing ${index}`, object_id: `o${index}`, room: "Test hall", where: `elsewhere, ${index}.0 m`,
      acts: [{ ref: `a${index + 2}`, guid64: `${index + 2}`, text: `Look at it closely, from the far side of the room, ${"and again".repeat(6)}` }],
    }));
    const text = renderView({ world: "slot3", percepts: [], options: [NEAR, ...far] });
    expect(text.length).toBeLessThanOrEqual(VIEW_TEXT_MAX);
    expect(text).toContain("- Test thing 0 (0.0 m): a2 Look at it closely");
    expect(text).not.toContain("Test thing 399");
    expect(text).toMatch(/\d+ more things on the lot are not listed, to keep this view short\./);
  });
});
