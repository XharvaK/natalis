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

  it("with --cache, summarises the call ledger per kind of thread: hits, expected hits, forgets, breaks and part sizes", async () => {
    const calls = openLedger(join(dir, "river.db"));
    const base = { atMs: Date.now(), threadKind: "summoner" as const, turnCall: 1, model: "openai-compatible:test-model", marks: 3 };
    calls.appendCall({ ...base, promptChars: 1000, stableChars: 800, promptTokens: 250, cacheHitTokens: 200, breakPart: "new", breakClass: "turn", partSizes: { who: 200, new: 800 } });
    calls.appendCall({ ...base, promptChars: 1000, stableChars: 900, promptTokens: 100, cacheHitTokens: 10, partSizes: { who: 300, new: 700 } });
    calls.appendCall({ ...base, threadKind: "game", promptChars: 100, stableChars: 100, promptTokens: 10, cacheHitTokens: 10, partSizes: { who: 100 } });
    calls.close();

    const code = await ledgerCommand([dir, "--cache", "--days", "7"], (line) => out.push(line), (line) => err.push(line));

    expect(code).toBe(0);
    expect(out[0]).toBe("Cache, last 7 day(s): 3 model call(s).");
    expect(out).toContain("game: 1 call(s). Cache hit 100%, expected 100% (from 1 measured call(s)). Provider forgot 0. Marks sent 3.");
    expect(out).toContain("summoner: 2 call(s). Cache hit 60%, expected 83% (from 2 measured call(s)). Provider forgot 1. Marks sent 6.");
    expect(out).toContain("  Parts that broke the cache, by count: new 1.");
    expect(out).toContain("  Mean characters per part: new 750, who 250.");
    expect(out.join("\n")).not.toMatch(/secret|hello/i);
    expect(err).toEqual([]);
  });

  it("with --cache and no calls in the window, says so", async () => {
    const code = await ledgerCommand([dir, "--cache"], (line) => out.push(line), (line) => err.push(line));

    expect(code).toBe(0);
    expect(out).toEqual(["Cache, last 1 day(s): 0 model call(s).", "No model calls are recorded in this window."]);
  });
});
