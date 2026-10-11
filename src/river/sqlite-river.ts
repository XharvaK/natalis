// The river in SQLite: one append-only log. Rows are never updated except by forget, never deleted.
// Forgetting erases text and data in place, removes the text from the search index, and leaves a tombstone.
// Then the file is compacted, so the forgotten words are not left in its bytes or its write-ahead log.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  River,
  RiverKind,
  RiverQuery,
  RiverRow,
  RiverRowInput,
  RiverSource,
} from "../contracts.js";

/** A row as read back. Adds whether its text was forgotten (the contract's RiverRow has no such field). */
export type StoredRiverRow = RiverRow & { forgotten: boolean };

export type StoredRiverHit = { row: StoredRiverRow; score: number };

export type TombstoneInput = {
  atMs: number;
  /** Who forgot it: the owner, the entity itself, or the body. */
  by: "owner" | "self" | "body";
  /** Plain fields only (reason, count, what). Never forgotten text. */
  data: Record<string, unknown>;
};

export interface SqliteRiver extends River {
  append(row: RiverRowInput): StoredRiverRow;
  read(query: RiverQuery): StoredRiverRow[];
  search(text: string, options?: { limit?: number; thread?: string }): StoredRiverHit[];
  /**
   * Writes one tombstone row with an explicit time, for an importer that carries forgets over from another
   * system. The row has no text; its data says what was forgotten. Ordinary code uses forget(), not this.
   */
  appendTombstone(row: TombstoneInput): StoredRiverRow;
  /** "fts5": ranked by bm25 over an FTS5 index. "like": case-insensitive substring match, newest first. */
  readonly searchMode: "fts5" | "like";
  readonly path: string;
}

export type OpenRiverOptions = {
  nowMs?: () => number;
  /** Test hook: search with LIKE even when FTS5 is available. The index is still kept up to date. */
  forceNoFts?: boolean;
};

export class RiverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiverError";
  }
}

export const RIVER_SCHEMA_VERSION = 1;

const KINDS: readonly RiverKind[] = ["event", "say", "tool_call", "receipt", "turn", "note", "tombstone"];
const SOURCES: readonly RiverSource[] = ["owner", "outside", "self", "body"];
const KIND_SET: ReadonlySet<string> = new Set<string>(KINDS);
const SOURCE_SET: ReadonlySet<string> = new Set<string>(SOURCES);

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;

type RowRecord = {
  seq: number;
  at_ms: number;
  thread: string;
  kind: string;
  source: string;
  place: string | null;
  actor: string | null;
  text: string | null;
  data_json: string | null;
  forgotten: number;
};

let ftsProbe: boolean | undefined;

/** True when this SQLite build has FTS5. Probed once, on a scratch in-memory database. */
export function ftsAvailable(): boolean {
  if (ftsProbe === undefined) {
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE probe USING fts5(text)");
      ftsProbe = true;
    } catch {
      ftsProbe = false;
    } finally {
      probe.close();
    }
  }
  return ftsProbe;
}

