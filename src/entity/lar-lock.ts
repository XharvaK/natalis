// One natalis process per Lar folder. The river, notebook and state are written by one process at a time, so
// run, forget and restore take this lock before they touch a Lar. The lock is a SQLite database opened in
// exclusive locking mode and held until release(); the info file beside it only says who holds it, never who may.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LAR_LOCK_DATABASE_FILE = "lar.lock.db";
export const LAR_LOCK_INFO_FILE = "lar.lock.info";
export const LAR_LOCK_BUSY_MESSAGE =
  "This Lar is already in use by another natalis process (run, forget, restore...). Stop it first.";

/** Thrown when another process (or another acquire in this one) holds the Lar's folder lock. */
export class LarLockBusy extends Error {
  constructor(message: string = LAR_LOCK_BUSY_MESSAGE) {
    super(message);
    this.name = "LarLockBusy";
  }
}

/** What lar.lock.info says. It is only for people reading the folder; the lock itself is the database. */
export type LarLockInfo = {
  pid: number;
  startedAt: string;
  token: string;
  host: string;
};

export type LarLock = {
  readonly dir: string;
  readonly databasePath: string;
  readonly infoPath: string;
  readonly info: LarLockInfo;
  /** Closes the database, which releases the lock. Calling it twice does nothing. */
  release(): void;
};

/** The locks this process holds, by resolved folder. A second acquire here is refused, not granted. */
const heldHere = new Map<string, LarLock>();

/**
 * Takes the lock on `dir` and keeps it until release(). Throws LarLockBusy when another process holds it.
 * The database uses the delete journal, never WAL, so a crash leaves no extra files holding a stale lock.
 */
export function acquireLarLock(dir: string): LarLock {
  const folder = resolve(dir);
  if (heldHere.has(folder)) throw new LarLockBusy();

  const databasePath = join(folder, LAR_LOCK_DATABASE_FILE);
  const infoPath = join(folder, LAR_LOCK_INFO_FILE);
  const startedAt = new Date().toISOString();
  const database = openExclusiveLockDatabase(databasePath, startedAt);

  const info: LarLockInfo = {
    pid: process.pid,
    startedAt,
    token: randomBytes(16).toString("hex"),
    host: hostname(),
  };
  let released = false;
  const lock: LarLock = {
    dir: folder,
    databasePath,
    infoPath,
    info,
    release() {
      if (released) return;
      released = true;
      heldHere.delete(folder);
      database.close();
    },
  };

  heldHere.set(folder, lock);
  try {
    writeFileSync(infoPath, `${JSON.stringify(info)}\n`, "utf8");
  } catch (error) {
    lock.release();
    throw error;
  }
  return lock;
}

/** Opens the lock database and holds an exclusive lock on it. On failure the connection is closed again. */
function openExclusiveLockDatabase(databasePath: string, startedAt: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { timeout: 0 });
    // Never WAL: the delete journal leaves no extra file behind after a crash. Set it before any lock is taken.
    const journal = database.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "delete") {
      throw new Error(`the Lar lock at ${databasePath} could not leave the ${journal?.journal_mode ?? "unknown"} journal mode`);
    }
    // Waits no time at all: a busy folder is refused now, never after a pause.
    database.exec("PRAGMA busy_timeout = 0");
    const locking = database.prepare("PRAGMA locking_mode = EXCLUSIVE").get() as { locking_mode?: string } | undefined;
    if (locking?.locking_mode?.toLowerCase() !== "exclusive") {
      throw new Error(`the Lar lock at ${databasePath} could not take exclusive locking mode`);
    }

    database.exec("BEGIN EXCLUSIVE");
    try {
      // A real write, so the exclusive lock is taken before we say the folder belongs to us.
      database.exec("CREATE TABLE IF NOT EXISTS lock_holder (pid INTEGER NOT NULL, started_at TEXT NOT NULL)");
      database.exec("DELETE FROM lock_holder");
      database.prepare("INSERT INTO lock_holder (pid, started_at) VALUES (?, ?)").run(process.pid, startedAt);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The transaction is already gone; the original error is the one worth showing.
      }
      throw error;
    }
    // locking_mode = EXCLUSIVE keeps the lock after COMMIT until this connection closes.
    return database;
  } catch (error) {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // The connection is already unusable; the operating system releases its locks with the process.
      }
    }
    if (isBusy(error)) throw new LarLockBusy();
    throw error;
  }
}

/** True for SQLITE_BUSY and SQLITE_LOCKED, including their extended codes. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as Error & { errcode?: unknown }).errcode;
  if (typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) return true;
  return /database (?:table )?is locked|SQLITE_(?:BUSY|LOCKED)/i.test(error.message);
}
