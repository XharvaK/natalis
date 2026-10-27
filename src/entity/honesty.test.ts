import { describe, expect, it } from "vitest";
import {
  capQuote,
  checkHonestyQuotes,
  HONESTY_SYSTEM,
  headingAbove,
  parseHonestyReply,
  QUOTE_MAX_CHARS,
} from "./honesty.js";

describe("the honesty reply", () => {
  it("reads a plain no", () => {
    expect(parseHonestyReply(JSON.stringify({ contradicts: false, claim_quote: "", record_quote: "" }))).toEqual({
      contradicts: false,
    });
  });

  it("reads a yes with the claim quote and the record quote", () => {
    const reply = JSON.stringify({
      contradicts: true,
      claim_quote: "I work at the lighthouse",
      record_quote: "I work at the bakery",
    });
    expect(parseHonestyReply(reply)).toEqual({
      contradicts: true,
      claim_quote: "I work at the lighthouse",
      record_quote: "I work at the bakery",
    });
  });

  it("accepts a reply wrapped in a code fence", () => {
    const fenced = "```json\n" + JSON.stringify({ contradicts: false }) + "\n```";
    expect(parseHonestyReply(fenced)).toEqual({ contradicts: false });
  });

  it("names the problem when the reply is empty, not JSON, or not an object", () => {
    expect(parseHonestyReply(null)).toEqual({ error: "the reply was empty" });
    expect(parseHonestyReply("   ")).toEqual({ error: "the reply was empty" });
    expect(parseHonestyReply("maybe")).toEqual({ error: "the reply was not JSON" });
    expect(parseHonestyReply("[true]")).toEqual({ error: "the reply was not an object" });
  });

  it("names the problem when the flag is missing or not a yes or no", () => {
    expect(parseHonestyReply(JSON.stringify({ claim_quote: "x" }))).toEqual({ error: "the reply had no contradicts flag" });
    expect(parseHonestyReply(JSON.stringify({ contradicts: "yes" }))).toEqual({ error: "the reply had no contradicts flag" });
  });

  it("refuses a yes that leaves out the claim quote or the record quote, rather than guessing", () => {
    expect(parseHonestyReply(JSON.stringify({ contradicts: true, claim_quote: "I work", record_quote: "" }))).toEqual({
      error: "the reply left out the claim quote or the record quote",
    });
    expect(parseHonestyReply(JSON.stringify({ contradicts: true, record_quote: "x" }))).toEqual({
      error: "the reply left out the claim quote or the record quote",
    });
    // The old paraphrase fields do not count as quotes.
    expect(parseHonestyReply(JSON.stringify({ contradicts: true, claim: "I work", record: "x" }))).toEqual({
      error: "the reply left out the claim quote or the record quote",
    });
  });

  it("asks for exact quotes copied from the message and the record", () => {
    expect(HONESTY_SYSTEM).toContain("OWN life");
    expect(HONESTY_SYSTEM).toContain("JSON only");
    expect(HONESTY_SYSTEM).toContain("claim_quote");
    expect(HONESTY_SYSTEM).toContain("record_quote");
    expect(HONESTY_SYSTEM).toContain("exact piece");
  });
});

describe("the quotes in a yes", () => {
  it("takes each quote only when it is in its own source, and keeps the source's own spelling", () => {
    const message = "I  work at\nthe lighthouse.";
    const record = "# Work\n\nI  work at the\nbakery on Quay Street.";
    expect(checkHonestyQuotes("I work at the lighthouse", "I work at the bakery on Quay Street", message, record)).toEqual({
      contradicts: true,
      claim_quote: "I  work at\nthe lighthouse",
      record_quote: "I  work at the\nbakery on Quay Street",
    });
  });

  it("folds whitespace runs to one space, and nothing else", () => {
    const message = 'Mara  said "hello"\nat the harbour.';
    const record = "# Work\n\nI  work at the\nbakery.";

    expect(checkHonestyQuotes('Mara said "hello" at the harbour', "I work at the bakery", message, record)).toEqual({
      contradicts: true,
      claim_quote: 'Mara  said "hello"\nat the harbour',
      record_quote: "I  work at the\nbakery",
    });
    // Case is not folded.
    expect(checkHonestyQuotes('mara said "hello" at the harbour', "I work at the bakery", message, record)).toEqual({
      error: "the claim quote was not found in the message",
    });
    // Punctuation is not folded.
    expect(checkHonestyQuotes('Mara said "hello" at the harbour!', "I work at the bakery", message, record)).toEqual({
      error: "the claim quote was not found in the message",
    });
    expect(checkHonestyQuotes('Mara said "hello" at the harbour', "I work at the bakery,", message, record)).toEqual({
      error: "the record quote was not found in the life record",
    });
    // Quote style is not folded.
    expect(checkHonestyQuotes("Mara said “hello” at the harbour", "I work at the bakery", message, record)).toEqual({
      error: "the claim quote was not found in the message",
    });
  });

  it("keeps a long quote whole instead of clipping it, because the receipt shows it verbatim", () => {
    const long = "word ".repeat(200).trim();
    const message = `Before.\n${long}\nAfter.`;
    expect(checkHonestyQuotes(long, "I work at the bakery", message, "I work at the bakery.")).toEqual({
      contradicts: true,
      claim_quote: long,
      record_quote: "I work at the bakery",
    });
  });

  it("names the source that did not hold the quote", () => {
    expect(checkHonestyQuotes("I work at the lighthouse", "I work at the bakery", "I live by the harbour.", "I work at the bakery.")).toEqual({
      error: "the claim quote was not found in the message",
    });
    expect(checkHonestyQuotes("I live by the harbour", "I work at the bakery", "I live by the harbour.", "I live by the sea.")).toEqual({
      error: "the record quote was not found in the life record",
    });
  });

  it("finds the nearest heading above a quote, and reports none when there is no heading", () => {
    const record = "# Life\n\n## Work\n\nI work at the bakery.\n\n### Days\n\nI work on Quay Street.";
    expect(headingAbove(record, "I work at the bakery.")).toBe("## Work");
    expect(headingAbove(record, "I work on Quay Street.")).toBe("### Days");
    expect(headingAbove("I live by the harbour.", "I live by the harbour.")).toBeUndefined();
  });
});

describe("the quote cap in a receipt", () => {
  it("leaves a short quote unchanged", () => {
    expect(capQuote("I work at the bakery on Quay Street")).toBe("I work at the bakery on Quay Street");
  });

  it("keeps a quote of exactly the cap, with no marker", () => {
    const exact = "🐦".repeat(QUOTE_MAX_CHARS);
    expect(capQuote(exact)).toBe(exact);
  });

  it("shows the first 1000 code points and then the marker, counting code points and not UTF-16 units", () => {
    const long = "🐦".repeat(QUOTE_MAX_CHARS + 500);
    const capped = capQuote(long);
    expect(capped).toBe([...long].slice(0, QUOTE_MAX_CHARS).join("") + " […truncated]");
    // A UTF-16 slice would show only about half as many birds.
    expect([...capped.slice(0, -" […truncated]".length)]).toHaveLength(QUOTE_MAX_CHARS);
  });
});
