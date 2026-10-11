import { describe, expect, it } from "vitest";
import { FORGOTTEN_LINE, forgetLines, lineHoldsWords, queryWords } from "./forget.js";

describe("the words of a forget query", () => {
  it("splits on spaces and folds case and compatibility forms", () => {
    expect(queryWords("  Lantern   YARD ")).toEqual(["lantern", "yard"]);
    expect(queryWords("ｔｏｍａｓ")).toEqual(["tomas"]);
    expect(queryWords("   ")).toEqual([]);
  });
});

describe("matching a line", () => {
  it("needs every word, in any order, anywhere on the line", () => {
    expect(lineHoldsWords("Mara lives on Lantern Yard", ["yard", "lantern"])).toBe(true);
    expect(lineHoldsWords("Mara lives on Lantern Quay", ["lantern", "yard"])).toBe(false);
  });

  it("matches nothing when there are no words", () => {
    expect(lineHoldsWords("anything", [])).toBe(false);
  });
});

describe("forgetting lines", () => {
  it("replaces each matching line with the marker and counts them", () => {
    const text = "Mara lives on Lantern Yard\nShe likes tea.\nLantern is near yard\n";
    expect(forgetLines(text, ["lantern", "yard"])).toEqual({
      text: `${FORGOTTEN_LINE}\nShe likes tea.\n${FORGOTTEN_LINE}\n`,
      count: 2,
    });
  });

  it("leaves the text alone when nothing matches, and keeps the line breaks", () => {
    const text = "one\r\ntwo\n\nthree";
    expect(forgetLines(text, ["four"])).toEqual({ text, count: 0 });
  });

  it("does not count a marker that already stands where a line was", () => {
    const text = `${FORGOTTEN_LINE}\nreal text\n`;
    expect(forgetLines(text, ["forgotten"])).toEqual({ text, count: 0 });
  });

  it("changes nothing when there are no words to look for", () => {
    expect(forgetLines("anything", [])).toEqual({ text: "anything", count: 0 });
  });
});
