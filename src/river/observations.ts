// Her observation log: dated notes in her own words about a span of her river, keyed by the first and last row of the
// span. A row is written only by her own tool call; the body never composes one. The rows live in river.db as a derived
// store, so a forget erases them in the river's own transaction: a forgotten row anywhere in the span drops the
// observation whole, and a text forget reaches the observation through its own words.

import { DatabaseSync } from "node:sqlite";
import type { DerivedStore } from "./derived.js";

export const OBSERVATIONS_TABLE = "observations";

const OBSERVATIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${OBSERVATIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  thread TEXT NOT NULL,
  text TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  start_seq INTEGER,
  end_seq INTEGER,
  forgotten INTEGER NOT NULL DEFAULT 0,
  forgotten_why TEXT,
  CHECK (forgotten = 1 OR (text IS NOT NULL AND start_seq IS NOT NULL AND end_seq IS NOT NULL AND start_seq <= end_seq))
)`;

const OBSERVATIONS_SPAN_INDEX = `CREATE INDEX IF NOT EXISTS observations_span ON ${OBSERVATIONS_TABLE}(start_seq, end_seq)`;

/** One observation as she reads it: her words, the rows the span covers, and when she wrote it. */
export type ObservationRecord = {
  id: number;
  atMs: number;
  thread: string;
  text: string;
  private: boolean;
  startSeq: number;
  endSeq: number;
};

/** An observation row as stored, including a row erased by forget. */
export type ObservationRow = {
  id: number;
  atMs: number;
  thread: string;
  /** Null only after a forget. */
  text: string | null;
  /** Null only after a forget. */
  startSeq: number | null;
  /** Null only after a forget. */
  endSeq: number | null;
  private: boolean;
  forgotten: boolean;
  forgottenWhy?: string;
};

export type NewObservation = {
  thread: string;
  text: string;
  private: boolean;
  startSeq: number;
  endSeq: number;
  atMs: number;
};

export interface ObservationStore {
  record(observation: NewObservation): ObservationRecord;
  /** The observation rows that a forget has not erased, newest span first. */
  current(): ObservationRecord[];
  /** One observation row by its id, including a forgotten row. */
  get(id: number): ObservationRow | undefined;
  close(): void;
}

export class ObservationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationsError";
  }
}

type StoredObservation = {
  id: number;
  at_ms: number;
  thread: string;
  text: string | null;
  start_seq: number | null;
  end_seq: number | null;
  private: number;
  forgotten: number;
  forgotten_why: string | null;
};

/** Opens the observations in the river file. Close it when the Lar stops. */
export function openObservations(riverPath: string): ObservationStore {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(OBSERVATIONS_SCHEMA);
    db.exec(OBSERVATIONS_SPAN_INDEX);
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    `INSERT INTO ${OBSERVATIONS_TABLE} (at_ms, thread, text, private, start_seq, end_seq) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(`SELECT * FROM ${OBSERVATIONS_TABLE} WHERE id = ?`);
  const current = db.prepare(
    `SELECT * FROM ${OBSERVATIONS_TABLE} WHERE forgotten = 0 ORDER BY end_seq DESC, id DESC`,
  );
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new ObservationsError("the observations are closed");
  };

  return {
    record(observation: NewObservation): ObservationRecord {
      ensureOpen();
      checkNewObservation(observation);
      const info = insert.run(
        observation.atMs,
        observation.thread,
        observation.text,
        observation.private ? 1 : 0,
        observation.startSeq,
        observation.endSeq,
      );
      const row = get.get(Number(info.lastInsertRowid)) as StoredObservation | undefined;
      if (row === undefined || row.text === null) {
        throw new ObservationsError("the observation was written but could not be read back");
      }
      return toObservationRecord(row);
    },

    current(): ObservationRecord[] {
      ensureOpen();
      return (current.all() as unknown as StoredObservation[]).map((row) => toObservationRecord(row));
    },

    get(id: number): ObservationRow | undefined {
      ensureOpen();
      checkId(id);
      const row = get.get(id) as StoredObservation | undefined;
      return row === undefined ? undefined : toObservationRow(row);
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** The section text for the observations a turn shows. Undefined when there are none. */
export function observationsContextText(observations: readonly ObservationRecord[]): string | undefined {
  if (observations.length === 0) return undefined;
  const lines = ["Observations you wrote, with the rows they cover."];
  for (const observation of observations) lines.push(observationLine(observation));
  return lines.join("\n");
}

function observationLine(observation: ObservationRecord): string {
  const span =
    observation.startSeq === observation.endSeq
      ? `row ${observation.startSeq}`
      : `rows ${observation.startSeq} to ${observation.endSeq}`;
  return `- observation ${observation.id}, ${span}, written ${dateOf(observation.atMs)}: ${observation.text}`;
}

function dateOf(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * The observation log's part of the U8 cascade. A forgotten row anywhere in the span drops the observation whole, and
 * a text forget reaches it through its own words even when no river row matched. The row stays as its own tombstone:
 * its text and span are blank, and `forgotten_why` says which kind of forget reached it.
 */
export const observationsDerivedStore: DerivedStore = {
  tables: [OBSERVATIONS_TABLE],
  schema: [OBSERVATIONS_SCHEMA, OBSERVATIONS_SPAN_INDEX],
  cascade(db: DatabaseSync, forget): number {
    if (forget.seqs.length === 0 && forget.words.length === 0) return 0;
    const seqs = new Set(forget.seqs);
    const rows = db
      .prepare(`SELECT id, text, start_seq, end_seq FROM ${OBSERVATIONS_TABLE} WHERE forgotten = 0`)
      .all() as unknown as Array<{ id: number; text: string | null; start_seq: number | null; end_seq: number | null }>;
    const drop = db.prepare(
      `UPDATE ${OBSERVATIONS_TABLE}
       SET text = NULL, start_seq = NULL, end_seq = NULL, forgotten = 1, forgotten_why = ?
       WHERE id = ?`,
    );
    let erased = 0;
    for (const row of rows) {
      if (row.start_seq === null || row.end_seq === null) continue;
      const start = Number(row.start_seq);
      const end = Number(row.end_seq);
      const bySeq = coversAnySeq(start, end, seqs);
      const byText = row.text !== null && holdsWords(row.text, forget.words);
      if (!bySeq && !byText) continue;
      drop.run(bySeq ? "source" : "text", row.id);
      erased += 1;
    }
    return erased;
  },
};

function coversAnySeq(start: number, end: number, seqs: ReadonlySet<number>): boolean {
  for (const seq of seqs) {
    if (seq >= start && seq <= end) return true;
  }
  return false;
}

function toObservationRecord(row: StoredObservation): ObservationRecord {
  if (row.text === null || row.start_seq === null || row.end_seq === null) {
    throw new ObservationsError(`observation ${row.id} has no text or span`);
  }
  return {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    thread: row.thread,
    text: row.text,
    startSeq: Number(row.start_seq),
    endSeq: Number(row.end_seq),
    private: row.private === 1,
  };
}

function toObservationRow(row: StoredObservation): ObservationRow {
  const observation: ObservationRow = {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    thread: row.thread,
    text: row.text,
    startSeq: row.start_seq === null ? null : Number(row.start_seq),
    endSeq: row.end_seq === null ? null : Number(row.end_seq),
    private: row.private === 1,
    forgotten: row.forgotten === 1,
  };
  if (row.forgotten_why !== null) observation.forgottenWhy = row.forgotten_why;
  return observation;
}

function holdsWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const folded = text.normalize("NFKC").toLowerCase();
  return words.every((word) => folded.includes(word));
}

function checkNewObservation(observation: NewObservation): void {
  if (typeof observation !== "object" || observation === null) throw new ObservationsError("an observation must be an object");
  if (typeof observation.thread !== "string" || observation.thread.trim() === "") {
    throw new ObservationsError("thread must not be blank");
  }
  if (typeof observation.text !== "string" || observation.text.trim() === "") {
    throw new ObservationsError("an observation needs her text");
  }
  if (typeof observation.private !== "boolean") throw new ObservationsError("private must be true or false");
  checkSeq(observation.startSeq, "startSeq");
  checkSeq(observation.endSeq, "endSeq");
  if (observation.startSeq > observation.endSeq) {
    throw new ObservationsError("startSeq must not be after endSeq");
  }
  checkTime(observation.atMs, "atMs");
}

function checkId(id: unknown): asserts id is number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new ObservationsError("id must be a whole number");
  }
}

function checkSeq(seq: unknown, name: string): asserts seq is number {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new ObservationsError(`${name} must be a whole number`);
  }
}

function checkTime(atMs: unknown, name: string): asserts atMs is number {
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) {
    throw new ObservationsError(`${name} must be a whole number`);
  }
}
