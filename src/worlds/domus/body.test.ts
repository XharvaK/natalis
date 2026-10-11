import { describe, expect, it } from "vitest";
import { bodyLines } from "./body.js";
import { renderView } from "./options.js";

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
    { dialog_id: "d1", title: "Pick a recipe", text: "Choose one.", choices: [], answers_itself: false, held: true, whose: "hers" },
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

  it("says each need by its band in words and never by its number", () => {
    const lines = bodyLines(BUSY);
    const needs = lines.find((line) => line.startsWith("Needs:"));
    expect(needs).toBe("Needs: social very low, hunger fine, fun full, energy low.");
    expect(needs).not.toMatch(/\d/);
  });

  it("names who is with her, the sounds she hears, and who is talking to her", () => {
    const lines = bodyLines(BUSY);
    expect(lines).toContain("With you: Mara Quill (49 m away, sim stand).");
    expect(lines).toContain("Heard but not seen: 2 (nearest 12 m away).");
    expect(lines).toContain("Talking to you: Mara Quill (social chat).");
    expect(lines).toContain("Talking to you: someone (greet).");
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
    expect(lines).toContain("The company list missed someone in this sample.");
    expect(lines).toContain("More Sims are nearby than the list shows.");
    expect(lines).toContain("This is her home.");
    expect(lines).toContain("Household here: Test Parent.");
    expect(lines).toContain("2 more of the household is out of sight.");
    expect(lines).toContain("Recent windows: window opened (held), 3 min ago.");
    expect(lines).toContain("Near you: fridge (spoiled).");
    expect(lines).toContain("Situations: Guest.");
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
    expect(withBody.startsWith("Your body now:\nThe game is paused.\nRoom: Test kitchen.\n\nThe game (slot3) shows:\n")).toBe(true);
    const without = renderView({ world: "slot3", percepts: [{ kind: "gap", salience: 1, facts: {} }], options: [] });
    expect(without.startsWith("The game (slot3) shows:")).toBe(true);
  });
});
