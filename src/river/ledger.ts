// The ledger: one row per turn, kept as a table beside the river's rows, in the same file. A backup copies it with the
// river and a restore brings it back, and no new file is needed. It holds counts and kinds only: when, which kind of
// thread, how the turn ended, the model, the tokens the provider reported, and whether the backup answered. It never
// holds a message's text, so the forgetting of words never has to reach it.

import { DatabaseSync } from "node:sqlite";

/** Kinds of thread, by where they are: the summoner's own place, a contact, a room, the game, the Lar's own thread. */
export type ThreadKind = "summoner" | "contact" | "room" | "game" | "self" | "other";
export type TurnOutcome = "answered" | "failed" | "aborted";

export type LedgerRow = {
  atMs: number;
  threadKind: ThreadKind;
  endedBy: string;
  outcome: TurnOutcome;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  backupUsed: boolean;
  errorKind?: string;
};

export type Ledger = {
  append(row: LedgerRow): void;
  /** One row per model call, beside the turn rows. See CallRow. */
  appendCall(row: CallRow): void;
  close(): void;
};

/**
 * One row per model call (the cache witness): the call's position in its turn, the size of its prompt in characters, how
 * many of those characters were the same as an earlier call's (the stable run), the first part that differed, the
 * provider's token counts, the cache marks sent, and the size of each named part. No text is kept, only counts and names.
 */
export type CallRow = {
  atMs: number;
  threadKind: ThreadKind;
  turnCall: number;
  model: string;
  promptChars: number;
  stableChars: number;
  /** The first part that differed from the earlier call it matched. Absent when nothing differed. */
  breakPart?: string;
  breakClass?: "fixed" | "notes" | "page" | "turn";
  /** Milliseconds since the earlier call it matched. Absent when no earlier call was remembered. */
  idleMs?: number;
  promptTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  marks: number;
  /** Characters per named part. */
  partSizes: Record<string, number>;
};

