import { describe, expect, it } from "vitest";
import { bodyLines, needFeeling } from "./body.js";
import { renderView, viewBrief } from "./options.js";

const BUSY = {
  needs: {
    social: { value: 5, band: "distress" },
    hunger: { value: 61, band: "ok" },
    fun: { value: 99, band: "full" },
    energy: { value: 40, band: "low" },
    bladder: { value: 50 },
  },
  posture: "Sitting",
  running: ["mirror gussy up"],
  queued: ["Cook", "<class 'sims4.tuning.instances.sim-stand'>"],
  zone: { zone_id: 7, lot_id: 9, room_label: "Test kitchen" },
  time: { hour: 14, minute: 5, weekday: "Monday", day_index: 0, week: 3 },
  clock_speed: "normal",
  paused: false,
  mood: "Flirty",
  moodlets: [
    { id: 1, name: "Mood_Flirty", text: "Feeling flirty", weight: 2, mood: "Flirty" },
    { id: 2, name: "Tipsy", weight: 1, mood: "Happy" },
  ],
  company: [
    { id: "101", name: "Mara Quill", distance_m: "49.2", doing: "<class 'sims4.tuning.instances.sim-stand'>" },
    { heard: true, handle: "h1", distance_m: "12.4" },
    { heard: true, handle: "h2", distance_m: "30" },
  ],
  addressed_by: [{ by: "101", interaction: "<class 'sims4.tuning.instances.social_chat'>" }, { by: "999", interaction: "greet" }],
  asked: [
    { dialog_id: "d1", title: "Pick a recipe", text: "Choose one.", choices: [], answers_itself: false, held: true, whose: "yours" },
    { dialog_id: "d2", title: "Planner", text: null, answers_itself: false, held: false, whose: "the User's" },
  ],
  windows: [{ event: "window_opened", code: "held", ago_min: 3 }],
  near_conditions: [{ object: "<class 'x.fridge'>", states: ["spoiled"] }],
  building: true,
  fire_on_lot: true,
  user_plays_another: true,
  company_complete: false,
  more_nearby: true,
  place: { her_home: true, household_here: ["Test Parent"], household_heard: 2 },
  situations: [{ role: "guest" }],
  self: { traits: ["Test trait"] },
};

