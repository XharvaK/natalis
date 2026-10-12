import { describe, expect, it } from "vitest";
import { bodyLines } from "./body.js";
import { wakesFor } from "./attention.js";
import { perceptSentence, renderView } from "./options.js";
import type { Percept } from "./wire.js";

const percept = (kind: string, facts: Record<string, unknown>): Percept => ({ kind, salience: 0.5, facts });

function portraitWith(job: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { self: { funds: 1200, jobs: [{ title: "Test Clerk", job: "Test Office", level: 2, ...job }] }, ...extra };
}

describe("the job line at work", () => {
  it("says when the shift ends, in the game's clock, and falls back to now when it does not say", () => {
    expect(bodyLines(portraitWith({ at_work: true, until_min: 17 * 60 + 5 }))).toContain("Job: Test Clerk (Test Office), level 2; at work until 17:05.");
    expect(bodyLines(portraitWith({ at_work: true }))).toContain("Job: Test Clerk (Test Office), level 2; at work now.");
    expect(bodyLines(portraitWith({ at_work: false, until_min: 600 }))).toContain("Job: Test Clerk (Test Office), level 2.");
  });

  it("places the count line right after the money line", () => {
    const view = renderView({
      world: "slot3", percepts: [], options: [], portrait: portraitWith({}), counts: "You know 2 people: game_list shows them.",
    });
    const lines = view.split("\n");
    expect(lines.indexOf("You know 2 people: game_list shows them.")).toBe(lines.indexOf("Money: §1,200.") + 1);
  });
});

describe("a visitor and a message", () => {
  it("says a visitor is waiting at her door, and a text or a call by the name of the sender", () => {
    const body = bodyLines({ company: [{ id: "7", name: "Test Visitor", waiting: true, distance_m: 3, heard: false }] });
    expect(body.join("\n")).toContain("With you: Test Visitor (3 m away, waiting at your door).");
    expect(perceptSentence(percept("phone", { kind: "text", from: "Test Friend" }))).toBe("Test Friend texted you.");
    expect(perceptSentence(percept("phone", { kind: "call", from: "Test Friend" }))).toBe("Test Friend is calling you.");
    expect(perceptSentence(percept("phone", { kind: "call" }))).toBeUndefined();
  });
});

describe("quiet at work", () => {
  const distress = [percept("need", { subject: "Test Need", band: "distress" })];

  it("does not wake her for a need in distress while a job is at work, and still does when not at work", () => {
    expect(wakesFor("when_called", { percepts: distress, portrait: portraitWith({ at_work: true }), dayRecord: false, firstAfterAttach: false })).toBe(false);
    expect(wakesFor("when_called", { percepts: distress, portrait: portraitWith({ at_work: false }), dayRecord: false, firstAfterAttach: false })).toBe(true);
    expect(wakesFor("when_called", { percepts: distress, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(true);
  });

  it("wakes her in when_called for a text or a call, as for being addressed", () => {
    const phone = [percept("phone", { kind: "text", from: "Test Friend" })];
    expect(wakesFor("when_called", { percepts: phone, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(true);
    expect(wakesFor("quiet", { percepts: phone, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(false);
  });
});