const TABLE = "turn_ledger";
const CREATE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  thread_kind TEXT NOT NULL,
  ended_by TEXT NOT NULL,
  outcome TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  backup_used INTEGER NOT NULL,
  error_kind TEXT
)`;

const CALLS_TABLE = "call_ledger";
const CREATE_CALLS = `CREATE TABLE IF NOT EXISTS ${CALLS_TABLE} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  thread_kind TEXT NOT NULL,
  turn_call INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  stable_chars INTEGER NOT NULL,
  break_part TEXT,
  break_class TEXT,
  idle_ms INTEGER,
  prompt_tokens INTEGER,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  marks INTEGER NOT NULL,
  part_sizes TEXT NOT NULL
)`;

/** Opens the ledger in the river file, creating its tables when they are not there yet. Close it when the Lar stops. */
export function openLedger(riverPath: string): Ledger {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(CREATE);
    db.exec(CREATE_CALLS);
  } catch (err) {
    db.close();
    throw err;
  }
  const insert = db.prepare(
    `INSERT INTO ${TABLE} (at_ms, thread_kind, ended_by, outcome, model, prompt_tokens, completion_tokens, total_tokens,
      cache_hit_tokens, cache_miss_tokens, backup_used, error_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCall = db.prepare(
    `INSERT INTO ${CALLS_TABLE} (at_ms, thread_kind, turn_call, model, prompt_chars, stable_chars, break_part, break_class,
      idle_ms, prompt_tokens, cache_hit_tokens, cache_miss_tokens, marks, part_sizes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let closed = false;
  return {
    appendCall(row: CallRow): void {
      if (closed) throw new Error("the ledger is closed");
      insertCall.run(
        row.atMs,
        row.threadKind,
        row.turnCall,
        row.model,
        row.promptChars,
        row.stableChars,
        row.breakPart ?? null,
        row.breakClass ?? null,
        row.idleMs ?? null,
        row.promptTokens ?? null,
        row.cacheHitTokens ?? null,
        row.cacheMissTokens ?? null,
        row.marks,
        JSON.stringify(row.partSizes),
      );
    },
    append(row: LedgerRow): void {
      if (closed) throw new Error("the ledger is closed");
      insert.run(
        row.atMs,
        row.threadKind,
        row.endedBy,
        row.outcome,
        row.model,
        row.promptTokens ?? null,
        row.completionTokens ?? null,
        row.totalTokens ?? null,
        row.cacheHitTokens ?? null,
        row.cacheMissTokens ?? null,
        row.backupUsed ? 1 : 0,
        row.errorKind ?? null,
      );
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** The rows at or after a time, oldest first. A river with no ledger table yet has none. */
export function readLedger(riverPath: string, sinceMs: number): LedgerRow[] {
  const db = new DatabaseSync(riverPath, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);
    if (exists === undefined) return [];
    const records = db
      .prepare(`SELECT * FROM ${TABLE} WHERE at_ms >= ? ORDER BY seq`)
      .all(sinceMs) as unknown as LedgerRecord[];
    return records.map(fromRecord);
  } finally {
    db.close();
  }
}

type LedgerRecord = {
  at_ms: number;
  thread_kind: string;
  ended_by: string;
  outcome: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  backup_used: number;
  error_kind: string | null;
};

function fromRecord(record: LedgerRecord): LedgerRow {
  const row: LedgerRow = {
    atMs: Number(record.at_ms),
    threadKind: record.thread_kind as ThreadKind,
    endedBy: record.ended_by,
    outcome: record.outcome as TurnOutcome,
    model: record.model,
    backupUsed: record.backup_used === 1,
  };
  if (record.prompt_tokens !== null) row.promptTokens = Number(record.prompt_tokens);
  if (record.completion_tokens !== null) row.completionTokens = Number(record.completion_tokens);
  if (record.total_tokens !== null) row.totalTokens = Number(record.total_tokens);
  if (record.cache_hit_tokens !== null) row.cacheHitTokens = Number(record.cache_hit_tokens);
  if (record.cache_miss_tokens !== null) row.cacheMissTokens = Number(record.cache_miss_tokens);
  if (record.error_kind !== null) row.errorKind = record.error_kind;
  return row;
}

export type LedgerSummary = {
  turns: number;
  answered: number;
  failed: number;
  aborted: number;
  byThreadKind: Record<string, number>;
  byModel: Record<string, number>;
  backupAnswered: number;
  /** Totals over the turns that reported each count; `reportedFor` is how many turns reported any token count. */
  tokens: { prompt?: number; completion?: number; total?: number; reportedFor: number };
  cacheHitTokens: { total?: number; reportedFor: number };
};

/** Counts only: nothing in a summary names a word. */
export function summarizeLedger(rows: readonly LedgerRow[]): LedgerSummary {
  const summary: LedgerSummary = {
    turns: rows.length,
    answered: 0,
    failed: 0,
    aborted: 0,
    byThreadKind: {},
    byModel: {},
    backupAnswered: 0,
    tokens: { reportedFor: 0 },
    cacheHitTokens: { reportedFor: 0 },
  };
  for (const row of rows) {
    if (row.outcome === "answered") summary.answered += 1;
    else if (row.outcome === "failed") summary.failed += 1;
    else summary.aborted += 1;
    summary.byThreadKind[row.threadKind] = (summary.byThreadKind[row.threadKind] ?? 0) + 1;
    summary.byModel[row.model] = (summary.byModel[row.model] ?? 0) + 1;
    if (row.backupUsed) summary.backupAnswered += 1;
    if (row.promptTokens !== undefined || row.completionTokens !== undefined || row.totalTokens !== undefined) {
      summary.tokens.reportedFor += 1;
    }
    if (row.promptTokens !== undefined) summary.tokens.prompt = (summary.tokens.prompt ?? 0) + row.promptTokens;
    if (row.completionTokens !== undefined) summary.tokens.completion = (summary.tokens.completion ?? 0) + row.completionTokens;
    if (row.totalTokens !== undefined) summary.tokens.total = (summary.tokens.total ?? 0) + row.totalTokens;
    if (row.cacheHitTokens !== undefined) {
      summary.cacheHitTokens.reportedFor += 1;
      summary.cacheHitTokens.total = (summary.cacheHitTokens.total ?? 0) + row.cacheHitTokens;
    }
  }
  return summary;
}

/** The call rows at or after a time, oldest first. A river with no call ledger table yet has none. */
export function readCallLedger(riverPath: string, sinceMs: number): CallRow[] {
  const db = new DatabaseSync(riverPath, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(CALLS_TABLE);
    if (exists === undefined) return [];
    const records = db
      .prepare(`SELECT * FROM ${CALLS_TABLE} WHERE at_ms >= ? ORDER BY seq`)
      .all(sinceMs) as unknown as CallRecord[];
    return records.map(callFromRecord);
  } finally {
    db.close();
  }
}

type CallRecord = {
  at_ms: number;
  thread_kind: string;
  turn_call: number;
  model: string;
  prompt_chars: number;
  stable_chars: number;
  break_part: string | null;
  break_class: string | null;
  idle_ms: number | null;
  prompt_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  marks: number;
  part_sizes: string;
};

function callFromRecord(record: CallRecord): CallRow {
  const row: CallRow = {
    atMs: Number(record.at_ms),
    threadKind: record.thread_kind as ThreadKind,
    turnCall: Number(record.turn_call),
    model: record.model,
    promptChars: Number(record.prompt_chars),
    stableChars: Number(record.stable_chars),
    marks: Number(record.marks),
    partSizes: JSON.parse(record.part_sizes) as Record<string, number>,
  };
  if (record.break_part !== null) row.breakPart = record.break_part;
  if (record.break_class !== null) row.breakClass = record.break_class as CallRow["breakClass"];
  if (record.idle_ms !== null) row.idleMs = Number(record.idle_ms);
  if (record.prompt_tokens !== null) row.promptTokens = Number(record.prompt_tokens);
  if (record.cache_hit_tokens !== null) row.cacheHitTokens = Number(record.cache_hit_tokens);
  if (record.cache_miss_tokens !== null) row.cacheMissTokens = Number(record.cache_miss_tokens);
  return row;
}

export type CallSummary = {
  calls: number;
  /** Calls that reported both their prompt tokens and their cache-hit tokens. */
  measured: number;
  promptTokens: number;
  cacheHitTokens: number;
  /** Cache-hit tokens over prompt tokens, over the measured calls. Absent when none was measured. */
  hitRatio?: number;
  /** The share the same calls would hit if the provider kept their whole stable run. Absent when none was measured. */
  expectedRatio?: number;
  /**
   * Measured calls whose stable run was at least 80% of the prompt, and whose hits were under half of the run's share of
   * the prompt tokens. The provider forgot the prefix (an idle gap or an eviction), so this is not our layout.
   */
  providerForgot: number;
  /** Calls by the first part that differed from an earlier call. */
  breaks: Record<string, number>;
  /** Mean characters of each named part, over the calls that had it. */
  partSizes: Record<string, { calls: number; meanChars: number }>;
  marks: number;
};

/** Counts only, per kind of thread: nothing in a summary names a word, and every name is a part's name. */
export function summarizeCallLedger(rows: readonly CallRow[]): Record<string, CallSummary> {
  const byKind: Record<string, CallSummary> = {};
  const expected: Record<string, number> = {};
  const sizeTotals: Record<string, Record<string, { calls: number; chars: number }>> = {};
  for (const row of rows) {
    const kind = row.threadKind;
    const summary = (byKind[kind] ??= {
      calls: 0,
      measured: 0,
      promptTokens: 0,
      cacheHitTokens: 0,
      providerForgot: 0,
      breaks: {},
      partSizes: {},
      marks: 0,
    });
    summary.calls += 1;
    summary.marks += row.marks;
    if (row.breakPart !== undefined) summary.breaks[row.breakPart] = (summary.breaks[row.breakPart] ?? 0) + 1;
    const totals = (sizeTotals[kind] ??= {});
    for (const [name, chars] of Object.entries(row.partSizes)) {
      const total = (totals[name] ??= { calls: 0, chars: 0 });
      total.calls += 1;
      total.chars += chars;
    }
    if (row.promptTokens === undefined || row.cacheHitTokens === undefined || row.promptChars <= 0) continue;
    const share = row.stableChars / row.promptChars;
    summary.measured += 1;
    summary.promptTokens += row.promptTokens;
    summary.cacheHitTokens += row.cacheHitTokens;
    expected[kind] = (expected[kind] ?? 0) + row.promptTokens * share;
    if (share >= 0.8 && row.cacheHitTokens < 0.5 * row.promptTokens * share) summary.providerForgot += 1;
  }
  for (const [kind, summary] of Object.entries(byKind)) {
    if (summary.promptTokens > 0) {
      summary.hitRatio = summary.cacheHitTokens / summary.promptTokens;
      summary.expectedRatio = (expected[kind] ?? 0) / summary.promptTokens;
    }
    for (const [name, total] of Object.entries(sizeTotals[kind] ?? {})) {
      summary.partSizes[name] = { calls: total.calls, meanChars: Math.round(total.chars / total.calls) };
    }
  }
  return byKind;
}