describe("her body now", () => {
  it("says the game time, the room, what she does and what is queued, in words", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("Game time: Monday 14:05, running (clock speed normal).");
    expect(lines).toContain("Room: Test kitchen.");
    expect(lines).toContain("Posture: sitting.");
    expect(lines).toContain("Doing: mirror gussy up.");
    expect(lines).toContain("Queued: cook, sim stand.");
    expect(lines).toContain("Mood: flirty.");
    expect(lines).toContain("Moodlets: Feeling flirty; tipsy.");
  });

  it("says every felt need, the worst first, and never as a number or a level word", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("You're desperately lonely. You're getting tired. You'll need the toilet soon.");
    const text = lines.join("\n");
    expect(text).not.toContain("Needs:");
    expect(text).not.toMatch(/\b(very low|low|fine|full)\b/);
    expect(lines.find((line) => line.includes("lonely"))).not.toMatch(/\d/);
  });

  /** The body lines for one need at one value, the other needs all fine. */
  function feltBy(id: string, value: number | null, band?: string): string[] {
    return bodyLines({ needs: { [id]: { value, ...(band === undefined ? {} : { band }) } } });
  }

  it("grades a need by its value at each band edge (bladder, the game's own words)", () => {
    expect(feltBy("bladder", 60)).toContain("Nothing is bothering you.");
    expect(feltBy("bladder", 59)).toContain("You'll need the toilet soon.");
    expect(feltBy("bladder", 40)).toContain("You'll need the toilet soon.");
    expect(feltBy("bladder", 39)).toContain("You need the toilet.");
    expect(feltBy("bladder", 20)).toContain("You need the toilet.");
    expect(feltBy("bladder", 19)).toContain("You badly need the toilet; you can't hold it much longer.");
    expect(feltBy("bladder", 6)).toContain("You badly need the toilet; you can't hold it much longer.");
    expect(feltBy("bladder", 5)).toContain("You're about to wet yourself.");
    expect(feltBy("bladder", 0)).toContain("You're about to wet yourself.");
  });

  it("gives each known need its own words at the four grades", () => {
    const grades: Array<[string, string[]]> = [
      ["hunger", ["You're getting peckish.", "You're hungry.", "You're starving.", "You're so hungry you could faint."]],
      ["energy", ["You're getting tired.", "You're tired.", "You're exhausted.", "You're about to fall asleep where you stand."]],
      ["fun", ["You're a little bored.", "You're bored.", "You're very bored.", "You're bored out of your mind."]],
      ["social", ["You'd like some company.", "You're lonely.", "You're very lonely.", "You're desperately lonely."]],
      ["hygiene", ["You could use a wash.", "You feel grubby.", "You feel filthy.", "You smell awful, and people will notice."]],
    ];
    for (const [id, words] of grades) {
      [50, 30, 10, 2].forEach((value, index) => expect(feltBy(id, value)).toContain(words[index]));
    }
  });

  it("says any other need as '<need> is ...' by grade", () => {
    expect(feltBy("comfort", 50)).toContain("Comfort is starting to bother you.");
    expect(feltBy("comfort", 30)).toContain("Comfort is bothering you.");
    expect(feltBy("comfort", 10)).toContain("Comfort is bothering you badly.");
    expect(feltBy("comfort", 2)).toContain("Comfort is about to overwhelm you.");
  });

  it("grades a need by its band when its value is null: distress is urgent, low a need, ok nothing", () => {
    expect(feltBy("social", null, "distress")).toContain("You're very lonely.");
    expect(feltBy("social", null, "low")).toContain("You're lonely.");
    expect(feltBy("social", null, "ok")).toContain("Nothing is bothering you.");
  });

  it("says nothing bothers her when no need is below 60, and says nothing at all when the portrait has no needs", () => {
    expect(bodyLines({ needs: { hunger: { value: 80, band: "ok" }, fun: { value: 99, band: "full" } } })).toContain("Nothing is bothering you.");
    expect(bodyLines({ needs: {} }).join("\n")).not.toContain("Nothing is bothering you.");
    expect(bodyLines({}).join("\n")).not.toContain("Nothing is bothering you.");
  });

  it("says every felt need, worst first", () => {
    const lines = bodyLines({ needs: { hunger: { value: 30 }, energy: { value: 10 }, bladder: { value: 5 } } });
    expect(lines).toContain("You're about to wet yourself. You're exhausted. You're hungry.");
  });

  it("names who is with her, the sounds she hears, and who is talking to her", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("With you: Mara Quill (49 m away, sim stand).");
    expect(lines).toContain("Heard but not seen: 2 (nearest 12 m away).");
    expect(lines).toContain("Talking to you: Mara Quill (social chat).");
    expect(lines).toContain("Talking to you: someone (greet).");
  });

  it("C2: says which senses are unavailable (needs, moodlets or both), in one wording, and nothing when all were read", () => {
    const line = (list: unknown) => bodyLines({ ...BUSY, senses_unavailable: list }).filter((l) => l.startsWith("Senses unavailable"));
    expect(line(["needs"])).toEqual([
      "Senses unavailable: your needs could not be read from the game just now, so they are not shown. Do not guess them.",
    ]);
    expect(line(["moodlets"])).toEqual([
      "Senses unavailable: your moodlets could not be read from the game just now, so they are not shown. Do not guess them.",
    ]);
    expect(line(["needs", "moodlets"])).toEqual([
      "Senses unavailable: your needs and moodlets could not be read from the game just now, so they are not shown. Do not guess them.",
    ]);
    expect(line([])).toEqual([]);
    expect(line(["something else"])).toEqual([]);
    expect(bodyLines(BUSY).some((l) => l.startsWith("Senses unavailable"))).toBe(false);
  });

  it("says whose each open window is, and whether it is held for her", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("Open for you: Pick a recipe (held for you). Choose one.");
    expect(lines).toContain("Open on your summoner's screen: Planner.");
  });

  it("says the flags, the place and the recent windows, and skips what is absent", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("Build mode is on.");
    expect(lines).toContain("A fire is burning on the lot.");
    expect(lines).toContain("Your summoner is playing another Sim of the household, so your acts are refused for now.");
    expect(lines).toContain("The list of people with you may be missing someone.");
    expect(lines).toContain("More Sims are nearby than the list shows.");
    expect(lines).toContain("This is your home.");
    expect(lines).toContain("Household here: Test Parent.");
    expect(lines).toContain("2 more of the household is out of sight.");
    expect(lines).toContain("Recent pop-ups: window opened, 3 min ago.");
    expect(lines).toContain("Near you: fridge (spoiled).");
    expect(lines).toContain("Situations: guest.");
    expect(bodyLines({})).toEqual([]);
    expect(bodyLines({ needs: "bad", company: 3, asked: [null, 4] })).toEqual([]);
  });

  it("never throws on a malformed portrait, and keeps a busy one compact", () => {
    expect(bodyLines(undefined)).toEqual([]);
    expect(bodyLines("text")).toEqual([]);
    expect(bodyLines([1, 2])).toEqual([]);
    expect(bodyLines({ time: { hour: 99, minute: 0, weekday: "Monday" }, paused: true, zone: 3 })).toEqual(["The game is paused."]);
    expect(bodyLines(BUSY).join("\n").length).toBeLessThan(1200);
  });
});

