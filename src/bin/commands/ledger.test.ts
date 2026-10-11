import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../../river/ledger.js";
import { openRiver } from "../../river/index.js";
import { ledgerCommand } from "./ledger.js";

// Every name here is invented.
let root: string;
let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-ledgercmd-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");
  openRiver(join(dir, "river.db")).close();
  const ledger = openLedger(join(dir, "river.db"));
  const now = Date.now();
  ledger.append({
    atMs: now,
    threadKind: "summoner",
    endedBy: "end_turn",
    outcome: "answered",
    model: "openai-compatible:test-model",
    promptTokens: 40,
    completionTokens: 10,
    totalTokens: 50,
    backupUsed: false,
  });
  ledger.append({
    atMs: now,
    threadKind: "room",
    endedBy: "model_error",
    outcome: "failed",
    model: "openai-compatible:test-model",
    backupUsed: true,
    errorKind: "unavailable",
  });
  ledger.close();
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("natalis ledger", () => {
  it("prints counts only, for the days asked", async () => {
    const code = await ledgerCommand([dir, "--days", "7"], (line) => out.push(line), (line) => err.push(line));
    expect(code).toBe(0);
    expect(out[0]).toBe("Ledger, last 7 day(s): 2 turn(s). Answered 1, failed 1, aborted 0.");
    expect(out.join("\n")).toContain("Turns by kind of thread: room 1, summoner 1.");
    expect(out.join("\n")).toContain("Backup answered 1 turn(s).");
    expect(out.join("\n")).toContain("Tokens: 50 in total (prompt 40, completion 10); reported for 1 of 2 turn(s).");
    expect(out.join("\n")).not.toMatch(/secret|hello/i);
    expect(err).toEqual([]);
  });

  it("reads one day when no --days is given", async () => {
    const code = await ledgerCommand([dir], (line) => out.push(line), (line) => err.push(line));
    expect(code).toBe(0);
    expect(out[0]).toBe("Ledger, last 1 day(s): 2 turn(s). Answered 1, failed 1, aborted 0.");
  });

  it("refuses a folder with no river, and days that are not a whole number", async () => {
    expect(await ledgerCommand([join(root, "elsewhere")], (line) => out.push(line), (line) => err.push(line))).toBe(2);
    expect(await ledgerCommand([dir, "--days", "x"], (line) => out.push(line), (line) => err.push(line))).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis ledger");
    expect(out).toEqual([]);
  });
});
