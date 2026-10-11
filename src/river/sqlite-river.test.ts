import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ftsAvailable, openRiver, RiverError, type SqliteRiver } from "./sqlite-river.js";

let tempDir: string;
let opened: SqliteRiver[] = [];
let clock: number;

const nowMs = (): number => clock;

function open(options: { forceNoFts?: boolean } = {}, file?: string): SqliteRiver {
  const river = openRiver(file ?? ":memory:", { nowMs, ...options });
  opened.push(river);
  return river;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natalis-river-"));
  clock = 1_700_000_000_000;
  opened = [];
});

afterEach(() => {
  for (const river of opened) river.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const modes: Array<{ label: string; forceNoFts: boolean }> = [
  { label: "FTS5 path", forceNoFts: false },
  { label: "LIKE fallback", forceNoFts: true },
];

describe("append", () => {
  it("returns the seq and the time, defaulting to now", () => {
    const river = open();
    const first = river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Hello, Ada." });
    expect(first.seq).toBe(1);
    expect(first.atMs).toBe(clock);
    expect(first.forgotten).toBe(false);

    clock += 5_000;
    const second = river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Hello." });
    expect(second.seq).toBe(2);
    expect(second.atMs).toBe(clock);
    expect(river.lastSeq()).toBe(2);
  });

  it("keeps an explicit time, place, actor and data", () => {
    const river = open();
    const row = river.append({
      thread: "room:lantern",
      kind: "receipt",
      source: "body",
      place: "the reading room",
      actor: "Tovan",
      text: "Lamp lit.",
      data: { lamps: 2, lit: true },
      atMs: 42,
    });
    expect(row).toMatchObject({
      seq: 1,
      atMs: 42,
      thread: "room:lantern",
      kind: "receipt",
      source: "body",
      place: "the reading room",
      actor: "Tovan",
      text: "Lamp lit.",
      data: { lamps: 2, lit: true },
    });
  });

  it("starts an empty river at seq 0", () => {
    expect(open().lastSeq()).toBe(0);
  });

  it("refuses bad input loudly", () => {
    const river = open();
    const bad = [
      { thread: "dm:owner", kind: "gossip", source: "owner" },
      { thread: "dm:owner", kind: "event", source: "stranger" },
      { thread: "  ", kind: "event", source: "owner" },
      { thread: "dm:owner", kind: "tombstone", source: "body" },
      { thread: "dm:owner", kind: "event", source: "owner", atMs: 1.5 },
      { thread: "dm:owner", kind: "event", source: "owner", text: 12 },
      { thread: "dm:owner", kind: "event", source: "owner", data: [1, 2] },
      { thread: "dm:owner", kind: "event", source: "owner", data: { big: 10n } },
    ] as never[];
    for (const input of bad) {
      expect(() => river.append(input)).toThrow(RiverError);
    }
    expect(river.lastSeq()).toBe(0);
  });
});

describe("read", () => {
  function seed(river: SqliteRiver): void {
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "one" });
    river.append({ thread: "room:lantern", kind: "event", source: "outside", actor: "Tovan", text: "two" });
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "three" });
    river.append({ thread: "dm:owner", kind: "turn", source: "body", data: { why: "owner" } });
    river.append({ thread: "room:lantern", kind: "say", source: "self", text: "four" });
  }

  it("reads ascending by seq by default", () => {
    const river = open();
    seed(river);
    expect(river.read({}).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads newest first when asked", () => {
    const river = open();
    seed(river);
    expect(river.read({ newestFirst: true }).map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);
  });

  it("filters by thread, kinds, seq range and time", () => {
    const river = open();
    seed(river);
    expect(river.read({ thread: "room:lantern" }).map((r) => r.seq)).toEqual([2, 5]);
    expect(river.read({ kinds: ["say", "turn"] }).map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(river.read({ sinceSeq: 2, untilSeq: 4 }).map((r) => r.seq)).toEqual([3, 4]);
    expect(river.read({ thread: "dm:owner", kinds: ["say"], newestFirst: true }).map((r) => r.seq)).toEqual([3]);
    clock += 10_000;
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "late" });
    expect(river.read({ sinceMs: clock }).map((r) => r.seq)).toEqual([6]);
  });

  it("returns at most 200 rows by default and honours limit", () => {
    const river = open();
    for (let i = 0; i < 250; i += 1) {
      river.append({ thread: "self", kind: "note", source: "body", text: `note ${i}` });
    }
    expect(river.read({})).toHaveLength(200);
    expect(river.read({})[0]?.seq).toBe(1);
    expect(river.read({ limit: 3, newestFirst: true }).map((r) => r.seq)).toEqual([250, 249, 248]);
  });

  it("refuses an empty kinds list and a bad limit", () => {
    const river = open();
    expect(() => river.read({ kinds: [] })).toThrow(RiverError);
    expect(() => river.read({ limit: 0 })).toThrow(RiverError);
  });
});

