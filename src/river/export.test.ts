import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAll, exportMonth, formatBlock, monthKey } from "./export.js";
import { openRiver, type SqliteRiver } from "./sqlite-river.js";

let tempDir: string;
let river: SqliteRiver;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natalis-export-"));
  clock = Date.UTC(2026, 9, 3, 9, 0, 0);
  river = openRiver(":memory:", { nowMs: () => clock });
});

afterEach(() => {
  river.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** October 2026 and November 2026, with a forgotten row and a tombstone in October. */
function seed(): void {
  river.append({ thread: "dm:owner", kind: "event", source: "owner", actor: "Mira", text: "Hello, Ada." });
  clock = Date.UTC(2026, 9, 3, 9, 5, 0);
  river.append({ thread: "room:lantern", kind: "say", source: "self", text: "The lamp is lit.", data: { calm: true } });
  clock = Date.UTC(2026, 9, 4, 10, 0, 0);
  river.append({
    thread: "dm:owner",
    kind: "event",
    source: "owner",
    actor: "Mira",
    text: "Remember the blue cup.",
    data: { reminder: true },
  });
  clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  river.forget({ seqs: [3] }, "owner", "Owner asked");
  clock = Date.UTC(2026, 10, 1, 0, 0, 0);
  river.append({ thread: "self", kind: "note", source: "body", text: "A new month began." });
}

describe("monthKey", () => {
  it("uses the UTC month", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe("2026-11");
  });
});

describe("formatBlock", () => {
  it("writes the header, the text and compact data", () => {
    const row = river.append({
      thread: "room:lantern",
      kind: "receipt",
      source: "body",
      actor: "Tovan",
      text: "Lamp lit.",
      data: { lamps: 2 },
      atMs: Date.UTC(2026, 9, 3, 9, 0, 0),
    });
    expect(formatBlock(row)).toBe(
      [
        "### 2026-10-03T09:00:00.000Z  room:lantern  receipt  source=body  actor=Tovan  seq=1",
        "Lamp lit.",
        '{"lamps":2}',
      ].join("\n"),
    );
  });
});

describe("exportMonth", () => {
  it("writes one block per row in seq order, with forgotten and tombstone rows", () => {
    seed();
    const file = exportMonth(river, tempDir, 2026, 10);
    expect(file).toBe(path.join(tempDir, "2026-10.md"));
    expect(fs.readFileSync(file, "utf8")).toBe(
      [
        "### 2026-10-03T09:00:00.000Z  dm:owner  event  source=owner  actor=Mira  seq=1",
        "Hello, Ada.",
        "",
        "### 2026-10-03T09:05:00.000Z  room:lantern  say  source=self  actor=-  seq=2",
        "The lamp is lit.",
        '{"calm":true}',
        "",
        "### 2026-10-04T10:00:00.000Z  dm:owner  event  source=owner  actor=Mira  seq=3",
        "(forgotten)",
        "",
        "### 2026-10-05T12:00:00.000Z  body  tombstone  source=owner  actor=-  seq=4",
        "(tombstone: 1 rows, by owner)",
        '{"count":1,"by":"owner","reason":"Owner asked","seqs":[3]}',
        "",
      ].join("\n"),
    );
  });

  it("overwrites the file rather than appending to it", () => {
    seed();
    exportMonth(river, tempDir, 2026, 10);
    const once = fs.readFileSync(path.join(tempDir, "2026-10.md"), "utf8");
    exportMonth(river, tempDir, 2026, 10);
    expect(fs.readFileSync(path.join(tempDir, "2026-10.md"), "utf8")).toBe(once);
  });

  it("writes an empty file for a month with no rows, and refuses bad months", () => {
    seed();
    const file = exportMonth(river, tempDir, 2025, 1);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(() => exportMonth(river, tempDir, 2026, 13)).toThrow();
    expect(() => exportMonth(river, tempDir, 2026, 0)).toThrow();
    expect(() => exportMonth(river, tempDir, 2026.5, 1)).toThrow();
  });
});

describe("exportAll", () => {
  it("writes every month present, oldest first, and nothing for empty months", () => {
    seed();
    const files = exportAll(river, tempDir);
    expect(files.map((f) => path.basename(f))).toEqual(["2026-10.md", "2026-11.md"]);
    expect(fs.readdirSync(tempDir).sort()).toEqual(["2026-10.md", "2026-11.md"]);
    expect(fs.readFileSync(path.join(tempDir, "2026-11.md"), "utf8")).toBe(
      "### 2026-11-01T00:00:00.000Z  self  note  source=body  actor=-  seq=5\nA new month began.\n",
    );
  });

  it("writes nothing for an empty river", () => {
    expect(exportAll(river, tempDir)).toEqual([]);
  });
});
