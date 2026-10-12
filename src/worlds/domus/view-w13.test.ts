import { describe, expect, it } from "vitest";
import { bodyLines } from "./body.js";
import { createWorkWatch, wakesFor } from "./attention.js";
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

describe("an act that needs a Sim", () => {
  it("is marked in the view, so she knows to name a Sim before she asks", () => {
    const view = renderView({
      world: "slot3", percepts: [], portrait: {}, options: [
        { object: "Test Phone", object_id: "88", acts: [{ ref: "a2", guid64: "902", text: "Call Test Friend", needs_sim: true }] },
        { object: "Test Bed", object_id: "77", acts: [{ ref: "a1", guid64: "901", text: "Sleep" }] },
      ],
    });
    expect(view).toContain("a2 Call Test Friend (needs a Sim: name one with sim)");
    expect(view).toContain("- Test Bed: a1 Sleep");
    expect(view).not.toContain("a1 Sleep (needs");
  });
});

describe("quiet at work", () => {
  const distress = [percept("need", { subject: "Test Need", band: "distress" })];

  it("does not wake her for a need in distress while a job is at work, and still does when not at work", () => {
    expect(wakesFor("when_called", { percepts: distress, portrait: portraitWith({ at_work: true }), dayRecord: false, firstAfterAttach: false })).toBe(false);
    expect(wakesFor("when_called", { percepts: distress, portrait: portraitWith({ at_work: false }), dayRecord: false, firstAfterAttach: false })).toBe(true);
    expect(wakesFor("when_called", { percepts: distress, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(true);
  });

  it("holds a distress at work in every mode, not only when_called and quiet", () => {
    const atWork = portraitWith({ at_work: true });
    const view = (percepts: Percept[], portrait: unknown, workEnded = false) =>
      ({ percepts, portrait, dayRecord: false, firstAfterAttach: false, workEnded });
    expect(wakesFor("every_change", view(distress, atWork))).toBe(false);
    expect(wakesFor("every_change", view(distress, portraitWith({ at_work: false })))).toBe(true);
    expect(wakesFor("every_change", view(distress, undefined))).toBe(true);
    expect(wakesFor("quiet", view(distress, atWork))).toBe(false);
    // A view with some other change still wakes her in every_change: the distress is not the only reason.
    const other = [percept("need", { subject: "Test Need", band: "ok" })];
    expect(wakesFor("every_change", view([...distress, ...other], atWork))).toBe(true);
    expect(wakesFor("every_change", view(other, atWork))).toBe(true);
    expect(wakesFor("every_change", view([], atWork))).toBe(true);
  });

  it("wakes her once when work ends with a need still in distress, in every mode", () => {
    const needsDistress = { needs: { Test_Need: { band: "distress" } } };
    const needsOk = { needs: { Test_Need: { band: "ok" } } };
    const ended = (mode: "every_change" | "when_called" | "quiet", portrait: unknown, percepts: Percept[] = []) =>
      wakesFor(mode, { percepts, portrait: { ...(portrait as object), self: { jobs: [{ at_work: false }] } }, dayRecord: false, firstAfterAttach: false, workEnded: true });
    for (const mode of ["when_called", "quiet"] as const) {
      expect(ended(mode, needsDistress)).toBe(true);
      expect(ended(mode, needsOk)).toBe(false);
    }
    // every_change wakes on every view anyway, so the work end adds nothing there; the distress still wakes her.
    expect(ended("every_change", needsDistress)).toBe(true);
    expect(ended("every_change", needsOk)).toBe(true);
  });

  it("tells a work end apart from a shift that has not ended, once per game thread", () => {
    const watch = createWorkWatch();
    const shift = portraitWith({ at_work: true });
    const free = portraitWith({ at_work: false });
    expect(watch.ended("thread-a", shift)).toBe(false);
    expect(watch.ended("thread-a", shift)).toBe(false);
    expect(watch.ended("thread-a", free)).toBe(true);
    expect(watch.ended("thread-a", free)).toBe(false);
    expect(watch.ended("thread-b", free)).toBe(false);
    // A view with no job read leaves the state as it was.
    expect(watch.ended("thread-c", shift)).toBe(false);
    expect(watch.ended("thread-c", undefined)).toBe(false);
    expect(watch.ended("thread-c", free)).toBe(true);
  });

  it("wakes her in when_called for a text or a call, as for being addressed", () => {
    const phone = [percept("phone", { kind: "text", from: "Test Friend" })];
    expect(wakesFor("when_called", { percepts: phone, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(true);
    expect(wakesFor("quiet", { percepts: phone, portrait: undefined, dayRecord: false, firstAfterAttach: false })).toBe(false);
  });
});