describe("the view starts with her body", () => {
  it("puts the block above what the game shows, and leaves the view as it was when there is no portrait", () => {
    const withBody = renderView({
      world: "slot3",
      portrait: { zone: { room_label: "Test kitchen" }, paused: true },
      percepts: [{ kind: "gap", salience: 1, facts: {} }],
      options: [],
    });
    expect(withBody.startsWith("Your body now:\nThe game is paused.\nRoom: Test kitchen.\n\nThe game shows:\n")).toBe(true);
    const without = renderView({ world: "slot3", percepts: [{ kind: "gap", salience: 1, facts: {} }], options: [] });
    expect(without.startsWith("The game shows:")).toBe(true);
  });
});

describe("her attention, the first line of the block", () => {
  it("is the first line, before the attachment and the portrait", () => {
    const lines = bodyLines({ paused: true }, { attached: true }, "Your attention: every change.");
    expect(lines).toEqual(["Your attention: every change.", "The game is attached.", "The game is paused."]);
  });

  it("is shown on its own when the game is not attached and no portrait came", () => {
    expect(bodyLines(undefined, undefined, "Your attention: quiet until 14:30.")).toEqual(["Your attention: quiet until 14:30."]);
  });

  it("leads the view's body block", () => {
    const text = renderView({
      world: "slot3",
      portrait: { paused: true },
      percepts: [{ kind: "gap", salience: 1, facts: {} }],
      options: [],
      attention: "Your attention: when something calls you.",
    });
    expect(text.startsWith("Your body now:\nYour attention: when something calls you.\nThe game is paused.\n\nThe game shows:\n")).toBe(true);
  });
});

const SELF = {
  traits: ["Cheerful", "Loyal"],
  skills: [{ skill: "Cooking", level: 3 }, { skill: "Piano", level: 5 }],
  funds: 1234,
  life: { age: "young_adult", pregnant: false, sick: false, dead: false, ghost: false, npc: false },
  jobs: [{ job: "Chef", title: "Head Chef", level: 3, at_work: true }],
  wants: [
    { want: "Learn to cook", fear: false, progress: "2/3", until: "18:00", how: "Practise at the stove" },
    { want: "Feel loved", fear: false, locked: true },
    { want: "Being alone", fear: true },
  ],
};

