import { describe, expect, it } from "vitest";
import type { ContextSection } from "../contracts.js";
import { assembleSystem } from "./assemble.js";

const constitution: ContextSection = { name: "constitution", text: "Be plain and kind.", priority: 1000, core: true };
const now: ContextSection = { name: "now", text: "Garden room, Tuesday.", priority: 900, core: true };
const character: ContextSection = { name: "character", text: "Curious about gardens.", priority: 50 };
const index: ContextSection = { name: "index", text: "people/mara.md\npeople/tomas.md", priority: 40 };
const recall: ContextSection = { name: "recall", text: "x".repeat(400), priority: 10 };

// One character per token, no reserve: the window is then exactly the number of characters allowed.
const exact = { reserveTokens: 0, charsPerToken: 1 };

/** Length of the rendered sections joined the way assembleSystem joins them. */
function joinedLength(sections: ContextSection[]): number {
  const rendered = sections.map((s) => `## ${s.name}\n${s.text}`);
  return rendered.reduce((total, r) => total + r.length, 0) + 2 * Math.max(0, rendered.length - 1);
}

describe("assembleSystem", () => {
  it("keeps everything when the window is roomy, in the order given", () => {
    const out = assembleSystem([recall, constitution, character, now], 100_000);

    expect(out.dropped).toEqual([]);
    expect(out.text).toBe(
      [
        `## recall\n${"x".repeat(400)}`,
        "## constitution\nBe plain and kind.",
        "## character\nCurious about gardens.",
        "## now\nGarden room, Tuesday.",
      ].join("\n\n"),
    );
    expect(out.text).not.toContain("Not shown this turn");
  });

  it("always keeps core sections, even when they alone are larger than the window", () => {
    const big: ContextSection = { name: "constitution", text: "y".repeat(2000), priority: 1, core: true };
    const out = assembleSystem([big, character], 1000, exact);

    expect(out.text.startsWith(`## constitution\n${"y".repeat(2000)}`)).toBe(true);
    expect(out.dropped).toEqual(["character"]);
  });

  it("drops the lowest priority first when the window is short", () => {
    const sections = [constitution, now, character, index, recall];
    // Room for the core and the two higher-priority sections, with spare characters for the trailing note.
    const limit = joinedLength([constitution, now, character, index]) + 60;

    const out = assembleSystem(sections, limit, exact);

    expect(out.dropped).toEqual(["recall"]);
    expect(out.text).toContain("## character\nCurious about gardens.");
    expect(out.text).toContain("## index\npeople/mara.md");
    expect(out.text).not.toContain("## recall");
  });

  it("keeps kept sections in their original order, not priority order", () => {
    const low: ContextSection = { name: "low", text: "a", priority: 1 };
    const high: ContextSection = { name: "high", text: "b", priority: 9 };
    const out = assembleSystem([low, constitution, high], 100_000);

    expect(out.text.indexOf("## low")).toBeLessThan(out.text.indexOf("## constitution"));
    expect(out.text.indexOf("## constitution")).toBeLessThan(out.text.indexOf("## high"));
  });

  it("never cuts a section: it is kept whole when it fits exactly, and left out whole when it does not", () => {
    const fits = joinedLength([constitution, recall]);
    const whole = assembleSystem([constitution, recall], fits, exact);
    expect(whole.dropped).toEqual([]);
    expect(whole.text).toContain(`## recall\n${"x".repeat(400)}`);

    const short = assembleSystem([constitution, recall], fits - 1, exact);
    expect(short.dropped).toEqual(["recall"]);
    expect(short.text).not.toContain("xxxx");
    expect(short.text).toContain("## constitution\nBe plain and kind.");
  });

  it("skips a section that does not fit and still keeps a smaller, lower-priority one that does", () => {
    const big: ContextSection = { name: "big", text: "b".repeat(300), priority: 80 };
    const small: ContextSection = { name: "small", text: "s", priority: 10 };
    const limit = joinedLength([constitution, small]) + 60;

    const out = assembleSystem([constitution, big, small], limit, exact);

    expect(out.dropped).toEqual(["big"]);
    expect(out.text).toContain("## small\ns");
  });

  it("names the dropped sections, in their original order, in one final line", () => {
    const out = assembleSystem([constitution, character, recall, index], 44, exact);

    expect(out.dropped).toEqual(["character", "recall", "index"]);
    const lastLine = out.text.split("\n").at(-1);
    expect(lastLine).toBe("(Not shown this turn for space: character, recall, index.)");
    expect(out.text.startsWith("## constitution\nBe plain and kind.")).toBe(true);
  });

  it("keeps the kept sections within the window whenever the core fits; the trailing note is then the only overflow", () => {
    const coreLength = joinedLength([constitution, now]);
    const all = [constitution, now, character, index, recall];
    for (let limit = 1; limit <= 700; limit += 7) {
      const out = assembleSystem(all, limit, exact);
      const note = "\n\n(Not shown this turn for space:";
      const body = out.dropped.length > 0 ? out.text.slice(0, out.text.lastIndexOf(note)) : out.text;
      if (coreLength <= limit) {
        // The sections stay inside the window. The note is only reserved room when it can be fitted in;
        // when even the core leaves no room for it, the note may run over by its own length.
        expect(body.length).toBeLessThanOrEqual(limit);
        if (out.dropped.length === 0) expect(out.text.length).toBeLessThanOrEqual(limit);
      }
      if (out.dropped.length > 0) {
        expect(out.text).toContain("(Not shown this turn for space:");
      }
    }
    expect(assembleSystem(all, 700, exact).dropped).toEqual([]);
  });

  it("reports usedTokens as the estimate of the text it returns", () => {
    const out = assembleSystem([constitution, now], 100_000, { charsPerToken: 3 });

    expect(out.usedTokens).toBe(Math.ceil(out.text.length / 3));
  });

  it("sizes the window with the default reserve of 8000 tokens", () => {
    // 9000 tokens minus the default 8000 reserve leaves 1000 tokens: 4000 characters at 4 characters a token.
    const fits = assembleSystem([constitution, { name: "fat", text: "z".repeat(3900), priority: 5 }], 9000);
    expect(fits.dropped).toEqual([]);

    const notFits = assembleSystem([constitution, { name: "fat", text: "z".repeat(4000), priority: 5 }], 9000);
    expect(notFits.dropped).toEqual(["fat"]);
  });

  it("shows no note when nothing was dropped", () => {
    const out = assembleSystem([constitution, character], 100_000);

    expect(out.dropped).toEqual([]);
    expect(out.text).not.toContain("Not shown");
  });

  it("rejects a window or a character ratio that makes no sense", () => {
    expect(() => assembleSystem([constitution], 0)).toThrow(RangeError);
    expect(() => assembleSystem([constitution], 1000, { charsPerToken: 0 })).toThrow(RangeError);
  });
});
