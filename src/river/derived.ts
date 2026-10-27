// The forget cascade for every derived store. A derived store lives in river.db as its own tables and registers one
// cascade function; that function runs inside the river's forget transaction, so an erase either lands in the river and
// every derived store together, or in neither. Derived stores that cannot live in river.db register an outside cascade:
// the forget writes a pending-cascade record (seqs only, never text) in the same transaction, runs the outside store
// after the commit, and deletes the record only when the store confirms. A start replays whatever is left.
//
// U9-U12 add their stores here; the memory rollback reads the same list.

// U9-U12: import the store's module and register it from this file (not from a caller), so openRiver, the forget hook
// and the memory rollback all see the same one list.

import type { DatabaseSync } from "node:sqlite";
import { BASE_061AF27_RIVER_DB } from "./base-tables.js";
import { factsDerivedStore } from "./facts.js";

/** What a forget erased: the river seqs, and the folded words of a text forget (empty for a seq forget). */
export type DerivedForget = {
  seqs: readonly number[];
  words: readonly string[];
};

/** One derived store in river.db. Its tables are derived, never base; user_version does not change for them. */
export type DerivedStore = {
  /** Tables this store owns in river.db. */
  tables: readonly string[];
  /** FTS5 virtual tables this store owns; their five shadow tables are added to the derived list automatically. */
  fts?: readonly string[];
  /** CREATE ... IF NOT EXISTS statements, run on every open (the river's user_version stays 1). */
  schema: readonly string[];
  /**
   * Erase every row that cites a forgotten seq and every row whose own text holds all the words. Runs inside the
   * river's forget transaction; throwing rolls the whole forget back. Returns how many rows it erased.
   */
  cascade(db: DatabaseSync, forget: DerivedForget): number;
};

/** An outside store (not in river.db) that must finish a forget after the river's transaction commits. */
export type OutsideCascade = {
  /** The name written into the pending-cascade record. */
  store: string;
  /** Idempotent. Throw when the store did not finish; the record stays for the next start. */
  run(input: { dir: string; seqs: readonly number[] }): void;
};

/** The table holding work for outside stores. It holds seqs and a store name only, never text. */
export const PENDING_CASCADE_TABLE = "pending_cascade";

const PENDING_SCHEMA = `CREATE TABLE IF NOT EXISTS ${PENDING_CASCADE_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL,
  seqs_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL
)`;

const stores: DerivedStore[] = [];
const outside: OutsideCascade[] = [];

/** Adds a derived store to the one list the river and the rollback share. Refuses a table that is not derived. */
export function registerDerivedStore(store: DerivedStore): void {
  const own = [...store.tables, ...(store.fts ?? [])];
  const ownAndShadows = [...own];
  for (const table of store.fts ?? []) ownAndShadows.push(...fts5ShadowTables(table));
  if (own.length === 0) throw new Error("A derived store must own at least one table.");
  const known = derivedTableNames();
  for (const table of ownAndShadows) {
    if (table === PENDING_CASCADE_TABLE) throw new Error(`${table} belongs to the cascade framework, not to a store.`);
    if ((BASE_061AF27_RIVER_DB as readonly string[]).includes(table)) {
      throw new Error(`${table} belongs to 061af27 and cannot be a derived table.`);
    }
    if (known.includes(table)) throw new Error(`The derived table ${table} is already registered.`);
  }
  stores.push(store);
}

/** Every registered derived store, in registration order. */
export function derivedStores(): readonly DerivedStore[] {
  return stores;
}

/** The five shadow tables SQLite makes for an FTS5 virtual table. */
export function fts5ShadowTables(table: string): string[] {
  return ["data", "idx", "docsize", "config", "content"].map((suffix) => `${table}_${suffix}`);
}

/**
 * Every derived table SQLite may show in river.db: the pending-cascade table, each store's own tables and FTS tables,
 * and the FTS shadow tables. The base list is separate (base-tables.ts); together they are the rollback's allow-list.
 */
export function derivedTableNames(storeList: readonly DerivedStore[] = stores): string[] {
  const names = [PENDING_CASCADE_TABLE];
  for (const store of storeList) {
    for (const table of store.tables) names.push(table);
    for (const table of store.fts ?? []) {
      names.push(table);
      names.push(...fts5ShadowTables(table));
    }
  }
  return [...new Set(names)];
}

/** The derived tables a rollback empties directly; FTS shadow tables go with their virtual table. */
export function derivedTablesToEmpty(storeList: readonly DerivedStore[] = stores): string[] {
  const names = [PENDING_CASCADE_TABLE];
  for (const store of storeList) {
    names.push(...store.tables);
    names.push(...(store.fts ?? []));
  }
  return [...new Set(names)];
}