describe("the You section of her body, in the full view", () => {
  it("says who she is, her skills, her money, her job, her wants and her fears, as the game names them", () => {
    const lines = bodyLines({ self: SELF });
    expect(lines).toEqual([
      "You are Cheerful, Loyal.",
      "Skills: Cooking 3, Piano 5.",
      "Money: §1,234.",
      "Job: Head Chef, level 3; at work now.",
      "Wants: Learn to cook (2/3, until 18:00) [Practise at the stove]; Feel loved (locked).",
      "Fears: Being alone.",
      "Age: young adult.",
    ]);
  });

  it("keeps the wants and the fears in the order the game gave them, and never sorts them", () => {
    const lines = bodyLines({ self: { wants: [...SELF.wants].reverse() } });
    expect(lines).toEqual([
      "Wants: Feel loved (locked); Learn to cook (2/3, until 18:00) [Practise at the stove].",
      "Fears: Being alone.",
    ]);
  });

  it("says a job with no title as a job, and says so when she is not at work", () => {
    expect(bodyLines({ self: { jobs: [{ job: "Chef", title: null, level: 3, at_work: true }] } })).toEqual(["Job: a job, level 3; at work now."]);
    expect(bodyLines({ self: { jobs: [{ job: "Chef", title: "Head Chef", level: 3, at_work: false }] } })).toEqual(["Job: Head Chef, level 3."]);
  });

  it("says No job. for an empty list of jobs, and nothing when the jobs are absent", () => {
    expect(bodyLines({ self: { jobs: [] } })).toEqual(["No job."]);
    expect(bodyLines({ self: { traits: ["Cheerful"] } })).toEqual(["You are Cheerful."]);
  });

  it("writes money with thousands separators, and skips it when it is not a whole number", () => {
    expect(bodyLines({ self: { funds: 1234567 } })).toEqual(["Money: §1,234,567."]);
    expect(bodyLines({ self: { funds: 0 } })).toEqual(["Money: §0."]);
    expect(bodyLines({ self: { funds: null } })).toEqual([]);
    expect(bodyLines({ self: { funds: "12" } })).toEqual([]);
  });

  it("says the life facts that are true and the age stage in plain words", () => {
    const lines = bodyLines({ self: { life: { age: "young_adult", pregnant: true, sick: true, ghost: true } } });
    expect(lines).toEqual(["You are pregnant.", "You are sick.", "You are a ghost.", "Age: young adult."]);
    expect(bodyLines({ self: { life: { age: "adult", pregnant: false, sick: false, ghost: false } } })).toEqual(["Age: adult."]);
  });

  it("skips each part that is absent or malformed, and never throws", () => {
    expect(bodyLines({ self: { traits: [1, null], skills: [null, { skill: "Cooking" }], wants: [{ fear: false }], jobs: [{ level: 2 }] } })).toEqual([]);
    expect(bodyLines({ self: null })).toEqual([]);
    expect(bodyLines({ self: 5 })).toEqual([]);
    expect(bodyLines({ self: "Cheerful" })).toEqual([]);
    expect(bodyLines({ self: { traits: "Cheerful", life: "bad", jobs: "Chef" } })).toEqual([]);
    expect(bodyLines({ self: { skills: [null, { skill: "Piano", level: 5 }] } })).toEqual(["Skills: Piano 5."]);
  });

  it("uses no advice and no judgment", () => {
    expect(bodyLines({ self: SELF }).join("\n")).not.toMatch(/could|should|ought|must|better|worse|need to/i);
  });
});

describe("the You section is only in the full view", () => {
  it("is not in the brief of a view, which carries the percept lines only", () => {
    const brief = viewBrief([{ kind: "presence", salience: 0, facts: { bucket: "arrived", name: "Pim Dorrow" } }]);
    expect(brief).not.toContain("You are");
    expect(brief).toBe("- Pim Dorrow arrived.");
    expect(renderView({ world: "slot3", percepts: [], options: [], portrait: { self: SELF } })).toContain("You are Cheerful, Loyal.");
  });
});

