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
  close(): void;
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

/** Opens the ledger in the river file, creating its table when it is not there yet. Close it when the Lar stops. */
export function openLedger(riverPath: string): Ledger {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(CREATE);
  } catch (err) {
    db.close();
    throw err;
  }
  const insert = db.prepare(
    `INSERT INTO ${TABLE} (at_ms, thread_kind, ended_by, outcome, model, prompt_tokens, completion_tokens, total_tokens,
      cache_hit_tokens, cache_miss_tokens, backup_used, error_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let closed = false;
  return {
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