describe.each(modes)("search ($label)", ({ forceNoFts }) => {
  it("reports which search path it uses", () => {
    const river = open({ forceNoFts });
    expect(river.searchMode).toBe(forceNoFts || !ftsAvailable() ? "like" : "fts5");
  });

  it("finds rows by word, case-insensitively, across threads", () => {
    const river = open({ forceNoFts });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Mira brought the blue lantern." });
    river.append({ thread: "room:lantern", kind: "event", source: "outside", text: "Tovan lit the LANTERN." });
    river.append({ thread: "room:lantern", kind: "event", source: "outside", text: "Nobody mentioned the weather." });

    const hits = river.search("lantern");
    expect(hits.map((h) => h.row.seq).sort()).toEqual([1, 2]);
    expect(river.search("LANTERN blue").map((h) => h.row.seq)).toEqual([1]);
    expect(river.search("   ")).toEqual([]);
    expect(river.search("nothingmatchesthis")).toEqual([]);
  });

  it("respects the thread filter and the limit", () => {
    const river = open({ forceNoFts });
    for (let i = 0; i < 25; i += 1) {
      river.append({ thread: "dm:owner", kind: "event", source: "owner", text: `harbor note ${i}` });
    }
    river.append({ thread: "room:lantern", kind: "event", source: "outside", text: "harbor in the room" });

    expect(river.search("harbor")).toHaveLength(20);
    expect(river.search("harbor", { limit: 3 })).toHaveLength(3);
    const room = river.search("harbor", { thread: "room:lantern" });
    expect(room.map((h) => h.row.thread)).toEqual(["room:lantern"]);
  });

  it("never throws on punctuation or quotes", () => {
    const river = open({ forceNoFts });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Don't be late, \"Mira\" (say it!)" });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "100% sure_thing [x] {y} * ^ : -" });

    expect(() => river.search('"')).not.toThrow();
    expect(() => river.search("!!! ??? ***")).not.toThrow();
    expect(river.search("!!! ??? ***")).toEqual([]);
    expect(river.search('"Mira"').map((h) => h.row.seq)).toEqual([1]);
    expect(river.search("don't").map((h) => h.row.seq)).toEqual([1]);
    expect(river.search("OR AND NEAR(")).toEqual([]);
    expect(river.search("100%").map((h) => h.row.seq)).toEqual([2]);
    expect(river.search("sure_thing").map((h) => h.row.seq)).toEqual([2]);
    expect(river.search("[x]").map((h) => h.row.seq)).toEqual([2]);
  });

  it("forgotten rows never match", () => {
    const river = open({ forceNoFts });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "The gate code is in the drawer." });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "The drawer sticks." });
    river.forget({ seqs: [1] }, "owner", "Owner asked");
    expect(river.search("gate").map((h) => h.row.seq)).toEqual([]);
    expect(river.search("drawer").map((h) => h.row.seq)).toEqual([2]);
  });
});

