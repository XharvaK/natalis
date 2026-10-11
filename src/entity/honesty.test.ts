import { describe, expect, it } from "vitest";
import { HONESTY_SYSTEM, parseHonestyReply } from "./honesty.js";

describe("the honesty reply", () => {
  it("reads a plain no", () => {
    expect(parseHonestyReply(JSON.stringify({ contradicts: false, claim: "", record: "" }))).toEqual({ contradicts: false });
  });

  it("reads a yes with the claim and the record", () => {
    const reply = JSON.stringify({ contradicts: true, claim: "I work at the lighthouse", record: "I work at the bakery" });
    expect(parseHonestyReply(reply)).toEqual({
      contradicts: true,
      claim: "I work at the lighthouse",
      record: "I work at the bakery",
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
    expect(parseHonestyReply(JSON.stringify({ claim: "x" }))).toEqual({ error: "the reply had no contradicts flag" });
    expect(parseHonestyReply(JSON.stringify({ contradicts: "yes" }))).toEqual({ error: "the reply had no contradicts flag" });
  });

  it("refuses a yes that leaves out the claim or the record, rather than guessing", () => {
    expect(parseHonestyReply(JSON.stringify({ contradicts: true, claim: "I work", record: "" }))).toEqual({
      error: "the reply left out the claim or the record",
    });
    expect(parseHonestyReply(JSON.stringify({ contradicts: true, record: "x" }))).toEqual({
      error: "the reply left out the claim or the record",
    });
  });

  it("keeps the claim and the record to one short line", () => {
    const long = "word ".repeat(200);
    const verdict = parseHonestyReply(JSON.stringify({ contradicts: true, claim: long, record: "a\nb" }));
    expect(verdict).toMatchObject({ contradicts: true, record: "a b" });
    expect((verdict as { claim: string }).claim.length).toBeLessThanOrEqual(300);
  });

  it("asks for JSON only, and says the check is about the speaker's own life", () => {
    expect(HONESTY_SYSTEM).toContain("OWN life");
    expect(HONESTY_SYSTEM).toContain("JSON only");
  });
});
