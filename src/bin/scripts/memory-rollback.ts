// `natalis memory-rollback --dir <entity folder> [--scan <folder>]`: the code-only rollback of the memory stores.
// It takes the Lar lock, completes every pending forget cascade (or refuses and changes nothing), refuses a table no
// known store owns, completes/drains pending work and empties every other derived table in one transaction, rebuilds
// the file and truncates its WAL, then deletes grants.db and the per-Lar HMAC key and lists the backups and replay
// copies made while the new code ran.
// It never touches rows, river_fts, the ledger tables, user_version, the notebook, or any backup by itself.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { grantsPath } from "../../entity/grants.js";
import { acquireLarLock, LarLockBusy } from "../../entity/lar-lock.js";
import { threadHashKeyPath } from "../../river/thread-key.js";
import { BASE_061AF27_RIVER_DB, SQLITE_STAT_TABLES } from "../../river/base-tables.js";
import {
  derivedTableNames,
  derivedTablesToEmpty,
  drainPendingCascades,
  fts5ShadowTables,
  PENDING_CASCADE_TABLE,
  pendingCascadeCount,
  type OutsideCascade,
} from "../../river/derived.js";
import { parseFlags, UsageError } from "../commands/shared.js";

export const MEMORY_ROLLBACK_USAGE = "Usage: natalis memory-rollback --dir <entity folder> [--scan <folder>]";

export type MemoryRollbackOptions = {
  /** The Lar's own folder. */
  dir: string;
  /** Extra folders to scan for backups and replay copies; the Lar folder is always scanned. */
  scan?: readonly string[];
  /** Outside stores that may have pending work; defaults to the registered list. */
  outsideCascades?: readonly OutsideCascade[];
  /** Test hooks for the two rerun cases; a live run leaves them out. */
  hooks?: {
    /** Called after the derived DELETE has committed, before VACUUM. */
    afterDelete?: () => void;
    /** Called after grants.db is gone, before the key file. */
    afterGrantsRemoved?: () => void;
  };
};

export type MemoryRollbackResult = {
  /** Each derived table that existed and how many rows it held before the clear. */
  derived: Array<{ table: string; erased: number }>;
  /** Pending forget cascades completed before the clear. */
  pendingDrained: number;
  /** Backup and replay copy river.db files made while the new code ran, for the operator to delete or scrub. */
  scrub: string[];
  grantsDeleted: boolean;
  keyDeleted: boolean;
  /** Unchanged by this script; read so the caller can check it. */
  userVersion: number;
  wal: { busy: number; log: number; checkpointed: number };
};

