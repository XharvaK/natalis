// Social talk in plain words: the body block and the percept sentences show what a Sim is saying or doing, in a
// sentence, from the helper's dictionary sentences. Invented sentences only.
import { describe, expect, it } from "vitest";
import { bodyLines } from "./body.js";
import { perceptSentence, renderView } from "./options.js";

function block(portrait: Record<string, unknown>): string[] {
  return bodyLines(portrait);
}

describe("talk to her, in the body block", () => {
  it("says the sentence the helper sent, after 'Talking to you:', with a full stop when it has none", () => {
    const lines = block({
      addressed_by: [
        { by: "101", interaction: "invented_ask", sentence: "Mara Quill is asking you about your day." },
        { by: "102", interaction: "invented_wave", sentence: "Pim Dorrow waves at you" },
      ],
    });
    expect(lines).toContain("Talking to you: Mara Quill is asking you about your day.");
    expect(lines).toContain("Talking to you: Pim Dorrow waves at you.");
  });

  it("keeps the current form when there is no sentence", () => {
    const lines = block({
      company: [{ id: "101", name: "Mara Quill", distance_m: "2" }],
      addressed_by: [{ by: "101", interaction: "<class 'sims4.tuning.instances.social_chat'>" }, { by: "999", interaction: "greet" }],
    });
    expect(lines).toContain("Talking to you: Mara Quill (social chat).");
    expect(lines).toContain("Talking to you: someone (greet).");
  });
});

describe("the people she can see, with what each is saying or doing", () => {
  it("says a Sim's sentence in her clause, with the distance, one clause per person", () => {
    const lines = block({
      company: [
        { id: "101", name: "Mara Quill", distance_m: "2", doing: "<class 'x.invented_joke'>",
          said: "Mara Quill is telling Pim Dorrow a joke." },
        { id: "102", name: "Pim Dorrow", distance_m: "3", doing: "sim-stand" },
      ],
    });
    expect(lines).toContain("With you: Mara Quill (2 m away: Mara Quill is telling Pim Dorrow a joke); Pim Dorrow (3 m away, sim stand).");
  });

  it("keeps the plain form for a Sim with no sentence, and a sentence keeps its own words", () => {
    const lines = block({
      company: [{ id: "101", name: "Mara Quill", distance_m: "49.2", doing: "<class 'sims4.tuning.instances.sim-stand'>" }],
    });
    expect(lines).toContain("With you: Mara Quill (49 m away, sim stand).");
    const alone = block({ company: [{ id: "102", name: "Pim Dorrow", said: "Pim Dorrow waves at someone!" }] });
    expect(alone).toContain("With you: Pim Dorrow (Pim Dorrow waves at someone).");
  });
});

describe("what she is doing and what is queued, in sentences where the helper has them", () => {
  it("shows the sentence in place of the name for a running act with a sentence of the same name", () => {
    const lines = block({
      running: ["Read Book"],
      doing_said: [{ interaction: "invented_read", name: "Read Book", sentence: "Ada reads a book.", state: "running" }],
    });
    expect(lines).toContain("Doing: Ada reads a book.");
  });

  it("keeps the name for a running act with no sentence, beside one that has one", () => {
    const lines = block({
      running: ["mirror gussy up", "Read Book"],
      doing_said: [{ interaction: "invented_read", name: "Read Book", sentence: "Ada reads a book.", state: "running" }],
    });
    expect(lines).toContain("Doing: mirror gussy up, Ada reads a book.");
  });

  it("shows the sentence for a queued act, and never a queued sentence for a running act of the same name", () => {
    const queued = block({
      queued: ["Cook"],
      doing_said: [{ interaction: "invented_cook", name: "Cook", sentence: "Ada cooks a meal.", state: "queued" }],
    });
    expect(queued).toContain("Queued: Ada cooks a meal.");
    const mismatch = block({
      running: ["Cook"],
      doing_said: [{ interaction: "invented_cook", name: "Cook", sentence: "Ada cooks a meal.", state: "queued" }],
    });
    expect(mismatch).toContain("Doing: cook.");
  });
});

describe("a social percept, as a sentence", () => {
  it("says the helper's sentence, with a full stop when it has none", () => {
    expect(perceptSentence({ kind: "social", salience: 1, facts: {
      by: "Mara Quill", interaction: "invented_ask", sentence: "Mara Quill is asking you about your day" } }))
      .toBe("Mara Quill is asking you about your day.");
    expect(perceptSentence({ kind: "social", salience: 1, facts: {
      by: "Mara Quill", sentence: "Mara Quill is asking you about your day." } }))
      .toBe("Mara Quill is asking you about your day.");
  });

  it("says who is talking to her and the act in plain words when there is no sentence", () => {
    expect(perceptSentence({ kind: "social", salience: 1, facts: {
      by: "Mara Quill", interaction: "<class 'sims4.tuning.instances.social_chat'>" } }))
      .toBe("Mara Quill is talking to you (social chat).");
    expect(perceptSentence({ kind: "social", salience: 1, facts: { by: "Mara Quill" } }))
      .toBe("Mara Quill is talking to you.");
    expect(perceptSentence({ kind: "social", salience: 1, facts: { by: "someone" } }))
      .toBe("Someone is talking to you.");
  });

  it("says Someone when the speaker is not named, and never shows a number id", () => {
    expect(perceptSentence({ kind: "social", salience: 1, facts: { bucket: "addressed" } }))
      .toBe("Someone is talking to you.");
    expect(perceptSentence({ kind: "social", salience: 1, facts: { by: "4471", interaction: "invented_ask" } }))
      .toBe("Someone is talking to you (invented ask).");
  });

  it("renders a social percept whose facts are only raw ids without any id in the view", () => {
    const text = renderView({
      world: "slot3", options: [],
      percepts: [{ kind: "social", salience: 1, facts: { subject: "4471", object: "9123", bucket: "addressed" } }],
    });
    expect(text).toContain("Someone is talking to you.");
    expect(text).not.toMatch(/4471|9123/);
  });
});