describe("the You section: her aspiration, her bills and what she carries", () => {
  it("says her aspiration, its objectives in the order given, and which are done", () => {
    const aspiration = { name: "Cheerful Cook", objectives: [{ text: "Make soup", done: true }, { text: "Bake bread", done: false }] };
    expect(bodyLines({ self: { aspiration } })).toEqual(["Aspiration: Cheerful Cook; now: Make soup (done), Bake bread."]);
  });

  it("skips an objective with no text, and says the aspiration alone when no objective is left", () => {
    expect(bodyLines({ self: { aspiration: { name: "Cheerful Cook", objectives: [{ text: null, done: false }, { text: "Bake bread", done: false }] } } }))
      .toEqual(["Aspiration: Cheerful Cook; now: Bake bread."]);
    expect(bodyLines({ self: { aspiration: { name: "Cheerful Cook", objectives: [{ text: null, done: true }] } } }))
      .toEqual(["Aspiration: Cheerful Cook."]);
    expect(bodyLines({ self: { aspiration: { name: "Cheerful Cook", objectives: [] } } })).toEqual(["Aspiration: Cheerful Cook."]);
  });

  it("says nothing of an aspiration with no name, or one that is malformed", () => {
    expect(bodyLines({ self: { aspiration: { name: null, objectives: [{ text: "Bake bread", done: false }] } } })).toEqual([]);
    expect(bodyLines({ self: { aspiration: "Cheerful Cook" } })).toEqual([]);
  });

  it("says the bills owed, whether they came in the mail, and whether they are late, in words", () => {
    expect(bodyLines({ self: { bills: { owed: 320, delivered: true, late: false } } })).toEqual(["Bills: §320 owed; they came in the mail."]);
    expect(bodyLines({ self: { bills: { owed: 320, delivered: false, late: false } } })).toEqual(["Bills: §320 owed."]);
    expect(bodyLines({ self: { bills: { owed: 320, delivered: true, late: true } } })).toEqual(["Bills: §320 owed; they came in the mail; late."]);
    expect(bodyLines({ self: { bills: { owed: 320, delivered: false, late: true } } })).toEqual(["Bills: §320 owed; late."]);
    expect(bodyLines({ self: { bills: { owed: 1234567, delivered: false, late: false } } })).toEqual(["Bills: §1,234,567 owed."]);
  });

  it("says No bills owed. when nothing is owed and nothing is late", () => {
    expect(bodyLines({ self: { bills: { owed: 0, delivered: true, late: false } } })).toEqual(["No bills owed."]);
    expect(bodyLines({ self: { bills: { owed: 0, delivered: false, late: false } } })).toEqual(["No bills owed."]);
    expect(bodyLines({ self: { bills: { owed: 0, delivered: false, late: true } } })).toEqual(["Bills: §0 owed; late."]);
  });

  it("skips bills that are malformed, and never throws", () => {
    expect(bodyLines({ self: { bills: { owed: null, delivered: true, late: false } } })).toEqual([]);
    expect(bodyLines({ self: { bills: { owed: "320", delivered: true, late: false } } })).toEqual([]);
    expect(bodyLines({ self: { bills: "320" } })).toEqual([]);
  });

  it("says what she carries, with a count only when there is more than one", () => {
    expect(bodyLines({ self: { inventory: [{ item: "phone", count: 1 }, { item: "apple", count: 2 }] } }))
      .toEqual(["You carry: phone, 2 × apple."]);
    expect(bodyLines({ self: { inventory: [] } })).toEqual([]);
  });

  it("skips what she carries that is malformed, and keeps the rest", () => {
    expect(bodyLines({ self: { inventory: [{ item: "phone", count: 1 }, { item: "apple" }, { item: "pen", count: 0 }, null, { count: 2 }] } }))
      .toEqual(["You carry: phone."]);
    expect(bodyLines({ self: { inventory: "phone" } })).toEqual([]);
  });

  it("comes after the rest of her You section, in the order the spec gives", () => {
    const lines = bodyLines({ self: { traits: ["Cheerful"], bills: { owed: 0, delivered: false, late: false }, inventory: [{ item: "phone", count: 1 }] } });
    expect(lines).toEqual(["You are Cheerful.", "No bills owed.", "You carry: phone."]);
  });
});

describe("the weather and the season, after the game time", () => {
  const CLOCK = { time: { hour: 14, minute: 5, weekday: "Monday", day_index: 0, week: 3 } };

  it("says the season first, capitalised, then the weather in lower case, right after the game time", () => {
    expect(bodyLines({ ...CLOCK, season: "SPRING", weather: ["SUNNY", "WINDY"] })).toEqual([
      "Game time: Monday 14:05.",
      "Spring, sunny, windy.",
    ]);
    expect(bodyLines({ ...CLOCK, zone: { room_label: "Test kitchen" }, season: "SPRING" })).toEqual([
      "Game time: Monday 14:05.",
      "Spring.",
      "Room: Test kitchen.",
    ]);
  });

  it("turns underscores into spaces, and says the weather alone when there is no season", () => {
    expect(bodyLines({ ...CLOCK, weather: ["HEAVY_RAIN"] })).toEqual(["Game time: Monday 14:05.", "Heavy rain."]);
    expect(bodyLines({ ...CLOCK, season: "SUMMER" })).toEqual(["Game time: Monday 14:05.", "Summer."]);
  });

  it("says nothing when both are absent, and says the line without a game time when there is no clock", () => {
    expect(bodyLines({ ...CLOCK, season: null, weather: [] })).toEqual(["Game time: Monday 14:05."]);
    expect(bodyLines({ season: "AUTUMN" })).toEqual(["Autumn."]);
  });

  it("skips what is malformed, and keeps the rest", () => {
    expect(bodyLines({ ...CLOCK, season: 3, weather: "sunny" })).toEqual(["Game time: Monday 14:05."]);
    expect(bodyLines({ ...CLOCK, season: "", weather: [1, null, "", "SUNNY"] })).toEqual(["Game time: Monday 14:05.", "Sunny."]);
  });
});

