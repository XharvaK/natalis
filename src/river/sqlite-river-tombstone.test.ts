import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRiver, RiverError, type SqliteRiver } from "./sqlite-river.js";

let tempDir: string;
let opened: SqliteRiver[] = [];

function open(file?: string): SqliteRiver {
  const river = openRiver(file ?? ":memory:", { nowMs: () => 1_700_000_000_000 });
  opened.push(river);
  return river;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natalis-tombstone-"));
  opened = [];
});

afterEach(() => {
  for (const river of opened) river.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("appendTombstone", () => {
  it("writes a tombstone row at the given time, with no text and the given data", () => {
    const river = open();
    const row = river.appendTombstone({
      atMs: 1_600_000_000_000,
      by: "owner",
      data: { reason: "forgotten by the owner (3 rows)", count: 3, imported: true },
    });
    expect(row.seq).toBe(1);
    expect(row.kind).toBe("tombstone");
    expect(row.atMs).toBe(1_600_000_000_000);
    expect(row.source).toBe("owner");
    expect(row.thread).toBe("body");
    expect(row.text).toBeUndefined();
    expect(row.data).toEqual({ reason: "forgotten by the owner (3 rows)", count: 3, imported: true });
    expect(river.lastSeq()).toBe(1);
  });

  it("keeps the source it was given for self and body", () => {
    const river = open();
    expect(river.appendTombstone({ atMs: 1, by: "self", data: { reason: "a" } }).source).toBe("self");
    expect(river.appendTombstone({ atMs: 2, by: "body", data: { reason: "b" } }).source).toBe("body");
  });

  it("is never matched by search and is read back as a tombstone", () => {
    const river = open();
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "the harbour lamp" });
    river.appendTombstone({ atMs: 5, by: "owner", data: { reason: "harbour" } });
    expect(river.search("harbour").map((hit) => hit.row.kind)).toEqual(["event"]);
    const tombstones = river.read({ kinds: ["tombstone"] });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.atMs).toBe(5);
  });

  it("survives a reopen of a file-backed river", () => {
    const file = path.join(tempDir, "river.db");
    const first = open(file);
    first.appendTombstone({ atMs: 9, by: "owner", data: { reason: "kept", count: 1 } });
    first.close();
    opened = [];
    const again = open(file);
    expect(again.lastSeq()).toBe(1);
    expect(again.read({ kinds: ["tombstone"] })[0]?.data).toEqual({ reason: "kept", count: 1 });
  });

  it("refuses a bad time, an unknown owner, or data that is not an object, and writes nothing", () => {
    const river = open();
    expect(() => river.appendTombstone({ atMs: 1.5, by: "owner", data: {} })).toThrow(RiverError);
    expect(() => river.appendTombstone({ atMs: 1, by: "robot" as "owner", data: {} })).toThrow(RiverError);
    expect(() => river.appendTombstone({ atMs: 1, by: "owner", data: [] as unknown as Record<string, unknown> })).toThrow(
      RiverError,
    );
    expect(river.lastSeq()).toBe(0);
  });

  it("still refuses a tombstone through append, so only the importer and forget can write one", () => {
    const river = open();
    expect(() => river.append({ thread: "body", kind: "tombstone", source: "owner" })).toThrow(RiverError);
  });
});
