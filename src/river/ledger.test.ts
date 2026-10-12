import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRiver } from "./sqlite-river.js";
import {
  openLedger,
  readCallLedger,
  readLedger,
  summarizeCallLedger,
  summarizeLedger,
  type CallRow,
  type LedgerRow,
} from "./ledger.js";

// Every name here is invented.
let root: string;
let riverPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-ledger-"));
  riverPath = join(root, "river.db");
  openRiver(riverPath).close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-11T12:00:00Z");

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    atMs: NOW,
    threadKind: "summoner",
    endedBy: "end_turn",
    outcome: "answered",
    model: "openai-compatible:test-model",
    backupUsed: false,
    ...overrides,
  };
}

describe("the ledger", () => {
  it("keeps one row per turn, in the river's own file, with the counts and no words", () => {
    const ledger = openLedger(riverPath);
    ledger.append(row({ promptTokens: 10, completionTokens: 4, totalTokens: 14, cacheHitTokens: 6 }));
    ledger.append(row({ threadKind: "room", outcome: "failed", endedBy: "model_error", errorKind: "unavailable", backupUsed: true }));
    ledger.close();

    const rows = readLedger(riverPath, NOW - DAY);
    expect(rows).toEqual([
      expect.objectContaining({ atMs: NOW, threadKind: "summoner", outcome: "answered", promptTokens: 10, totalTokens: 14, cacheHitTokens: 6 }),
      expect.objectContaining({ threadKind: "room", outcome: "failed", errorKind: "unavailable", backupUsed: true }),
    ]);
    expect(rows[0]).not.toHaveProperty("text");
    expect(rows[1]?.cacheMissTokens).toBeUndefined();
  });

  it("reads only the rows since the time asked for", () => {
    const ledger = openLedger(riverPath);
    ledger.append(row({ atMs: NOW - 3 * DAY }));
    ledger.append(row({ atMs: NOW }));
    ledger.close();
    expect(readLedger(riverPath, NOW - DAY)).toHaveLength(1);
  });

  it("summarizes counts only: turns by kind of thread, outcomes, models, tokens reported, and backup answers", () => {
    const rows: LedgerRow[] = [
      row({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
      row({ threadKind: "contact", outcome: "failed", endedBy: "model_error", backupUsed: true }),
      row({ threadKind: "game", outcome: "aborted", endedBy: "aborted", model: "openai-compatible:other", cacheHitTokens: 50 }),
    ];
    const summary = summarizeLedger(rows);
    expect(summary).toEqual({
      turns: 3,
      answered: 1,
      failed: 1,
      aborted: 1,
      byThreadKind: { summoner: 1, contact: 1, game: 1 },
      byModel: { "openai-compatible:test-model": 2, "openai-compatible:other": 1 },
      backupAnswered: 1,
      tokens: { prompt: 100, completion: 20, total: 120, reportedFor: 1 },
      cacheHitTokens: { total: 50, reportedFor: 1 },
    });
  });
});

function call(overrides: Partial<CallRow> = {}): CallRow {
  return {
    atMs: NOW,
    threadKind: "summoner",
    turnCall: 1,
    model: "openai-compatible:test-model",
    promptChars: 1000,
    stableChars: 800,
    marks: 3,
    partSizes: { who: 200, recent: 600, new: 200 },
    ...overrides,
  };
}

describe("the call ledger", () => {
  it("keeps one row per model call, in the river's own file, and reads it back as it was written", () => {
    const ledger = openLedger(riverPath);
    ledger.appendCall(call({ breakPart: "new", breakClass: "turn", idleMs: 5_000, promptTokens: 250, cacheHitTokens: 200, cacheMissTokens: 50 }));
    ledger.close();

    expect(readCallLedger(riverPath, NOW - DAY)).toEqual([
      call({ breakPart: "new", breakClass: "turn", idleMs: 5_000, promptTokens: 250, cacheHitTokens: 200, cacheMissTokens: 50 }),
    ]);
    expect(readCallLedger(riverPath, NOW + DAY)).toEqual([]);
  });

  it("reads nothing from a river that has no call ledger table yet", () => {
    expect(readCallLedger(riverPath, 0)).toEqual([]);
  });

  it("summarizes per kind of thread: the hit ratio, the ratio the stable runs would give, the breaks, and the mean part sizes", () => {
    const ledger = openLedger(riverPath);
    // Measured: 1000 prompt chars, 800 stable, 250 prompt tokens, 200 hits. The stable share is 0.8, so 200 were expected.
    ledger.appendCall(call({ promptTokens: 250, cacheHitTokens: 200, breakPart: "new", breakClass: "turn" }));
    // A provider that forgot: the stable run is 90% of the prompt but only 10 of 100 tokens hit.
    ledger.appendCall(call({ promptChars: 1000, stableChars: 900, promptTokens: 100, cacheHitTokens: 10, breakPart: "who", breakClass: "fixed", partSizes: { who: 300, recent: 600, new: 100 } }));
    ledger.appendCall(call({ threadKind: "game", promptTokens: 50, cacheHitTokens: 50 }));
    ledger.close();

    const summary = summarizeCallLedger(readCallLedger(riverPath, NOW - DAY));
    const summoner = summary["summoner"];
    expect(summoner?.calls).toBe(2);
    expect(summoner?.measured).toBe(2);
    expect(summoner?.promptTokens).toBe(350);
    expect(summoner?.cacheHitTokens).toBe(210);
    expect(summoner?.hitRatio).toBeCloseTo(210 / 350);
    // Expected: 250 * 0.8 + 100 * 0.9 = 290, over 350 prompt tokens.
    expect(summoner?.expectedRatio).toBeCloseTo(290 / 350);
    expect(summoner?.providerForgot).toBe(1);
    expect(summoner?.breaks).toEqual({ new: 1, who: 1 });
    expect(summoner?.partSizes["who"]).toEqual({ calls: 2, meanChars: 250 });
    expect(summoner?.marks).toBe(6);
    expect(summary["game"]?.hitRatio).toBe(1);
  });

  it("does not count a call as forgotten when its stable run is under 80% of the prompt", () => {
    const ledger = openLedger(riverPath);
    ledger.appendCall(call({ promptChars: 1000, stableChars: 700, promptTokens: 100, cacheHitTokens: 0 }));
    ledger.close();

    expect(summarizeCallLedger(readCallLedger(riverPath, NOW - DAY))["summoner"]?.providerForgot).toBe(0);
  });

  it("reports no ratio for calls that did not report their tokens", () => {
    const ledger = openLedger(riverPath);
    ledger.appendCall(call());
    ledger.close();

    const summoner = summarizeCallLedger(readCallLedger(riverPath, NOW - DAY))["summoner"];
    expect(summoner?.calls).toBe(1);
    expect(summoner?.hitRatio).toBeUndefined();
    expect(summoner?.expectedRatio).toBeUndefined();
  });
});
