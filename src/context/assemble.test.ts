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

describe("Q19: whole items, then pointers", () => {
  type ItemizedSection = ContextSection & {
    items: {
      items: readonly string[];
      keys: readonly string[];
      pointer: (keys: readonly string[]) => string;
      lead?: string;
      sep?: string;
    };
  };

  const recallPointer = (keys: readonly string[]): string =>
    `${keys.length} more recall matches: seqs ${keys.join(", ")} (recall with seqs opens them)`;

  function withItems(
    name: string,
    items: string[],
    keys: string[],
    pointer: (keys: readonly string[]) => string,
    extra: { priority?: number; lead?: string; sep?: string } = {},
  ): ItemizedSection {
    const parts = [...(extra.lead === undefined ? [] : [extra.lead]), ...items];
    return {
      name,
      text: parts.join(extra.sep ?? "\n"),
      priority: extra.priority ?? 10,
      items: {
        items,
        keys,
        pointer,
        ...(extra.lead === undefined ? {} : { lead: extra.lead }),
        ...(extra.sep === undefined ? {} : { sep: extra.sep }),
      },
    };
  }

  it("fills an oversize section with its top items whole and names the rest by pointer", () => {
    const items = ["alpha", "beta", "gamma", "delta"].map((word) => `${word} ${"x".repeat(100)}`);
    const section = withItems("recall", items, ["11", "12", "13", "14"], recallPointer);
    const pointer = recallPointer(["13", "14"]);
    const partial = `## recall\n${items[0]}\n${items[1]}\n${pointer}`;

    const out = assembleSystem([section], partial.length, exact);

    expect(out.dropped).toEqual([]);
    expect(out.shown).toEqual([{ name: "recall", text: partial }]);
    expect(out.text).toContain(items[0]);
    expect(out.text).toContain(items[1]);
    expect(out.text).not.toContain(items[2]);
    expect(out.text).not.toContain(items[3]);
    expect(out.text).toContain(pointer);
    expect(out.text.endsWith(pointer)).toBe(true);
  });

  it("shows an item bigger than the room only as a pointer, never cut", () => {
    const big = "z".repeat(500);
    const section = withItems("recall", [big], ["42"], recallPointer);
    const pointer = recallPointer(["42"]);

    const out = assembleSystem([section], `## recall\n${pointer}`.length, exact);

    expect(out.dropped).toEqual([]);
    expect(out.text).toBe(`## recall\n${pointer}`);
    expect(out.text).not.toContain(big);
  });

  it("keeps one budget over the optional sections, in their fixed priority order", () => {
    const items = ["a", "b", "c", "d"].map((word) => `${word} ${"x".repeat(100)}`);
    const recall = withItems("recall", items, ["1", "2", "3", "4"], recallPointer, { priority: 20 });
    const index: ContextSection = { name: "index", text: "i".repeat(300), priority: 10 };
    const pointer = recallPointer(["3", "4"]);
    const partial = `## recall\n${items[0]}\n${items[1]}\n${pointer}`;

    const out = assembleSystem([recall, index], partial.length + 50, exact);

    expect(out.text).toContain(items[0]);
    expect(out.text).toContain(items[1]);
    expect(out.text).toContain(pointer);
    expect(out.dropped).toEqual(["index"]);
    expect(out.text).toContain("(Not shown this turn for space: index.)");
  });

  it("keeps a lead line before the items and the pointer, and counts only the omitted items", () => {
    const items = [`first block ${"a".repeat(100)}`, `second block ${"b".repeat(100)}`];
    const section = withItems("triggered notes", items, ["notes/a.md", "notes/b.md"], (keys) => `${keys.length} left: ${keys.join(", ")}`, {
      lead: "Notes of yours whose words came up:",
      sep: "\n\n",
    });

    const whole = assembleSystem([section], 100_000, exact);
    expect(whole.text).toBe(`## triggered notes\nNotes of yours whose words came up:\n\n${items[0]}\n\n${items[1]}`);
    expect(whole.shown).toEqual([{ name: "triggered notes", text: whole.text }]);
    expect(whole.dropped).toEqual([]);

    const pointer = "1 left: notes/b.md";
    const partial = `## triggered notes\nNotes of yours whose words came up:\n\n${items[0]}\n\n${pointer}`;
    const cut = assembleSystem([section], partial.length, exact);
    expect(cut.text).toBe(partial);
    expect(cut.dropped).toEqual([]);
  });
});