describe("the situations she is in, in plain words, and game tokens kept out of her body", () => {
  it("words each situation in plain words, and counts a repeat once with its count", () => {
    expect(bodyLines({ situations: [{ role: "Role_PivotalMoment" }, { role: "Role_PivotalMoment" }, { role: "Role_PivotalMoment" }] }))
      .toEqual(["Situations: pivotal moment (×3)."]);
    expect(bodyLines({ situations: [{ name: "<class 'situations.Role_BirthdayParty'>" }, { role: "Role_Guest" }, { role: "Role_Guest" }] }))
      .toEqual(["Situations: birthday party, guest (×2)."]);
  });

  it("shows at most four different situations, and skips a situation with no name", () => {
    const many = ["A", "B", "C", "D", "E"].map((letter) => ({ role: `Role_Named${letter}` }));
    expect(bodyLines({ situations: [...many, {}] })).toEqual(["Situations: named a, named b, named c, named d."]);
  });

  it("drops any game token left in her body's text, so no brace reaches her", () => {
    const lines = bodyLines({
      mood: "Happy {0.SimFirstName}",
      windows: [{ event: "{0.SimFirstName} {1.Number} tasks", ago_min: 2 }],
      place: { her_home: true, household_here: ["{0.SimFirstName} {1.Number}"] },
    });
    expect(lines.join("\n")).not.toMatch(/[{}]/);
    expect(lines).toContain("Mood: happy.");
    expect(lines).toContain("Recent pop-ups: tasks, 2 min ago.");
  });
});

describe("W12: the time a held window has left, and her role and relationship with the people she sees", () => {
  it("says how long a held window has left before the User is handed it (A9), and says nothing when the game sent no time", () => {
    expect(bodyLines({ asked: [{ whose: "yours", held: true, title: "Pick", hold_left_s: 42 }] })).toContain("Open for you: Pick (held for you, 42 s left).");
    expect(bodyLines({ asked: [{ whose: "yours", held: true, title: "Pick", hold_left_s: 130 }] })).toContain("Open for you: Pick (held for you, 3 min left).");
    expect(bodyLines({ asked: [{ whose: "yours", held: true, title: "Pick" }] })).toContain("Open for you: Pick (held for you).");
    expect(bodyLines({ asked: [{ whose: "yours", held: false, title: "Pick", hold_left_s: 42 }] })).toContain("Open for you: Pick (not held for you).");
  });

  it("names her role with a Sim she can see, and what the game holds between them (E2)", () => {
    const lines = bodyLines({ company: [
      { id: "1", name: "Ilse May", distance_m: 3, role: "neighbour", relationship: { known: true, labels: ["Friends", "Gym buddies"], track: "friendship" } },
      { id: "2", name: "Tam Reed", distance_m: 9, relationship: { met: false, tracks: { Friendship: 12 } } },
    ] });
    expect(lines).toContain("With you: Ilse May (3 m away, neighbour, known to you, Friends, Gym buddies, friendship); Tam Reed (9 m away, not met yet, friendship 12).");
  });

  it("says the role and the relationship of a Sim who is talking, after what is said", () => {
    const lines = bodyLines({ company: [{ id: "1", name: "Ilse May", distance_m: 3, said: "waves at you.", role: "courier", relationship: { known: true } }] });
    expect(lines).toContain("With you: Ilse May (3 m away: waves at you; courier, known to you).");
  });

  it("says nothing extra for a Sim with no role and no relationship, as before", () => {
    expect(bodyLines({ company: [{ id: "1", name: "Ilse May", distance_m: 3, doing: "gardening" }] })).toContain("With you: Ilse May (3 m away, gardening).");
  });
});

describe("the body block after the third audit: windows, names and needs", () => {
  it("reads a window the helper marks as hers with whose \"yours\", in the helper's shape", () => {
    // The helper's own dialog shape (observation.py): whose is "yours" for her windows and "the User's" for the others (R4).
    const helperShaped = { dialog_id: "d9", title: "Pick a recipe", text: "Choose one.", choices: [], answers_itself: true, held: true, hold_left_s: 42, whose: "yours" };
    expect(bodyLines({ asked: [helperShaped] })).toContain("Open for you: Pick a recipe (held for you, 42 s left). Choose one. It answers itself.");
  });

  it("names a near thing in the game's capitals, and says a need the table does not name without its prefix", () => {
    expect(bodyLines({ near_conditions: [{ object: "Test Stove", states: [] }] })).toContain("Near you: Test Stove.");
    expect(needFeeling("Motive_Zing", 1)).toBe("Zing is starting to bother you.");
  });

  it("says a pop-up with its name and its age, and no window code", () => {
    expect(bodyLines({ windows: [{ event: "dialog_shown", code: "ev 1", ago_min: 2 }] })).toContain("Recent pop-ups: dialog shown, 2 min ago.");
  });
});
