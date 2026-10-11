import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliasStore, slugify } from "./aliases.js";

const OWNER_ID = "5".repeat(18);
const MARA_ID = "6".repeat(18);
const OTHER_ID = "7".repeat(18);
const GENERAL_ID = "8".repeat(18);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-aliases-"));
  path = join(dir, "aliases.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("makes lowercase hyphenated slugs and keeps letters from other scripts", () => {
    expect(slugify("Mara Kaya", "person")).toBe("mara-kaya");
    expect(slugify("Ğül Ünsal", "person")).toBe("gul-unsal");
    expect(slugify("  !!  ", "person")).toBe("person");
    expect(slugify("x".repeat(60), "person")).toHaveLength(32);
  });
});

describe("createAliasStore", () => {
  it("names the owner 'owner' and never gives a guest that name", () => {
    const store = createAliasStore({ path, ownerUserId: OWNER_ID });
    expect(store.userAlias(OWNER_ID, "Whatever Name")).toBe("owner");
    expect(store.userAlias(MARA_ID, "Owner")).toBe("owner-2");
    expect(store.userAlias(OTHER_ID, "You")).toBe("you-2");
    expect(store.userIdForAlias("owner")).toBe(OWNER_ID);
  });

  it("makes guest aliases unique and stable for the same person", () => {
    const store = createAliasStore({ path, ownerUserId: OWNER_ID });
    expect(store.userAlias(MARA_ID, "Mara")).toBe("mara");
    expect(store.userAlias(OTHER_ID, "Mara")).toBe("mara-2");
    expect(store.userAlias(MARA_ID, "Mara Renamed")).toBe("mara");
    expect(store.knownUserAlias(OTHER_ID)).toBe("mara-2");
    expect(store.knownUserAlias("9".repeat(18))).toBeNull();
    expect(store.userIdForAlias("mara-2")).toBe(OTHER_ID);
    expect(store.userIdForAlias("nobody")).toBeNull();
  });

  it("gives rooms a slug of the channel name, unique across channels", () => {
    const store = createAliasStore({ path, ownerUserId: OWNER_ID });
    expect(store.roomAlias(GENERAL_ID, "General")).toBe("general");
    expect(store.roomAlias("1".repeat(18), "general")).toBe("general-2");
    expect(store.roomAlias(GENERAL_ID, "renamed")).toBe("general");
    expect(store.channelIdForRoom("general")).toBe(GENERAL_ID);
    expect(store.channelIdForRoom("general-2")).toBe("1".repeat(18));
    expect(store.channelIdForRoom("missing")).toBeNull();
  });

  it("keeps every alias across restarts and stays unique after them", () => {
    const first = createAliasStore({ path, ownerUserId: OWNER_ID });
    expect(first.userAlias(MARA_ID, "Mara")).toBe("mara");
    expect(first.userAlias(OTHER_ID, "Mara")).toBe("mara-2");
    expect(first.roomAlias(GENERAL_ID, "general")).toBe("general");

    const second = createAliasStore({ path, ownerUserId: OWNER_ID });
    expect(second.userAlias(MARA_ID, "Mara")).toBe("mara");
    expect(second.userAlias(OTHER_ID, "Mara")).toBe("mara-2");
    expect(second.channelIdForRoom("general")).toBe(GENERAL_ID);
    expect(second.userAlias("9".repeat(18), "Mara")).toBe("mara-3");
    expect(second.userIdForAlias("mara-3")).toBe("9".repeat(18));
  });

  it("writes the file atomically and leaves no temp files behind", () => {
    const store = createAliasStore({ path, ownerUserId: OWNER_ID });
    store.userAlias(MARA_ID, "Mara");
    store.roomAlias(GENERAL_ID, "general");
    expect(readdirSync(dir)).toEqual(["aliases.json"]);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { users: Record<string, string>; rooms: Record<string, string> };
    expect(saved.users[MARA_ID]).toBe("mara");
    expect(saved.rooms[GENERAL_ID]).toBe("general");
  });

  it("stops on a damaged file rather than resetting every alias", () => {
    writeFileSync(path, "{ not json", "utf8");
    expect(() => createAliasStore({ path, ownerUserId: OWNER_ID })).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("refuses a file with the wrong shape", () => {
    writeFileSync(path, JSON.stringify({ users: ["mara"], rooms: {} }), "utf8");
    expect(() => createAliasStore({ path, ownerUserId: OWNER_ID })).toThrow(/unexpected shape/);
  });
});
