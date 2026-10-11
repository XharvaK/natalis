import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRiver } from "./integrity.js";
import { openRiver, type SqliteRiver } from "./sqlite-river.js";

let tempDir: string;
const opened: SqliteRiver[] = [];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natalis-integrity-"));
});

afterEach(() => {
  for (const river of opened.splice(0)) river.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeRows(file: string, count: number): void {
  const river = openRiver(file, { nowMs: () => 1_700_000_000_000 });
  for (let i = 1; i <= count; i += 1) {
    river.append({ thread: "self", kind: "note", source: "body", text: `Restart note ${i}.` });
  }
  river.close();
}

describe("checkRiver", () => {
  it("is ok when the river holds at least the known count", () => {
    const river = openRiver(":memory:");
    opened.push(river);
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Hello." });
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Hello back." });
    expect(checkRiver(river, { minSeq: 2 })).toEqual({ ok: true });
    expect(checkRiver(river, { minSeq: 0 })).toEqual({ ok: true });
  });

  it("is ok for an empty river that was never known to have rows", () => {
    const river = openRiver(":memory:");
    opened.push(river);
    expect(checkRiver(river, { minSeq: 0 })).toEqual({ ok: true });
  });

  it("refuses a river that came back shorter than it was", () => {
    const river = openRiver(":memory:");
    opened.push(river);
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text: "Hello." });
    const result = checkRiver(river, { minSeq: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("seq 1");
      expect(result.reason).toContain("seq 3");
      expect(result.reason).toContain("Not starting");
    }
  });

  it("refuses a file that silently came back empty after a restart", () => {
    const file = path.join(tempDir, "river.db");
    writeRows(file, 3);
    const reopened = openRiver(file);
    opened.push(reopened);
    expect(checkRiver(reopened, { minSeq: 3 })).toEqual({ ok: true });

    const emptied = path.join(tempDir, "came-back-empty.db");
    const blank = openRiver(emptied);
    opened.push(blank);
    expect(checkRiver(blank, { minSeq: 3 }).ok).toBe(false);
  });

  it("refuses a minSeq that is not a whole number", () => {
    const river = openRiver(":memory:");
    opened.push(river);
    expect(() => checkRiver(river, { minSeq: -1 })).toThrow();
    expect(() => checkRiver(river, { minSeq: 1.5 })).toThrow();
  });
});
