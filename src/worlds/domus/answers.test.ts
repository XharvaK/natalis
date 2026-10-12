import { describe, expect, it } from "vitest";
import { answerFor, answerRulesOf, isAnswerClaim, type Found, type OptionObject } from "./answers.js";

/** An invented question with two rows, an ok button, a count, and one typed field. */
function question(rules: Record<string, unknown> | null = {
  select: { min: 1, max: 2 },
  counts: { max_in_row: 3, max_rows: 2 },
  text: [{ name: "title", label: "Title", min_length: 1, max_length: 10, numeric: false, min_value: null, max_value: null, profanity_checked: false }],
}): Found {
  const object: OptionObject = {
    object: "The game asks: a test question",
    object_id: "dialog:q1",
    acts: [
      { ref: "a1", guid64: "501", text: "Red" },
      { ref: "a2", guid64: "502", text: "Blue" },
      { ref: "a3", guid64: "ok", text: "OK" },
    ],
    ...(rules === null ? {} : { answer_rules: rules }),
  };
  return { object, act: object.acts[2]! };
}

describe("answer shape", () => {
  it("accepts rows (with optional counts), typed words, or both", () => {
    expect(isAnswerClaim({ rows: [{ option: "a1" }] })).toBe(true);
    expect(isAnswerClaim({ rows: [{ option: "a1", count: 2 }] })).toBe(true);
    expect(isAnswerClaim({ text: { title: "Test" } })).toBe(true);
    expect(isAnswerClaim({ rows: [{ option: "a1" }], text: { title: "Test" } })).toBe(true);
  });

  it("refuses an empty claim, a bad ref, a count out of range, and an unknown key", () => {
    expect(isAnswerClaim({})).toBe(false);
    expect(isAnswerClaim({ rows: [{ option: "a 1" }] })).toBe(false);
    expect(isAnswerClaim({ rows: [{ option: "a1", count: 0 }] })).toBe(false);
    expect(isAnswerClaim({ rows: [{ option: "a1", count: 100 }] })).toBe(false);
    expect(isAnswerClaim({ rows: [{ option: "a1" }], note: "x" })).toBe(false);
    expect(isAnswerClaim({ text: { "bad name!": "x" } })).toBe(false);
  });
});

describe("answer rules", () => {
  it("reads the rules of a question, and treats malformed rules as none", () => {
    expect(answerRulesOf(question().object)).toEqual({
      select: { min: 1, max: 2 },
      counts: { max_in_row: 3, max_rows: 2 },
      text: [expect.objectContaining({ name: "title", max_length: 10 })],
    });
    expect(answerRulesOf(question({ select: { min: "one", max: 2 } }).object)).toBeUndefined();
    expect(answerRulesOf(question(null).object)).toBeUndefined();
  });
});

describe("checking an answer", () => {
  it("stores a valid answer with the game's row ids, the count, and the typed words", () => {
    const result = answerFor(question(), { rows: [{ option: "a1", count: 2 }], text: { title: "Test" } });
    expect(result).toEqual({
      stored: true,
      json: JSON.stringify({ rows: [{ option_id: "501", count: 2 }], text: { title: "Test" } }),
      label: "answered The game asks: a test question: Red x2, title 4 chars",
    });
  });

  it("refuses an answer to something that is not a question, or a question with no rules, or a button that is not ok", () => {
    const notDialog = question();
    notDialog.object.object_id = "obj-kettle";
    expect(answerFor(notDialog, { rows: [{ option: "a1" }] })).toMatchObject({ refused: { code: "not_a_dialog" } });
    expect(answerFor(question(null), { rows: [{ option: "a1" }] })).toMatchObject({ refused: { code: "no_rules" } });
    const red = { object: question().object, act: question().object.acts[0]! };
    expect(answerFor(red, { rows: [{ option: "a2" }] })).toMatchObject({ refused: { code: "not_ok" } });
  });

  it("refuses too few rows, too many rows, rows not on the question, repeated rows, and counts", () => {
    expect(answerFor(question({ select: { min: 2, max: 2 } }), { rows: [{ option: "a1" }] })).toMatchObject({ refused: { code: "too_few_rows" } });
    const three = question({ select: { min: 1, max: 1 } });
    expect(answerFor(three, { rows: [{ option: "a1" }, { option: "a2" }] })).toMatchObject({ refused: { code: "too_many_rows" } });
    expect(answerFor(question(), { rows: [{ option: "a9" }] })).toMatchObject({ refused: { code: "row_not_in_question" } });
    expect(answerFor(question(), { rows: [{ option: "a1" }, { option: "a1" }] })).toMatchObject({ refused: { code: "row_repeated" } });
    const noCounts = question({ select: { min: 1, max: 2 } });
    expect(answerFor(noCounts, { rows: [{ option: "a1", count: 2 }] })).toMatchObject({ refused: { code: "count_not_allowed" } });
    expect(answerFor(question(), { rows: [{ option: "a1", count: 4 }] })).toMatchObject({ refused: { code: "count_too_high" } });
  });

  it("refuses an unknown field, a missing field, and a value that breaks the field's rules, naming the field", () => {
    expect(answerFor(question(), { rows: [{ option: "a1" }], text: { subtitle: "x" } })).toMatchObject({ refused: { code: "unknown_field" } });
    expect(answerFor(question(), { rows: [{ option: "a1" }] })).toMatchObject({ refused: { code: "text_missing" } });
    const long = answerFor(question(), { rows: [{ option: "a1" }], text: { title: "x".repeat(11) } });
    expect(long).toMatchObject({ refused: { code: "text_too_long" } });
    if ("refused" in long) expect(long.refused.reason).toContain("title");
  });

  it("checks a whole-number field against its bounds", () => {
    const numeric = question({
      text: [{ name: "amount", label: "Amount", min_length: 1, max_length: 6, numeric: true, min_value: 1, max_value: 500, profanity_checked: false }],
    });
    expect(answerFor(numeric, { text: { amount: "12x" } })).toMatchObject({ refused: { code: "text_not_integer" } });
    expect(answerFor(numeric, { text: { amount: "900" } })).toMatchObject({ refused: { code: "text_out_of_range" } });
    expect(answerFor(numeric, { text: { amount: "250" } })).toMatchObject({ stored: true });
  });

  it("keeps a restricted field to plain letters, digits and spaces", () => {
    const restricted = question({
      text: [{ name: "name", label: "Name", min_length: 1, max_length: 20, numeric: false, min_value: null, max_value: null, profanity_checked: false, restricted: true }],
    });
    expect(answerFor(restricted, { text: { name: "Ilse-May" } })).toMatchObject({ refused: { code: "text_restricted" } });
    expect(answerFor(restricted, { text: { name: "Ilse May" } })).toMatchObject({ stored: true });
  });

  it("takes a row whose guid carries a variant as the game's own id, opaque, and refuses a guid of another shape", () => {
    const found = question();
    const withVariant: Found = { object: { ...found.object, acts: [{ ref: "a1", guid64: "501v2", text: "Red" }, found.object.acts[2]!] }, act: found.object.acts[2]! };
    const claim = { rows: [{ option: "a1" }], text: { title: "Test" } };
    expect(answerFor(withVariant, claim)).toMatchObject({ stored: true, json: expect.stringContaining('"option_id":"501v2"') });
    const odd: Found = { object: { ...found.object, acts: [{ ref: "a1", guid64: "red", text: "Red" }, found.object.acts[2]!] }, act: found.object.acts[2]! };
    expect(answerFor(odd, claim)).toMatchObject({ refused: { code: "not_a_row" } });
  });
});
