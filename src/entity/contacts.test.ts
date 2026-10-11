import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTACTS_FILE, mentionedUserId, readContacts, writeContacts } from "./contacts.js";

// Every id here is invented.
const MARA = "600001";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-contacts-"));
  file = join(dir, CONTACTS_FILE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the contacts file", () => {
  it("is no contacts when the file was never created, with no problem", () => {
    expect(readContacts(file)).toEqual({ contacts: { version: 1, discord: [] } });
  });

  it("writes whole and survives a reload, with no temporary file left behind", () => {
    writeContacts(file, { version: 1, discord: [MARA] });
    expect(readContacts(file)).toEqual({ contacts: { version: 1, discord: [MARA] } });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, discord: [MARA] });
  });

  it("reads a damaged file as no contacts, and says so in plain words without the file's text", () => {
    writeFileSync(file, `{ "version": 1, "discord": ["${MARA}"`, "utf8");
    const load = readContacts(file);
    expect(load.contacts.discord).toEqual([]);
    expect(load.problem).toMatch(/not valid JSON/);
    expect(load.problem).not.toContain(MARA);
  });

  it("refuses a file with the wrong shape, and names the wrong part", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /must be an object/],
      [{ version: 2, discord: [] }, /version/],
      [{ version: 1, discord: "600001" }, /"discord" must be a list/],
      [{ version: 1, discord: ["mara"] }, /discord\[0\]/],
      [{ version: 1, discord: [MARA, MARA] }, /listed twice/],
      [{ version: 1, discord: [], extra: true }, /unknown field "extra"/],
    ];
    for (const [value, pattern] of cases) {
      writeFileSync(file, JSON.stringify(value), "utf8");
      expect(readContacts(file).problem).toMatch(pattern);
      expect(readContacts(file).contacts.discord).toEqual([]);
    }
  });
});

describe("mentions", () => {
  it("reads a Discord mention, with or without the nickname mark", () => {
    expect(mentionedUserId(`<@${MARA}>`)).toBe(MARA);
    expect(mentionedUserId(`<@!${MARA}>`)).toBe(MARA);
    expect(mentionedUserId(`  <@${MARA}>  `)).toBe(MARA);
  });

  it("reads nothing else as a mention", () => {
    expect(mentionedUserId("mara")).toBeUndefined();
    expect(mentionedUserId(`<@${MARA}> and more`)).toBeUndefined();
    expect(mentionedUserId("<@role>")).toBeUndefined();
  });
});