export function openRiver(path: string | ":memory:", options: OpenRiverOptions = {}): SqliteRiver {
  const nowMs = options.nowMs ?? (() => Date.now());
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    // Forgotten text must not linger in freed pages.
    db.exec("PRAGMA secure_delete = ON");

    const fts = ftsAvailable();
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const hasRows = tableExists(db, "rows");
    const hasFtsTable = tableExists(db, "river_fts");

    if (!hasRows) {
      if (version !== 0) throw new RiverError(`river at ${path} has schema version ${version} but no rows table`);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE rows (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            at_ms INTEGER NOT NULL,
            thread TEXT NOT NULL,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            place TEXT,
            actor TEXT,
            text TEXT,
            data_json TEXT,
            forgotten INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX rows_thread_seq ON rows(thread, seq);
          CREATE INDEX rows_at_ms ON rows(at_ms);
          PRAGMA user_version = ${RIVER_SCHEMA_VERSION};
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (version !== RIVER_SCHEMA_VERSION) {
      throw new RiverError(`river at ${path} has schema version ${version}; this code reads version ${RIVER_SCHEMA_VERSION}`);
    }

    if (hasFtsTable && !fts) {
      throw new RiverError(`river at ${path} has an FTS5 index, and this SQLite build has no FTS5`);
    }
    if (fts && !hasFtsTable) {
      // A new file, or an older one written without FTS5: create the index and index what the file holds.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE VIRTUAL TABLE river_fts USING fts5(text)");
        db.exec(
          "INSERT INTO river_fts(rowid, text) SELECT seq, text FROM rows WHERE text IS NOT NULL AND forgotten = 0 AND kind != 'tombstone'",
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    const useFts = fts && options.forceNoFts !== true;
    return buildRiver();

    function buildRiver(): SqliteRiver {
      const insertStmt = db.prepare(
        "INSERT INTO rows (at_ms, thread, kind, source, place, actor, text, data_json, forgotten) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      );
      const getStmt = db.prepare("SELECT * FROM rows WHERE seq = ?");
      const lastStmt = db.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM rows");
      const ftsInsert = fts ? db.prepare("INSERT INTO river_fts(rowid, text) VALUES (?, ?)") : null;
      const ftsDelete = fts ? db.prepare("DELETE FROM river_fts WHERE rowid = ?") : null;
      const eraseStmt = db.prepare("UPDATE rows SET text = NULL, data_json = NULL, forgotten = 1 WHERE seq = ?");
      const blankActorStmt = db.prepare("UPDATE rows SET actor = NULL WHERE seq = ?");
      const scanTextStmt = db.prepare(
        "SELECT seq, text, data_json, actor FROM rows WHERE forgotten = 0 AND kind != 'tombstone'",
      );

      /**
       * Forgotten words must not stay in the file's bytes. The search index is merged first (FTS5 keeps deleted
       * terms until it is), the file is rebuilt without its free pages, and the write-ahead log is folded in and
       * emptied. Runs after the forget's transaction has committed, because VACUUM cannot run inside one.
       */
      const compact = (): void => {
        if (fts) db.exec("INSERT INTO river_fts(river_fts) VALUES('optimize')");
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      };

      const ensureOpen = (): void => {
        if (closed) throw new RiverError("the river is closed");
      };

      const inTransaction = <T>(work: () => T): T => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = work();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };

      const getRow = (seq: number): StoredRiverRow => {
        const record = getStmt.get(seq) as RowRecord | undefined;
        if (!record) throw new RiverError(`no river row with seq ${seq}`);
        return toStored(record);
      };

      const insertChecked = (input: CheckedInput): StoredRiverRow => {
        const info = insertStmt.run(
          input.atMs,
          input.thread,
          input.kind,
          input.source,
          input.place ?? null,
          input.actor ?? null,
          input.text ?? null,
          input.dataJson,
        );
        const seq = Number(info.lastInsertRowid);
        if (ftsInsert && input.text !== undefined) ftsInsert.run(seq, input.text);
        return getRow(seq);
      };

      return {
        path,
        searchMode: useFts ? "fts5" : "like",

        append(row: RiverRowInput): StoredRiverRow {
          ensureOpen();
          const checked = checkInput(row, nowMs);
          return inTransaction(() => insertChecked(checked));
        },

        appendTombstone(row: TombstoneInput): StoredRiverRow {
          ensureOpen();
          checkTombstone(row);
          const dataJson = JSON.stringify(row.data);
          return inTransaction(() =>
            insertChecked({ atMs: row.atMs, thread: "body", kind: "tombstone", source: row.by, dataJson }),
          );
        },

        read(query: RiverQuery): StoredRiverRow[] {
          ensureOpen();
          const where: string[] = [];
          const params: SQLInputValue[] = [];
          if (query.thread !== undefined) {
            requireString(query.thread, "thread");
            where.push("thread = ?");
            params.push(query.thread);
          }
          if (query.kinds !== undefined) {
            if (!Array.isArray(query.kinds) || query.kinds.length === 0) {
              throw new RiverError("kinds must be a non-empty list; leave it out to read every kind");
            }
            for (const kind of query.kinds) checkKind(kind);
            where.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
            params.push(...query.kinds);
          }
          if (query.sinceSeq !== undefined) {
            checkInteger(query.sinceSeq, "sinceSeq");
            where.push("seq > ?");
            params.push(query.sinceSeq);
          }
          if (query.untilSeq !== undefined) {
            checkInteger(query.untilSeq, "untilSeq");
            where.push("seq <= ?");
            params.push(query.untilSeq);
          }
          if (query.sinceMs !== undefined) {
            checkInteger(query.sinceMs, "sinceMs");
            where.push("at_ms >= ?");
            params.push(query.sinceMs);
          }
          const limit = checkLimit(query.limit ?? DEFAULT_READ_LIMIT, "limit");
          const order = query.newestFirst === true ? "DESC" : "ASC";
          const sql =
            `SELECT * FROM rows${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
            `ORDER BY seq ${order} LIMIT ?`;
          params.push(limit);
          const records = db.prepare(sql).all(...params) as unknown as RowRecord[];
          return records.map(toStored);
        },

        search(text: string, options: { limit?: number; thread?: string } = {}): StoredRiverHit[] {
          ensureOpen();
          requireString(text, "search text");
          const limit = checkLimit(options.limit ?? DEFAULT_SEARCH_LIMIT, "limit");
          if (options.thread !== undefined) requireString(options.thread, "thread");
          const terms = searchTerms(text);
          if (terms.length === 0) return [];

          if (useFts) {
            // Each term is quoted, so punctuation is plain text, never FTS syntax. Terms are ANDed.
            const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" ");
            const params: SQLInputValue[] = [match];
            let sql =
              "SELECT rows.*, bm25(river_fts) AS rank FROM river_fts " +
              "JOIN rows ON rows.seq = river_fts.rowid " +
              "WHERE river_fts MATCH ? AND rows.forgotten = 0 AND rows.kind != 'tombstone'";
            if (options.thread !== undefined) {
              sql += " AND rows.thread = ?";
              params.push(options.thread);
            }
            sql += " ORDER BY rank, rows.seq DESC LIMIT ?";
            params.push(limit);
            const records = db.prepare(sql).all(...params) as unknown as Array<RowRecord & { rank: number }>;
            // bm25 is lower for better matches; the hit score is higher-is-better.
            return records.map((record) => ({ row: toStored(record), score: -record.rank }));
          }

          const where = ["forgotten = 0", "text IS NOT NULL", "kind != 'tombstone'"];
          const params: SQLInputValue[] = [];
          for (const term of terms) {
            where.push("text LIKE ? ESCAPE '\\'");
            params.push(`%${escapeLike(term)}%`);
          }
          if (options.thread !== undefined) {
            where.push("thread = ?");
            params.push(options.thread);
          }
          params.push(limit);
          const sql = `SELECT * FROM rows WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`;
          const records = db.prepare(sql).all(...params) as unknown as RowRecord[];
          // No relevance score in this mode; results are newest first.
          return records.map((record) => ({ row: toStored(record), score: 0 }));
        },

        forget(match: { seqs?: number[]; text?: string }, by: "owner" | "self", reason: string): number {
          ensureOpen();
          if (by !== "owner" && by !== "self") throw new RiverError('forget: "by" must be "owner" or "self"');
          if (typeof reason !== "string" || reason.trim() === "") {
            throw new RiverError("forget: a reason is required");
          }
          if (match.seqs === undefined && match.text === undefined) {
            throw new RiverError("forget: give seqs, text, or both");
          }
          if (match.seqs !== undefined) {
            if (!Array.isArray(match.seqs)) throw new RiverError("forget: seqs must be a list of seq numbers");
            for (const seq of match.seqs) checkInteger(seq, "seq");
          }
          if (match.text !== undefined) {
            requireString(match.text, "forget text");
            if (match.text.trim() === "") throw new RiverError("forget: text must not be blank");
          }

          const count = inTransaction(() => {
            const targets = new Set<number>();
            const actorBlanks = new Set<number>();

            for (const seq of match.seqs ?? []) {
              const record = getStmt.get(seq) as RowRecord | undefined;
              if (!record) continue;
              if (record.kind === "tombstone") {
                throw new RiverError(`forget: seq ${seq} is a tombstone and cannot be forgotten`);
              }
              if (record.forgotten === 0) targets.add(seq);
            }

            if (match.text !== undefined) {
              // Every word, case-insensitive, in any order. A row matches when its text holds all the words, or
              // its data does. Tombstones are never matched. An erased row whose actor holds a word loses its actor.
              const words = forgetWords(match.text);
              const escapedWords = words.map((word) => JSON.stringify(word).slice(1, -1));
              for (const record of scanTextStmt.iterate() as Iterable<RowRecord>) {
                const inText = record.text !== null && holdsWords(foldText(record.text), words);
                // Data is JSON text, so a word is also looked for in its escaped form.
                const data = record.data_json === null ? "" : foldText(record.data_json);
                const inData =
                  data !== "" && words.every((word, i) => data.includes(word) || data.includes(escapedWords[i] ?? word));
                if (!inText && !inData) continue;
                targets.add(record.seq);
                const actor = record.actor === null ? "" : foldText(record.actor);
                if (actor !== "" && words.some((word) => actor.includes(word))) actorBlanks.add(record.seq);
              }
            }

            const erased = [...targets].sort((a, b) => a - b);
            if (erased.length === 0) return 0;
            for (const seq of erased) {
              eraseStmt.run(seq);
              if (actorBlanks.has(seq)) blankActorStmt.run(seq);
              if (ftsDelete) ftsDelete.run(seq);
            }

            insertChecked({
              thread: "body",
              kind: "tombstone",
              source: by === "owner" ? "owner" : "self",
              atMs: checkNow(nowMs),
              text: undefined,
              place: undefined,
              actor: undefined,
              dataJson: JSON.stringify({ count: erased.length, by, reason, seqs: erased }),
            });
            return erased.length;
          });
          if (count > 0) compact();
          return count;
        },

        lastSeq(): number {
          ensureOpen();
          return Number((lastStmt.get() as { last: number }).last);
        },

        close(): void {
          if (closed) return;
          closed = true;
          db.close();
        },
      };
    }
  } catch (error) {
    if (!closed) {
      closed = true;
      db.close();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// helpers

type CheckedInput = {
  atMs: number;
  thread: string;
  kind: RiverKind;
  source: RiverSource;
  place?: string;
  actor?: string;
  text?: string;
  dataJson: string | null;
};

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}

function toStored(record: RowRecord): StoredRiverRow {
  const row: StoredRiverRow = {
    seq: Number(record.seq),
    atMs: Number(record.at_ms),
    thread: record.thread,
    kind: record.kind as RiverKind,
    source: record.source as RiverSource,
    forgotten: record.forgotten === 1,
  };
  if (record.place !== null) row.place = record.place;
  if (record.actor !== null) row.actor = record.actor;
  if (record.text !== null) row.text = record.text;
  if (record.data_json !== null) row.data = JSON.parse(record.data_json) as Record<string, unknown>;
  return row;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new RiverError(`${name} must be a string`);
}

function checkInteger(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RiverError(`${name} must be a whole number`);
  }
}

function checkLimit(value: unknown, name: string): number {
  checkInteger(value, name);
  if ((value as number) < 1) throw new RiverError(`${name} must be at least 1`);
  return value as number;
}

function checkKind(value: unknown): asserts value is RiverKind {
  if (typeof value !== "string" || !KIND_SET.has(value)) throw new RiverError(`unknown kind: ${String(value)}`);
}

function checkSource(value: unknown): asserts value is RiverSource {
  if (typeof value !== "string" || !SOURCE_SET.has(value)) throw new RiverError(`unknown source: ${String(value)}`);
}

function checkTombstone(row: TombstoneInput): void {
  if (typeof row !== "object" || row === null) throw new RiverError("tombstone must be an object");
  checkInteger(row.atMs, "atMs");
  if (row.by !== "owner" && row.by !== "self" && row.by !== "body") {
    throw new RiverError('tombstone: "by" must be "owner", "self" or "body"');
  }
  if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) {
    throw new RiverError("tombstone: data must be an object");
  }
  try {
    JSON.stringify(row.data);
  } catch {
    throw new RiverError("tombstone: data must be JSON-serializable");
  }
}

function checkNow(nowMs: () => number): number {
  const now = nowMs();
  checkInteger(now, "nowMs()");
  return now;
}

function checkInput(row: RiverRowInput, nowMs: () => number): CheckedInput {
  if (typeof row !== "object" || row === null) throw new RiverError("row must be an object");
  requireString(row.thread, "thread");
  if (row.thread.trim() === "") throw new RiverError("thread must not be blank");
  checkKind(row.kind);
  checkSource(row.source);
  if (row.kind === "tombstone") throw new RiverError("tombstones are written only by forget");
  if (row.place !== undefined) requireString(row.place, "place");
  if (row.actor !== undefined) requireString(row.actor, "actor");
  if (row.text !== undefined) requireString(row.text, "text");

  let dataJson: string | null = null;
  if (row.data !== undefined) {
    if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) {
      throw new RiverError("data must be an object");
    }
    try {
      dataJson = JSON.stringify(row.data);
    } catch {
      throw new RiverError("data must be JSON-serializable");
    }
  }

  const atMs = row.atMs ?? checkNow(nowMs);
  checkInteger(atMs, "atMs");

  const checked: CheckedInput = {
    atMs,
    thread: row.thread,
    kind: row.kind,
    source: row.source,
    dataJson,
  };
  if (row.place !== undefined) checked.place = row.place;
  if (row.actor !== undefined) checked.actor = row.actor;
  if (row.text !== undefined) checked.text = row.text;
  return checked;
}

/** The form forget and the notebook compare text in: NFKC and lower case. */
function foldText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The words of a forget, folded. Empty when there are none. */
function forgetWords(text: string): string[] {
  return foldText(text)
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** True when the folded text holds every word. */
function holdsWords(folded: string, words: readonly string[]): boolean {
  return words.length > 0 && words.every((word) => folded.includes(word));
}

/** Words of a search, with pure punctuation dropped. Shared by the FTS and LIKE paths. */
function searchTerms(text: string): string[] {
  return text.split(/\s+/).filter((term) => /[\p{L}\p{N}]/u.test(term));
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
