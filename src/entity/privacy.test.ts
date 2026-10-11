import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPrivacyWatch,
  EMPTY_PRIVACY_LIST,
  parsePrivacyList,
  privacyCategories,
  privacyHit,
  outwardHold,
  readPrivacyFile,
  type PrivacyList,
} from "./privacy.js";

// Every name here is invented.
const LIST: PrivacyList = {
  terms: [
    { term: "Lantern Yard", category: "home" },
    { term: "Tomas", category: "people" },
    { term: "42 Quay", category: "home" },
  ],
  categories: ["money"],
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-privacy-"));
  file = join(dir, "privacy.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("reading privacy.json", () => {
  it("is an empty list with no problem when the file is missing", () => {
    expect(readPrivacyFile(file)).toEqual({ list: EMPTY_PRIVACY_LIST });
  });

  it("keeps the terms and categories it is given, trimmed", () => {
    writeFileSync(file, JSON.stringify({ terms: [{ term: " Lantern Yard ", category: "home " }], categories: [" money"] }), "utf8");
    expect(readPrivacyFile(file)).toEqual({
      list: { terms: [{ term: "Lantern Yard", category: "home" }], categories: ["money"] },
    });
  });

  it("treats a file that is not JSON as empty and says why", () => {
    writeFileSync(file, "{ not json", "utf8");
    const load = readPrivacyFile(file);
    expect(load.list).toEqual(EMPTY_PRIVACY_LIST);
    expect(load.problem).toMatch(/not valid JSON/);
  });

  it("names the wrong part of a file that has the wrong shape, and counts it as empty", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /must be an object/],
      [{ terms: "Lantern Yard" }, /"terms" must be a list/],
      [{ terms: [{ term: "Lantern Yard" }] }, /terms\[0\].category must be non-empty text/],
      [{ terms: [{ term: "  ", category: "home" }] }, /terms\[0\].term must be non-empty text/],
      [{ terms: [{ term: "x", category: "home", note: "no" }] }, /unknown field "note" in terms\[0\]/],
      [{ categories: [3] }, /categories\[0\] must be non-empty text/],
      [{ rules: [] }, /unknown field "rules"/],
    ];
    for (const [value, pattern] of cases) {
      writeFileSync(file, JSON.stringify(value), "utf8");
      const load = readPrivacyFile(file);
      expect(load.list).toEqual(EMPTY_PRIVACY_LIST);
      expect(load.problem).toMatch(pattern);
    }
  });

  it("parses a checked value directly", () => {
    expect(parsePrivacyList({})).toEqual({ terms: [], categories: [] });
  });
});

describe("matching a say against the list", () => {
  it("matches case-insensitively", () => {
    expect(privacyHit("we went to LANTERN yard", LIST)).toEqual({ term: "Lantern Yard", category: "home" });
  });

  it("matches compatibility forms, such as full-width letters, after NFKC", () => {
    expect(privacyHit("ｔｏｍａｓ said hello", LIST)).toEqual({ term: "Tomas", category: "people" });
  });

  it("matches a whole word, and a word followed by punctuation", () => {
    expect(privacyHit("Tomas, is that you?", LIST)?.term).toBe("Tomas");
    expect(privacyHit("(Tomas)", LIST)?.term).toBe("Tomas");
  });

  it("does not match a word that only starts with a term", () => {
    expect(privacyHit("Tomasz is my cousin", LIST)).toBeUndefined();
  });

  it("does not match a term inside a longer word in another alphabet or with a mark", () => {
    expect(privacyHit("the Tomás family", LIST)).toBeUndefined();
    expect(privacyHit("Tomaś family", LIST)).toBeUndefined();
  });

  it("treats letters from any alphabet as part of a word", () => {
    const turkish: PrivacyList = { terms: [{ term: "ark", category: "x" }], categories: [] };
    expect(privacyHit("the şark road", turkish)).toBeUndefined();
    expect(privacyHit("the ark road", turkish)?.term).toBe("ark");
  });

  it("does not match a number inside a longer number", () => {
    const numbers: PrivacyList = { terms: [{ term: "42", category: "number" }], categories: [] };
    expect(privacyHit("route 1423", numbers)).toBeUndefined();
    expect(privacyHit("route 42.", numbers)?.term).toBe("42");
    expect(privacyHit("route 42 Quay", LIST)?.term).toBe("42 Quay");
  });

  it("matches a phrase with its spaces collapsed", () => {
    expect(privacyHit("by   Lantern\nYard", LIST)?.term).toBe("Lantern Yard");
  });

  it("answers with the first matching term in list order, as the owner wrote it", () => {
    const hit = privacyHit("Tomas lives on Lantern Yard", LIST);
    expect(hit).toEqual({ term: "Lantern Yard", category: "home" });
  });

  it("ignores an empty list and blank terms", () => {
    expect(privacyHit("anything at all", EMPTY_PRIVACY_LIST)).toBeUndefined();
    expect(privacyHit("anything at all", { terms: [{ term: "  ", category: "x" }], categories: [] })).toBeUndefined();
  });

  it("lists categories without the terms: listed first, then any a term names", () => {
    expect(privacyCategories(LIST)).toEqual(["money", "home", "people"]);
    expect(privacyCategories(EMPTY_PRIVACY_LIST)).toEqual([]);
  });
});

describe("the watch on privacy.json", () => {
  it("reads the file the first time, and again when its modification time changes", () => {
    const watch = createPrivacyWatch(file);
    expect(watch.current().list.terms).toEqual([]);

    writeFileSync(file, JSON.stringify({ terms: [{ term: "Tomas", category: "people" }] }), "utf8");
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(watch.current().list.terms).toEqual([{ term: "Tomas", category: "people" }]);

    writeFileSync(file, JSON.stringify({ terms: [] }), "utf8");
    utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    expect(watch.current().list.terms).toEqual([]);
  });

  it("reports a problem with a bad file and clears it when the file is fixed", () => {
    writeFileSync(file, "{ nope", "utf8");
    const watch = createPrivacyWatch(file);
    expect(watch.current().problem).toMatch(/not valid JSON/);

    writeFileSync(file, JSON.stringify({ terms: [] }), "utf8");
    utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(watch.current().problem).toBeUndefined();
  });
});

describe("outwardHold", () => {
  it("holds a text that carries a listed term, and names its category", () => {
    const hold = outwardHold({ list: LIST }, ["https://example.org/?q=fine", "the lantern yard gate"]);
    expect(hold).toEqual({ kind: "term", term: "Lantern Yard", category: "home" });
  });

  it("holds nothing when no text carries a listed term", () => {
    expect(outwardHold({ list: LIST }, ["https://example.org/", "a plain body"])).toBeUndefined();
    expect(outwardHold({ list: EMPTY_PRIVACY_LIST }, ["Tomas"])).toBeUndefined();
  });

  it("holds every outward text while the list cannot be read, and says why", () => {
    const hold = outwardHold({ list: EMPTY_PRIVACY_LIST, problem: "the file is not valid JSON" }, ["a plain body"]);
    expect(hold).toEqual({ kind: "unreadable", problem: "the file is not valid JSON" });
  });

  it("does not say the words of a damaged file in its problem text", () => {
    writeFileSync(file, `{ "terms": [{ "term": "Lantern Yard", "category": "home" }`, "utf8");
    const { problem } = readPrivacyFile(file);
    expect(problem).toMatch(/not valid JSON/);
    expect(problem).not.toContain("Lantern");
  });
});