/** The rollback itself. Throws on anything it refuses; nothing in river.db is changed before a refusal. */
export async function runMemoryRollback(options: MemoryRollbackOptions): Promise<MemoryRollbackResult> {
  const dir = resolve(options.dir);
  const riverFile = join(dir, "river.db");
  if (!existsSync(riverFile)) throw new Error(`No river.db in ${dir}; there is nothing to roll back.`);

  const lock = acquireLarLock(dir);
  try {
    const db = new DatabaseSync(riverFile, { timeout: 0 });
    let result: MemoryRollbackResult;
    try {
      db.exec("PRAGMA busy_timeout = 0");
      const tables = tableNames(db);
      if (!tables.includes("rows")) throw new Error(`${riverFile} has no rows table; this is not a river. Nothing was changed.`);
      const version = userVersionOf(db);
      if (version !== 1) {
        throw new Error(
          `The river has schema version ${version}; 061af27 reads version 1 and would refuse it. Nothing was changed.`,
        );
      }

      // A record that cannot be completed stops the rollback before any DELETE. Never empty one by deletion.
      // This comes before the table check, as the packet's order says: finish the forgets first, then judge the schema.
      const pendingDrained = drainPendingCascades(db, dir, options.outsideCascades);
      if (pendingCascadeCount(db) !== 0) {
        throw new Error("A pending forget cascade is still waiting. Nothing was changed.");
      }

      const unknown = unknownTables(tables);
      if (unknown.length > 0) {
        throw new Error(
          `The river has table(s) no known memory store owns: ${unknown.join(", ")}. Nothing was changed.`,
        );
      }

      const ftsTables = virtualFtsTables(db);
      const shadowTables = new Set(ftsTables.flatMap((name) => fts5ShadowTables(name)));
      const toEmpty = derivedTablesToEmpty().filter(
        (name) => name !== PENDING_CASCADE_TABLE && tableExists(db, name) && !shadowTables.has(name),
      );
      const derived: Array<{ table: string; erased: number }> = [];
      db.exec("PRAGMA secure_delete = ON");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const name of toEmpty) {
          const before = rowCount(db, name);
          db.prepare(`DELETE FROM ${quote(name)}`).run();
          derived.push({ table: name, erased: before });
        }
        // FTS keeps removed terms until it is told to merge; that is the river's own forget order.
        for (const name of ftsTables) {
          if (!derivedTableNames().includes(name)) continue;
          db.exec(`INSERT INTO ${quote(name)} (${quote(name)}) VALUES ('optimize')`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      options.hooks?.afterDelete?.();

      db.exec("VACUUM");
      const checkpoint = checkpointWal(db);
      const userVersion = userVersionOf(db);
      result = {
        derived,
        pendingDrained,
        scrub: listScrubbable(scanRoots(dir, options.scan ?? []), riverFile),
        grantsDeleted: false,
        keyDeleted: false,
        userVersion,
        wal: checkpoint,
      };
    } finally {
      db.close();
    }

    const grants = grantsPath(dir);
    const grantsDeleted = existsSync(grants);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${grants}${suffix}`, { force: true });
    options.hooks?.afterGrantsRemoved?.();
    const key = threadHashKeyPath(dir);
    const keyDeleted = existsSync(key);
    rmSync(key, { force: true });

    return { ...result, grantsDeleted, keyDeleted };
  } finally {
    lock.release();
  }
}

/** The command line. Counts and paths only; a forgotten word is never printed. */
export async function memoryRollbackCommand(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let flags;
  try {
    flags = parseFlags([...args], ["--dir", "--scan"], []);
  } catch (error) {
    if (error instanceof UsageError) {
      err(error.message);
      err(MEMORY_ROLLBACK_USAGE);
      return 2;
    }
    throw error;
  }
  const dir = flags.values.get("--dir");
  if (dir === undefined || dir.trim() === "") {
    err("--dir is missing: give the entity's folder.");
    err(MEMORY_ROLLBACK_USAGE);
    return 2;
  }
  const scan = flags.values.get("--scan");
  try {
    const result = await runMemoryRollback({
      dir: resolve(dir),
      ...(scan === undefined ? {} : { scan: [resolve(scan)] }),
    });
    const emptied = result.derived.reduce((sum, table) => sum + table.erased, 0);
    out(
      `Emptied ${result.derived.length} derived table(s) (${emptied} row(s)); user_version is unchanged at ${result.userVersion}.`,
    );
    if (result.pendingDrained > 0) out(`Completed ${result.pendingDrained} pending forget cascade(s) first.`);
    out(`Checked the WAL: busy ${result.wal.busy}, log ${result.wal.log}, checkpointed ${result.wal.checkpointed}.`);
    if (result.grantsDeleted) out("Deleted grants.db.");
    if (result.keyDeleted) out("Deleted the per-Lar HMAC key (thread-hash.key).");
    if (result.scrub.length === 0) {
      out("No backup or replay copy made while the new code ran was found.");
    } else {
      out("Delete or scrub these files: they were made while the new code ran and hold the derived tables.");
      for (const path of result.scrub) out(path);
    }
    return 0;
  } catch (error) {
    if (error instanceof LarLockBusy) {
      err(error.message);
      return 1;
    }
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function unknownTables(tables: readonly string[]): string[] {
  const allowed = new Set<string>([
    ...BASE_061AF27_RIVER_DB,
    ...SQLITE_STAT_TABLES,
    ...derivedTableNames(),
  ]);
  return tables.filter((name) => !allowed.has(name) && !/^sqlite_stat[0-9]+$/.test(name));
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n);
}

function virtualFtsTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%USING fts5%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function checkpointWal(db: DatabaseSync): { busy: number; log: number; checkpointed: number } {
  // A river is WAL; a database restored into the default journal has no WAL to fold in.
  const journal = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode ?? "").toLowerCase();
  if (journal !== "wal") return { busy: 0, log: 0, checkpointed: 0 };

  let row: { busy?: number; log?: number; checkpointed?: number } | undefined;
  try {
    row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as typeof row;
  } catch (error) {
    throw new Error(`The WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const busy = Number(row?.busy ?? -1);
  const log = Number(row?.log ?? -1);
  const checkpointed = Number(row?.checkpointed ?? -1);
  if (busy !== 0 || log !== 0 || checkpointed !== 0) {
    throw new Error(
      `The WAL checkpoint did not finish (busy ${busy}, log ${log}, checkpointed ${checkpointed}). A reader may still hold the river; stop it and run this again.`,
    );
  }
  return { busy, log, checkpointed };
}

function userVersionOf(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/**
 * The folders to scan: the Lar folder and any given one, plus the deploy's own backup folder when the Lar sits beside
 * it (~/lares/<name> and ~/lar-backups). A folder that is not there is skipped.
 */
function scanRoots(dir: string, extra: readonly string[]): string[] {
  const roots = [dir, ...extra.map((path) => resolve(path))];
  if (basename(dirname(dir)) === "lares") {
    const backups = resolve(dirname(dir), "..", "lar-backups");
    if (existsSync(backups)) roots.push(backups);
  }
  return roots;
}

/** Backup and replay river.db files under the given folders whose schema has any derived table. */
function listScrubbable(roots: readonly string[], ownRiver: string): string[] {
  const own = resolve(ownRiver);
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const root of roots) walk(resolve(root));

  function walk(folder: string): void {
    if (seen.has(folder)) return;
    seen.add(folder);
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== "river.db") continue;
      const file = resolve(path);
      if (file === own) continue;
      if (hasDerivedTable(file)) found.add(file);
    }
  }

  return [...found].sort();
}

function hasDerivedTable(file: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    return derivedTableNames().some((name) => names.has(name));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// The packet's rollback order runs this file directly: node dist/bin/scripts/memory-rollback.js --dir <folder>.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  memoryRollbackCommand(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`natalis memory-rollback: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