/** Creates the pending-cascade table and every registered store's tables. User_version is never touched. */
export function ensureDerivedTables(db: DatabaseSync, storeList: readonly DerivedStore[] = stores): void {
  db.exec(PENDING_SCHEMA);
  for (const store of storeList) for (const statement of store.schema) db.exec(statement);
}

/** Runs every registered store's cascade. Called inside the river's forget transaction. Returns rows erased. */
export function cascadeDerivedStores(
  db: DatabaseSync,
  forget: DerivedForget,
  storeList: readonly DerivedStore[] = stores,
): number {
  let erased = 0;
  for (const store of storeList) erased += store.cascade(db, forget);
  return erased;
}

/** True when a derived row's own text holds every word, folded the way notebook/forget.ts folds it. */
export function derivedTextHoldsWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const folded = text.normalize("NFKC").toLowerCase();
  return words.every((word) => folded.includes(word));
}

/** Adds an outside store to every future forget's queue. */
export function registerOutsideCascade(handler: OutsideCascade): void {
  if (handler.store.trim() === "") throw new Error("An outside cascade needs a store name.");
  if (outside.some((known) => known.store === handler.store)) {
    throw new Error(`The outside cascade ${handler.store} is already registered.`);
  }
  outside.push(handler);
}

/** Every registered outside store, in registration order. */
export function outsideCascades(): readonly OutsideCascade[] {
  return outside;
}

/**
 * Writes one pending record per outside store for the seqs this forget erased. Runs inside the forget transaction,
 * after the river erase, so a crash leaves either no record or a record for work the river already did. No text is
 * written: an outside store erases by the seqs.
 */
export function queuePendingCascades(
  db: DatabaseSync,
  seqs: readonly number[],
  atMs: number,
  handlers: readonly OutsideCascade[] = outside,
): number {
  if (seqs.length === 0 || handlers.length === 0) return 0;
  const seqsJson = JSON.stringify([...new Set(seqs)].sort((a, b) => a - b));
  const insert = db.prepare(`INSERT INTO ${PENDING_CASCADE_TABLE} (store, seqs_json, at_ms) VALUES (?, ?, ?)`);
  let queued = 0;
  for (const handler of handlers) {
    insert.run(handler.store, seqsJson, atMs);
    queued += 1;
  }
  return queued;
}

/** How many pending-cascade records are waiting. 0 when the table is not there (an older river). */
export function pendingCascadeCount(db: DatabaseSync): number {
  if (!tableExists(db, PENDING_CASCADE_TABLE)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${PENDING_CASCADE_TABLE}`).get() as { n: number }).n);
}

/**
 * Runs every pending record through its outside store and deletes the record only after the store confirms. Throws,
 * changing nothing in river.db, when a record names a store no handler covers or when a store throws. Returns how
 * many records were completed.
 */
export function drainPendingCascades(
  db: DatabaseSync,
  dir: string,
  handlers: readonly OutsideCascade[] = outside,
): number {
  if (!tableExists(db, PENDING_CASCADE_TABLE)) return 0;
  const records = db
    .prepare(`SELECT id, store, seqs_json FROM ${PENDING_CASCADE_TABLE} ORDER BY id`)
    .all() as unknown as Array<{ id: number; store: string; seqs_json: string }>;
  if (records.length === 0) return 0;

  const byStore = new Map(handlers.map((handler) => [handler.store, handler]));
  const work: Array<{ id: number; handler: OutsideCascade; seqs: number[] }> = [];
  for (const record of records) {
    const handler = byStore.get(record.store);
    if (handler === undefined) {
      throw new Error(
        `A pending forget cascade for ${record.store} cannot be completed here. Start the new code once to finish it, then run this again.`,
      );
    }
    const seqs = parseSeqs(record.seqs_json);
    if (seqs === undefined) throw new Error(`A pending forget cascade for ${record.store} is malformed. Nothing was changed.`);
    work.push({ id: Number(record.id), handler, seqs });
  }

  for (const item of work) item.handler.run({ dir, seqs: item.seqs });

  db.exec("BEGIN IMMEDIATE");
  try {
    const remove = db.prepare(`DELETE FROM ${PENDING_CASCADE_TABLE} WHERE id = ?`);
    for (const item of work) remove.run(item.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return work.length;
}

function parseSeqs(json: string): number[] | undefined {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return undefined;
    const seqs: number[] = [];
    for (const seq of value) {
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return undefined;
      seqs.push(seq);
    }
    return seqs;
  } catch {
    return undefined;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

// U9: her facts. Registered here, not by a caller, so openRiver, the forget hook and the memory rollback share it.
registerDerivedStore(factsDerivedStore);