describe("ranking", () => {
  it.runIf(ftsAvailable())("ranks the denser match first (bm25)", () => {
    const river = open();
    river.append({ thread: "self", kind: "note", source: "body", text: "Ferry timetable, once." });
    river.append({ thread: "self", kind: "note", source: "body", text: "ferry ferry ferry, all day ferry." });
    // Unrelated rows keep the word rare, so its weight stays positive.
    for (const text of ["Bread and tea.", "The kettle sang.", "Rain on the roof."]) {
      river.append({ thread: "self", kind: "note", source: "body", text });
    }
    const hits = river.search("ferry");
    expect(hits.map((h) => h.row.seq)).toEqual([2, 1]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it("falls back to newest first without FTS", () => {
    const river = open({ forceNoFts: true });
    river.append({ thread: "self", kind: "note", source: "body", text: "ferry ferry ferry" });
    river.append({ thread: "self", kind: "note", source: "body", text: "ferry once" });
    expect(river.search("ferry").map((h) => h.row.seq)).toEqual([2, 1]);
  });
});

describe.each(modes)("forget ($label)", ({ forceNoFts }) => {
  function seeded(): SqliteRiver {
    const river = open({ forceNoFts });
    river.append({ thread: "dm:owner", kind: "event", source: "owner", actor: "Mira", text: "Mira's phone is 555 0100." });
    river.append({ thread: "room:lantern", kind: "say", source: "self", text: "I will keep the lamp lit." });
    river.append({ thread: "room:lantern", kind: "event", source: "outside", actor: "Tovan", text: "Tovan says hello." });
    river.append({
      thread: "dm:owner",
      kind: "receipt",
      source: "body",
      text: "Saved a note.",
      data: { note: "Mira's birthday is in May." },
    });
    return river;
  }

  it("erases by seq, keeps the row, and appends one owner tombstone", () => {
    const river = seeded();
    clock += 1_000;
    const count = river.forget({ seqs: [1] }, "owner", "Owner asked me to forget it");
    expect(count).toBe(1);
    expect(river.lastSeq()).toBe(5);

    const erased = river.read({ sinceSeq: 0, untilSeq: 1 })[0];
    const tomb = river.read({ kinds: ["tombstone"] })[0];
    expect(erased).toMatchObject({ seq: 1, thread: "dm:owner", kind: "event", actor: "Mira", forgotten: true });
    expect(erased?.text).toBeUndefined();
    expect(erased?.data).toBeUndefined();

    expect(tomb).toMatchObject({
      seq: 5,
      atMs: clock,
      thread: "body",
      kind: "tombstone",
      source: "owner",
      forgotten: false,
      data: { count: 1, by: "owner", reason: "Owner asked me to forget it", seqs: [1] },
    });
    expect(tomb?.text).toBeUndefined();
  });

  it("uses source self for a self-forget", () => {
    const river = seeded();
    river.forget({ seqs: [2] }, "self", "I chose to let it go");
    const tomb = river.read({ kinds: ["tombstone"] })[0];
    expect(tomb?.source).toBe("self");
    expect(tomb?.data).toMatchObject({ by: "self", count: 1 });
  });

  it("erases by text, case-insensitively, including data, and counts the rows", () => {
    const river = seeded();
    const count = river.forget({ text: "MIRA" }, "owner", "Owner asked");
    expect(count).toBe(2);
    const rows = river.read({ thread: "dm:owner" });
    expect(rows.map((r) => r.seq)).toEqual([1, 4]);
    expect(rows.map((r) => r.forgotten)).toEqual([true, true]);
    expect(river.read({ thread: "room:lantern" }).map((r) => r.forgotten)).toEqual([false, false]);
    const tomb = river.read({ kinds: ["tombstone"] })[0];
    expect(tomb?.data).toMatchObject({ count: 2, seqs: [1, 4] });
  });

  it("does not put the forgotten text into the tombstone", () => {
    const river = seeded();
    river.forget({ text: "555 0100" }, "owner", "Owner asked");
    const tomb = river.read({ kinds: ["tombstone"] })[0];
    expect(JSON.stringify(tomb)).not.toContain("555 0100");
  });

  it("does not count rows that are already forgotten, and writes no tombstone when nothing was erased", () => {
    const river = seeded();
    expect(river.forget({ seqs: [1] }, "owner", "first")).toBe(1);
    expect(river.forget({ seqs: [1] }, "owner", "again")).toBe(0);
    expect(river.forget({ text: "no such words" }, "self", "nothing here")).toBe(0);
    expect(river.read({ kinds: ["tombstone"] })).toHaveLength(1);
  });

  it("refuses to forget a tombstone, and changes nothing when it does", () => {
    const river = seeded();
    river.forget({ seqs: [1] }, "owner", "first");
    const tombSeq = river.read({ kinds: ["tombstone"] })[0]?.seq ?? -1;
    const before = river.lastSeq();
    expect(() => river.forget({ seqs: [2, tombSeq] }, "owner", "try")).toThrow(RiverError);
    expect(river.lastSeq()).toBe(before);
    expect(river.read({ sinceSeq: 1, untilSeq: 2 })[0]?.text).toBe("I will keep the lamp lit.");
  });

  it("refuses an empty match, a blank reason, or an unknown owner", () => {
    const river = seeded();
    expect(() => river.forget({}, "owner", "x")).toThrow(RiverError);
    expect(() => river.forget({ text: "   " }, "owner", "x")).toThrow(RiverError);
    expect(() => river.forget({ seqs: [1] }, "owner", "  ")).toThrow(RiverError);
    expect(() => river.forget({ seqs: [1] }, "robot" as "owner", "x")).toThrow(RiverError);
    expect(river.read({ kinds: ["tombstone"] })).toHaveLength(0);
  });
});

describe("forget and search", () => {
  it("does not let a tombstone's reason pull rows back into a text match", () => {
    const river = openRiver(":memory:", { nowMs });
    opened.push(river);
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Tovan's address." });
    river.forget({ text: "Tovan" }, "owner", "Tovan's address, asked by Owner");
    expect(river.forget({ text: "Tovan" }, "owner", "again")).toBe(0);
    expect(river.search("Tovan")).toEqual([]);
  });
});

describe("file-backed river", () => {
  it("keeps rows, forgotten state and seqs across a reopen", () => {
    const file = path.join(tempDir, "river.db");
    const first = openRiver(file, { nowMs });
    first.append({ thread: "room:lantern", kind: "event", source: "outside", actor: "Tovan", text: "The lamp flickered." });
    first.append({ thread: "room:lantern", kind: "say", source: "self", text: "I will check the wick.", data: { calm: true } });
    first.forget({ seqs: [1] }, "owner", "Owner asked");
    first.close();

    const second = open({}, file);
    expect(second.lastSeq()).toBe(3);
    const rows = second.read({});
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ forgotten: true, actor: "Tovan" });
    expect(rows[0]?.text).toBeUndefined();
    expect(rows[1]).toMatchObject({ text: "I will check the wick.", data: { calm: true }, forgotten: false });
    expect(second.search("wick").map((h) => h.row.seq)).toEqual([2]);
    expect(second.search("flickered")).toEqual([]);

    const next = second.append({ thread: "self", kind: "note", source: "body", text: "Restarted." });
    expect(next.seq).toBe(4);
  });

  it("writes schema version 1 and WAL mode, and refuses another schema version", () => {
    const file = path.join(tempDir, "river.db");
    open({}, file).close();
    opened = [];

    const raw = new DatabaseSync(file);
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    expect((raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    raw.exec("PRAGMA user_version = 7");
    raw.close();

    expect(() => openRiver(file, { nowMs })).toThrow(RiverError);
  });

  it.runIf(ftsAvailable())("rebuilds the search index for a file that has none, and never re-indexes forgotten text", () => {
    const file = path.join(tempDir, "legacy.db");
    const first = openRiver(file, { nowMs });
    first.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Ferry at dawn." });
    first.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Ferry was cancelled." });
    first.forget({ seqs: [2] }, "owner", "Owner asked");
    first.close();

    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE river_fts");
    raw.close();

    const second = open({}, file);
    expect(second.searchMode).toBe("fts5");
    expect(second.search("ferry").map((h) => h.row.seq)).toEqual([1]);
    expect(second.search("cancelled")).toEqual([]);
  });

  it("refuses to use a closed river", () => {
    const river = openRiver(":memory:", { nowMs });
    river.close();
    expect(() => river.lastSeq()).toThrow(RiverError);
    expect(() => river.append({ thread: "self", kind: "note", source: "body" })).toThrow(RiverError);
  });
});
