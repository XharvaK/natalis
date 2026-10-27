// Her facts: short statements in her own words, each citing the river rows it came from. A fact is written only by her
// own tool call; the body never extracts one, and there is no candidate column. Closing a fact is another row, never an
// in-place edit. The rows live in river.db as a derived store, so a forget erases them in the river's own transaction.
//
// A fact is current until a close row names it. Its age is measured from when she wrote it; past the recall half-life
// (90 days) it is shown below the recent facts and marked for review, never silently dropped or called false.

import { DatabaseSync } from "node:sqlite";
import { RECALL_HALF_LIFE_MS } from "../context/recall-rank.js";
import type { DerivedStore } from "./derived.js";

export const FACTS_TABLE = "facts";

const FACTS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${FACTS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  thread TEXT NOT NULL,
  text TEXT,
  source_seqs TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  valid_from_seq INTEGER NOT NULL,
  closes_id INTEGER,
  valid_to_seq INTEGER,
  forgotten INTEGER NOT NULL DEFAULT 0,
  forgotten_why TEXT
)`;

const FACTS_CLOSES_INDEX = `CREATE INDEX IF NOT EXISTS facts_closes_id ON ${FACTS_TABLE}(closes_id)`;

/** One fact as she reads it: her words, the rows she cited, and when she wrote it. */
export type FactRecord = {
  id: number;
  atMs: number;
  thread: string;
  text: string;
  sourceSeqs: number[];
  private: boolean;
  validFromSeq: number;
};

/** A fact row as stored, including a row erased by forget and the close state. */
export type FactRow = {
  id: number;
  atMs: number;
  thread: string;
  /** Null only after a forget or on a close row. */
  text: string | null;
  sourceSeqs: number[];
  private: boolean;
  validFromSeq: number;
  closesId?: number;
  validToSeq?: number;
  forgotten: boolean;
  forgottenWhy?: string;
  closed: boolean;
};

export type NewFact = {
  thread: string;
  text: string;
  seqs: readonly number[];
  private: boolean;
  validFromSeq: number;
  atMs: number;
};

export type FactClose = {
  id: number;
  factId: number;
  atMs: number;
  thread: string;
  validToSeq: number;
};

export interface FactStore {
  record(fact: NewFact): FactRecord;
  /** The fact rows that are neither closed nor forgotten, newest writing first. */
  current(): FactRecord[];
  /** One fact row by its id; a close row or a missing id gives undefined. */
  get(id: number): FactRow | undefined;
  closeFact(id: number, input: { thread: string; atMs: number; validToSeq: number }): FactClose;
  close(): void;
}

export class FactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsError";
  }
}

type StoredFact = {
  id: number;
  at_ms: number;
  thread: string;
  text: string | null;
  source_seqs: string | null;
  private: number;
  valid_from_seq: number;
  closes_id: number | null;
  valid_to_seq: number | null;
  forgotten: number;
  forgotten_why: string | null;
  closed: number;
};

/** Opens the facts in the river file. Close it when the Lar stops. */
export function openFacts(riverPath: string): FactStore {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(FACTS_SCHEMA);
    db.exec(FACTS_CLOSES_INDEX);
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    `INSERT INTO ${FACTS_TABLE} (at_ms, thread, text, source_seqs, private, valid_from_seq) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const closeInsert = db.prepare(
    `INSERT INTO ${FACTS_TABLE} (at_ms, thread, text, source_seqs, private, valid_from_seq, closes_id, valid_to_seq)
     VALUES (?, ?, NULL, NULL, 0, ?, ?, ?)`,
  );
  const get = db.prepare(
    `SELECT *, EXISTS (SELECT 1 FROM ${FACTS_TABLE} c WHERE c.closes_id = f.id) AS closed
     FROM ${FACTS_TABLE} f WHERE f.id = ? AND f.closes_id IS NULL`,
  );
  const current = db.prepare(
    `SELECT *, 0 AS closed FROM ${FACTS_TABLE} f
     WHERE f.closes_id IS NULL AND f.forgotten = 0
       AND NOT EXISTS (SELECT 1 FROM ${FACTS_TABLE} c WHERE c.closes_id = f.id)
     ORDER BY f.valid_from_seq DESC, f.id DESC`,
  );
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new FactsError("the facts are closed");
  };

  return {
    record(fact: NewFact): FactRecord {
      ensureOpen();
      checkNewFact(fact);
      const seqs = [...new Set(fact.seqs)].sort((a, b) => a - b);
      const info = insert.run(
        fact.atMs,
        fact.thread,
        fact.text,
        JSON.stringify(seqs),
        fact.private ? 1 : 0,
        fact.validFromSeq,
      );
      const row = readRow(Number(info.lastInsertRowid));
      if (row === undefined || row.text === null) throw new FactsError("the fact was written but could not be read back");
      return toFactRecord(row);
    },

    current(): FactRecord[] {
      ensureOpen();
      return (current.all() as unknown as StoredFact[]).map((row) => toFactRecord(row));
    },

    get(id: number): FactRow | undefined {
      ensureOpen();
      checkId(id);
      const row = get.get(id) as StoredFact | undefined;
      return row === undefined ? undefined : toFactRow(row);
    },

    closeFact(id: number, input: { thread: string; atMs: number; validToSeq: number }): FactClose {
      ensureOpen();
      checkId(id);
      checkTime(input.atMs, "atMs");
      checkSeq(input.validToSeq, "validToSeq");
      if (typeof input.thread !== "string" || input.thread.trim() === "") {
        throw new FactsError("thread must not be blank");
      }
      const existing = get.get(id) as StoredFact | undefined;
      if (existing === undefined) throw new FactsError(`there is no fact with id ${id}`);
      if (existing.forgotten === 1) throw new FactsError(`fact ${id} was forgotten`);
      if (existing.closed === 1) throw new FactsError(`fact ${id} is already closed`);
      const info = closeInsert.run(input.atMs, input.thread, input.validToSeq, id, input.validToSeq);
      return {
        id: Number(info.lastInsertRowid),
        factId: id,
        atMs: input.atMs,
        thread: input.thread,
        validToSeq: input.validToSeq,
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  function readRow(id: number): StoredFact | undefined {
    return get.get(id) as StoredFact | undefined;
  }
}

/** The section text for the facts a turn shows. Undefined when there are none. */
export function factsContextText(
  facts: readonly FactRecord[],
  nowMs: number,
  halfLifeMs = RECALL_HALF_LIFE_MS,
): string | undefined {
  if (facts.length === 0) return undefined;
  const recent: FactRecord[] = [];
  const overdue: FactRecord[] = [];
  for (const fact of facts) {
    if (nowMs - fact.atMs >= halfLifeMs) overdue.push(fact);
    else recent.push(fact);
  }
  const order = (a: FactRecord, b: FactRecord): number => b.validFromSeq - a.validFromSeq || b.id - a.id;
  recent.sort(order);
  overdue.sort(order);
  const reviewDays = Math.max(1, Math.round(halfLifeMs / 86_400_000));
  const lines = [
    `Facts you recorded, with the rows they came from. Anything not reviewed for ${reviewDays} days is at the end, marked for review.`,
  ];
  for (const fact of recent) lines.push(factLine(fact));
  for (const fact of overdue) lines.push(overdueLine(fact, nowMs));
  return lines.join("\n");
}

function factLine(fact: FactRecord): string {
  return `- fact ${fact.id}, from seqs ${fact.sourceSeqs.join(", ")}, recorded ${dateOf(fact.atMs)}: ${fact.text}`;
}

function overdueLine(fact: FactRecord, nowMs: number): string {
  const days = Math.floor((nowMs - fact.atMs) / 86_400_000);
  return `- fact ${fact.id}, from seqs ${fact.sourceSeqs.join(", ")}, unreviewed since ${dateOf(fact.atMs)} (${days} days old): ${fact.text}`;
}

function dateOf(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * The facts store's part of the U8 cascade. A forgotten source erases the whole fact, and a text forget reaches a fact
 * by its own words even when no river row matched. The row stays as its own tombstone: its text and sources are blank,
 * and `forgotten_why` says which kind of forget reached it.
 */
export const factsDerivedStore: DerivedStore = {
  tables: [FACTS_TABLE],
  schema: [FACTS_SCHEMA, FACTS_CLOSES_INDEX],
  cascade(db: DatabaseSync, forget): number {
    if (forget.seqs.length === 0 && forget.words.length === 0) return 0;
    const seqs = new Set(forget.seqs);
    const rows = db
      .prepare(`SELECT id, text, source_seqs FROM ${FACTS_TABLE} WHERE closes_id IS NULL AND forgotten = 0`)
      .all() as unknown as Array<{ id: number; text: string | null; source_seqs: string | null }>;
    const erase = db.prepare(
      `UPDATE ${FACTS_TABLE} SET text = NULL, source_seqs = NULL, forgotten = 1, forgotten_why = ? WHERE id = ?`,
    );
    let erased = 0;
    for (const row of rows) {
      const bySeq = parseSourceSeqs(row.source_seqs).some((seq) => seqs.has(seq));
      const byText = row.text !== null && holdsWords(row.text, forget.words);
      if (!bySeq && !byText) continue;
      erase.run(bySeq ? "source" : "text", row.id);
      erased += 1;
    }
    return erased;
  },
};

function toFactRecord(row: StoredFact): FactRecord {
  if (row.text === null) throw new FactsError(`fact ${row.id} has no text`);
  return {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    thread: row.thread,
    text: row.text,
    sourceSeqs: parseSourceSeqs(row.source_seqs),
    private: row.private === 1,
    validFromSeq: Number(row.valid_from_seq),
  };
}

function toFactRow(row: StoredFact): FactRow {
  const fact: FactRow = {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    thread: row.thread,
    text: row.text,
    sourceSeqs: parseSourceSeqs(row.source_seqs),
    private: row.private === 1,
    validFromSeq: Number(row.valid_from_seq),
    forgotten: row.forgotten === 1,
    closed: row.closed === 1,
  };
  if (row.closes_id !== null) fact.closesId = Number(row.closes_id);
  if (row.valid_to_seq !== null) fact.validToSeq = Number(row.valid_to_seq);
  if (row.forgotten_why !== null) fact.forgottenWhy = row.forgotten_why;
  return fact;
}

function parseSourceSeqs(json: string | null): number[] {
  if (json === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new FactsError("a fact's source seqs are not valid JSON");
  }
  if (!Array.isArray(value)) throw new FactsError("a fact's source seqs are not a list");
  const seqs: number[] = [];
  for (const seq of value) {
    checkSeq(seq, "source seq");
    seqs.push(seq);
  }
  return seqs;
}

function holdsWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const folded = text.normalize("NFKC").toLowerCase();
  return words.every((word) => folded.includes(word));
}

function checkNewFact(fact: NewFact): void {
  if (typeof fact !== "object" || fact === null) throw new FactsError("a fact must be an object");
  if (typeof fact.thread !== "string" || fact.thread.trim() === "") throw new FactsError("thread must not be blank");
  if (typeof fact.text !== "string" || fact.text.trim() === "") throw new FactsError("a fact needs her text");
  if (!Array.isArray(fact.seqs) || fact.seqs.length === 0) throw new FactsError("a fact needs at least one source seq");
  for (const seq of fact.seqs) checkSeq(seq, "source seq");
  if (typeof fact.private !== "boolean") throw new FactsError("private must be true or false");
  checkSeq(fact.validFromSeq, "validFromSeq");
  checkTime(fact.atMs, "atMs");
}

function checkId(id: unknown): asserts id is number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new FactsError("id must be a whole number");
}

function checkSeq(seq: unknown, name: string): asserts seq is number {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new FactsError(`${name} must be a whole number`);
}

function checkTime(atMs: unknown, name: string): asserts atMs is number {
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) throw new FactsError(`${name} must be a whole number`);
}
