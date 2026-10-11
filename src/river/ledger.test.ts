import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRiver } from "./sqlite-river.js";
import { openLedger, readLedger, summarizeLedger, type LedgerRow } from "./ledger.js";

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
