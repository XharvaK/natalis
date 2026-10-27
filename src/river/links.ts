// Links between her notes: one note to another, with a relation she chose, her reason and the river row of the turn
// that wrote it. Keys are notebook paths, never SHAs (a forget rebuilds history and changes every SHA). A link is
// written only by her own tool call; the body never writes one, and a supersedes link is hers alone. The rows live in
// river.db as a derived store, so a forget erases them in the river's own transaction. A note moved to trash/ loses
// every link to or from it, and a forget rename repairs or drops the links that named the old path.

import { DatabaseSync } from "node:sqlite";
import type { DerivedStore } from "./derived.js";

export const LINKS_TABLE = "links";

/** The relations she may name. "supersedes" is the one that can hide a live truth, so only she may set it. */
export const LINK_RELATIONS = ["supports", "contradicts", "supersedes", "elaborates"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
export type LinkAuthor = "self" | "body";

const LINKS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${LINKS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  thread TEXT NOT NULL,
  from_note TEXT,
  to_note TEXT,
  relation TEXT CHECK (relation IS NULL OR relation IN ('supports', 'contradicts', 'supersedes', 'elaborates')),
  reason TEXT,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('self', 'body')),
  forgotten INTEGER NOT NULL DEFAULT 0,
  forgotten_why TEXT,
  CHECK (forgotten = 1 OR (from_note IS NOT NULL AND to_note IS NOT NULL AND relation IS NOT NULL AND reason IS NOT NULL)),
  CHECK (relation IS NULL OR relation <> 'supersedes' OR author = 'self')
)`;

const LINKS_FROM_INDEX = `CREATE INDEX IF NOT EXISTS links_from_note ON ${LINKS_TABLE}(from_note)`;
const LINKS_TO_INDEX = `CREATE INDEX IF NOT EXISTS links_to_note ON ${LINKS_TABLE}(to_note)`;

/** One link as she reads it: two note paths, the relation, her reason and the river row it came from. */
export type LinkRecord = {
  id: number;
  atMs: number;
  thread: string;
  from: string;
  to: string;
  relation: LinkRelation;
  reason: string;
  seq: number;
  author: LinkAuthor;
};

export type NewLink = {
  thread: string;
  from: string;
  to: string;
  relation: LinkRelation;
  reason: string;
  seq: number;
  atMs: number;
  author: LinkAuthor;
};

/** What a rename did to the links that named the old path. */
export type RenameRepair = { repaired: number; dropped: number };

export interface LinkStore {
  record(link: NewLink): LinkRecord;
  /** Drops every active link to or from a note moved to trash/. Returns how many were dropped. */
  dropForNote(note: string): number;
  /** Repoints links that named a renamed note; drops the ones that break or would duplicate another link. */
  repairRename(from: string, to: string): RenameRepair;
  close(): void;
}

export class LinksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinksError";
  }
}

type StoredLink = {
  id: number;
  at_ms: number;
  thread: string;
  from_note: string | null;
  to_note: string | null;
  relation: string | null;
  reason: string | null;
  seq: number;
  author: string;
  forgotten: number;
  forgotten_why: string | null;
};

/** Opens the links in the river file. Close it when the Lar stops. */
export function openLinks(riverPath: string): LinkStore {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(LINKS_SCHEMA);
    db.exec(LINKS_FROM_INDEX);
    db.exec(LINKS_TO_INDEX);
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    `INSERT INTO ${LINKS_TABLE} (at_ms, thread, from_note, to_note, relation, reason, seq, author)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(`SELECT * FROM ${LINKS_TABLE} WHERE id = ?`);
  const dropTrash = db.prepare(
    `UPDATE ${LINKS_TABLE}
     SET from_note = NULL, to_note = NULL, relation = NULL, reason = NULL, forgotten = 1, forgotten_why = 'trash'
     WHERE forgotten = 0 AND (from_note = ? OR to_note = ?)`,
  );
  const unnamed = db.prepare(
    `UPDATE ${LINKS_TABLE}
     SET from_note = NULL, to_note = NULL, relation = NULL, reason = NULL, forgotten = 1, forgotten_why = ?
     WHERE id = ?`,
  );
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new LinksError("the links are closed");
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

  return {
    record(link: NewLink): LinkRecord {
      ensureOpen();
      checkNewLink(link);
      const info = insert.run(
        link.atMs,
        link.thread,
        link.from,
        link.to,
        link.relation,
        link.reason,
        link.seq,
        link.author,
      );
      const row = get.get(Number(info.lastInsertRowid)) as StoredLink | undefined;
      if (row === undefined) throw new LinksError("the link was written but could not be read back");
      return toRecord(row);
    },

    dropForNote(note: string): number {
      ensureOpen();
      checkNote(note, "note");
      return Number(dropTrash.run(note, note).changes);
    },

    repairRename(from: string, to: string): RenameRepair {
      ensureOpen();
      checkNote(from, "from");
      checkNote(to, "to");
      if (from === to) return { repaired: 0, dropped: 0 };
      return inTransaction(() => {
        const named = db
          .prepare(
            `SELECT id, from_note, to_note, relation FROM ${LINKS_TABLE}
             WHERE forgotten = 0 AND (from_note = ? OR to_note = ?) ORDER BY id`,
          )
          .all(from, from) as unknown as Array<{
          id: number;
          from_note: string;
          to_note: string;
          relation: LinkRelation;
        }>;
        const duplicate = db.prepare(
          `SELECT 1 AS one FROM ${LINKS_TABLE}
           WHERE forgotten = 0 AND id <> ? AND from_note = ? AND to_note = ? AND relation = ? LIMIT 1`,
        );
        const repoint = db.prepare(`UPDATE ${LINKS_TABLE} SET from_note = ?, to_note = ? WHERE id = ?`);
        let repaired = 0;
        let dropped = 0;
        for (const row of named) {
          const nextFrom = row.from_note === from ? to : row.from_note;
          const nextTo = row.to_note === from ? to : row.to_note;
          // A link that would now point at itself, or copy a link that already exists, is dropped rather than guessed.
          if (nextFrom === nextTo || duplicate.get(row.id, nextFrom, nextTo, row.relation) !== undefined) {
            unnamed.run("rename", row.id);
            dropped += 1;
            continue;
          }
          repoint.run(nextFrom, nextTo, row.id);
          repaired += 1;
        }
        return { repaired, dropped };
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * The links store's part of the U8 cascade. A forgotten source seq drops the whole link; a text forget reaches a link
 * through its own words (the two note paths and her reason), even when no river row matched. The row stays as its own
 * tombstone: the note names, relation and reason are blank, and `forgotten_why` says which kind of forget reached it.
 */
export const linksDerivedStore: DerivedStore = {
  tables: [LINKS_TABLE],
  schema: [LINKS_SCHEMA, LINKS_FROM_INDEX, LINKS_TO_INDEX],
  cascade(db: DatabaseSync, forget): number {
    if (forget.seqs.length === 0 && forget.words.length === 0) return 0;
    const seqs = new Set(forget.seqs);
    const rows = db
      .prepare(`SELECT id, from_note, to_note, reason, seq FROM ${LINKS_TABLE} WHERE forgotten = 0`)
      .all() as unknown as Array<{ id: number; from_note: string; to_note: string; reason: string; seq: number }>;
    const drop = db.prepare(
      `UPDATE ${LINKS_TABLE}
       SET from_note = NULL, to_note = NULL, relation = NULL, reason = NULL, forgotten = 1, forgotten_why = ?
       WHERE id = ?`,
    );
    let erased = 0;
    for (const row of rows) {
      const bySeq = seqs.has(Number(row.seq));
      const byText = holdsWords(`${row.from_note}\n${row.to_note}\n${row.reason}`, forget.words);
      if (!bySeq && !byText) continue;
      drop.run(bySeq ? "source" : "text", row.id);
      erased += 1;
    }
    return erased;
  },
};

function toRecord(row: StoredLink): LinkRecord {
  if (row.from_note === null || row.to_note === null || row.relation === null || row.reason === null) {
    throw new LinksError(`link ${row.id} has no names`);
  }
  return {
    id: Number(row.id),
    atMs: Number(row.at_ms),
    thread: row.thread,
    from: row.from_note,
    to: row.to_note,
    relation: row.relation as LinkRelation,
    reason: row.reason,
    seq: Number(row.seq),
    author: row.author as LinkAuthor,
  };
}

function holdsWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const folded = text.normalize("NFKC").toLowerCase();
  return words.every((word) => folded.includes(word));
}

function checkNewLink(link: NewLink): void {
  if (typeof link !== "object" || link === null) throw new LinksError("a link must be an object");
  if (typeof link.thread !== "string" || link.thread.trim() === "") throw new LinksError("thread must not be blank");
  checkNote(link.from, "from");
  checkNote(link.to, "to");
  if (!LINK_RELATIONS.includes(link.relation)) throw new LinksError(`relation must be one of ${LINK_RELATIONS.join(", ")}`);
  if (typeof link.reason !== "string" || link.reason.trim() === "") throw new LinksError("a link needs her reason");
  checkSeq(link.seq, "seq");
  checkTime(link.atMs, "atMs");
  if (link.author !== "self" && link.author !== "body") throw new LinksError("author must be self or body");
  if (link.relation === "supersedes" && link.author !== "self") {
    throw new LinksError("Only she may say that one note replaces another; nothing was written.");
  }
  if (link.author !== "self") throw new LinksError("Only she can make a link; nothing was written.");
}

function checkNote(note: unknown, name: string): asserts note is string {
  if (typeof note !== "string" || note.trim() === "") throw new LinksError(`${name} must be a note path`);
}

function checkSeq(seq: unknown, name: string): asserts seq is number {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new LinksError(`${name} must be a whole number`);
}

function checkTime(atMs: unknown, name: string): asserts atMs is number {
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) throw new LinksError(`${name} must be a whole number`);
}
