// Copies an entity for a replay, so the original is never touched. The copy is cut back to the moment the replay
// starts: river rows at or after that time are removed, the notebook is reset to its last commit before that time,
// and state.json is made to match. Otherwise the replay would meet events and notes it is about to produce itself.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseEntityConfig, ENTITY_FILE } from "../entity/config.js";
import { STATE_FILE } from "../entity/runtime.js";
import { NOTEBOOK_DIR, RIVER_FILE } from "../import/folder.js";

export type CopyOptions = {
  /** The entity folder to copy. Read only. */
  from: string;
  /** The new folder. Must not exist, or be empty. */
  to: string;
  /** The replay's first event time. The copy keeps only what came before it. Give this or cutAtSeq, not both. */
  cutAtMs?: number;
  /**
   * Fork at river row N: the copy keeps the rows before seq N, and the notebook and state are cut at row N's time.
   * Only the copy changes; this is a replay, never a pause of the live Lar.
   */
  cutAtSeq?: number;
  /** A replacement entity.json. Validated; the original is not copied. */
  configPath?: string;
};

export type CopyResult = { lastSeq: number; notebookCommit?: string };

export async function copyForReplay(options: CopyOptions): Promise<CopyResult> {
  const from = options.from;
  if (!existsSync(join(from, RIVER_FILE))) throw new Error(`No ${RIVER_FILE} in ${from}: nothing to replay.`);
  if (!existsSync(join(from, STATE_FILE))) {
    throw new Error(`No ${STATE_FILE} in ${from}. Start the entity once before replaying it.`);
  }
  const replacement = options.configPath === undefined ? undefined : readConfig(options.configPath);
  if (replacement === undefined && !existsSync(join(from, ENTITY_FILE))) {
    throw new Error(`No ${ENTITY_FILE} in ${from}. Give --config with a model block to replay it.`);
  }
  if (options.cutAtMs !== undefined && options.cutAtSeq !== undefined) throw new Error("Give a cut time or a fork row, not both.");
  const cutAtMs = options.cutAtSeq === undefined ? options.cutAtMs : rowTime(join(from, RIVER_FILE), options.cutAtSeq);
  if (cutAtMs === undefined) throw new Error("Give a cut time or a fork row.");
  if (options.cutAtSeq !== undefined) refuseLaterRows(join(from, RIVER_FILE), options.cutAtSeq, cutAtMs);
  prepareEmpty(options.to);

  // The river: a consistent copy through SQLite, never a file copy of a database that may be live.
  const target = join(options.to, RIVER_FILE);
  const source = new DatabaseSync(join(from, RIVER_FILE), { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(target);
  } finally {
    source.close();
  }
  const lastSeq = options.cutAtSeq === undefined ? cutRiver(target, cutAtMs) : cutRiverAtSeq(target, options.cutAtSeq);

  // The notebook: a clone, reset to the last commit made before the cut.
  const notebookCommit = await cloneNotebookAt(join(from, NOTEBOOK_DIR), join(options.to, NOTEBOOK_DIR), cutAtMs);

  // The state file: cursors and asks cannot point past the cut.
  writeState(join(from, STATE_FILE), join(options.to, STATE_FILE), target, lastSeq, cutAtMs);

  // The config: the original, or the replacement the replay was given.
  const configText =
    replacement === undefined ? readFileSync(join(from, ENTITY_FILE), "utf8") : `${JSON.stringify(replacement, null, 2)}\n`;
  writeFileSync(join(options.to, ENTITY_FILE), configText, "utf8");

  return notebookCommit === undefined ? { lastSeq } : { lastSeq, notebookCommit };
}

/** The time of river row `seq` in a river file, read only. Throws when there is no such row. */
export function rowTime(file: string, seq: number): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = Number.isInteger(seq) && seq > 0 ? (db.prepare("SELECT at_ms FROM rows WHERE seq = ?").get(seq) as { at_ms: number } | undefined) : undefined;
    if (row === undefined) throw new Error(`The river has no row ${seq} to fork at.`);
    return Number(row.at_ms);
  } finally {
    db.close();
  }
}

/**
 * A fork keeps the rows before seq N and cuts the notebook at row N's time. A kept row dated after that time (imported
 * or out of order) would sit in the copy beside a notebook from before it, so the fork is refused (NIT-3).
 */
function refuseLaterRows(file: string, seq: number, cutAtMs: number): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(seq) AS first FROM rows WHERE seq < ? AND at_ms > ?").get(seq, cutAtMs) as { n: number; first: number | null };
    if (Number(row.n) > 0) {
      throw new Error(`${row.n} row(s) before row ${seq} are dated after it (first: row ${row.first}), so a fork there would mix times. Fork at another row.`);
    }
  } finally {
    db.close();
  }
}

/** Removes river rows with seq N or later from the copy and returns the new last seq. */
export function cutRiverAtSeq(file: string, seq: number): number {
  return cutRiverWhere(file, "seq >= ?", seq);
}

/** Removes river rows at or after `cutAtMs` from the copy and returns the new last seq. Then vacuums the freed pages. */
export function cutRiver(file: string, cutAtMs: number): number {
  return cutRiverWhere(file, "at_ms >= ?", cutAtMs);
}

function cutRiverWhere(file: string, where: string, value: number): number {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA secure_delete = ON");
    const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'river_fts'").get() !== undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (hasFts) db.prepare(`DELETE FROM river_fts WHERE rowid IN (SELECT seq FROM rows WHERE ${where})`).run(value);
      db.prepare(`DELETE FROM rows WHERE ${where}`).run(value);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    db.exec("VACUUM");
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM rows").get() as { last: number };
    return Number(row.last);
  } finally {
    db.close();
  }
}

/** The state the copy starts with: cursors capped at the cut, asks past the cut dropped, no wakes, owner time recomputed. */
function writeState(fromState: string, toState: string, riverFile: string, lastSeq: number, cutAtMs: number): void {
  const raw = JSON.parse(readFileSync(fromState, "utf8")) as Record<string, unknown>;
  const threads: Record<string, { seenSeq: number; lastTurnMs?: number }> = {};
  for (const [thread, value] of Object.entries((raw["threads"] ?? {}) as Record<string, { seenSeq: number; lastTurnMs?: number }>)) {
    const seenSeq = Math.min(Number(value.seenSeq), lastSeq);
    // A turn that happened after the cut has not happened yet in the replay, so its time is dropped.
    const keepTurn = value.lastTurnMs !== undefined && value.lastTurnMs < cutAtMs;
    threads[thread] = keepTurn ? { seenSeq, lastTurnMs: value.lastTurnMs as number } : { seenSeq };
  }
  const asks = ((raw["asks"] ?? []) as Array<{ seq: number }>).filter((ask) => ask.seq <= lastSeq);
  const state: Record<string, unknown> = {
    lastSeq,
    threads,
    asks,
    wakes: [],
    mood: raw["mood"] ?? null,
  };
  const lastOwnerMs = newestOwnerMs(riverFile);
  if (lastOwnerMs !== undefined) state["lastOwnerMs"] = lastOwnerMs;
  const tmp = `${toState}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, toState);
}

function newestOwnerMs(riverFile: string): number | undefined {
  const db = new DatabaseSync(riverFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT MAX(at_ms) AS newest FROM rows WHERE source = 'owner'").get() as { newest: number | null };
    return row.newest === null ? undefined : Number(row.newest);
  } finally {
    db.close();
  }
}

/**
 * Clones the notebook and resets the clone to its last commit made before `cutAtMs`. When nothing was committed
 * before the cut, no clone is made and the replay's entity seeds a fresh notebook.
 */
async function cloneNotebookAt(source: string, target: string, cutAtMs: number): Promise<string | undefined> {
  if (!existsSync(join(source, ".git"))) return undefined;
  const iso = `${new Date(cutAtMs).toISOString().slice(0, 19)}Z`;
  const before = await git(source, ["rev-list", "-n", "1", `--before=${iso}`, "HEAD"]).catch(() => "");
  if (before === "") return undefined;
  await git(undefined, ["clone", "--quiet", "--no-hardlinks", source, target]);
  await git(target, ["reset", "--hard", "--quiet", before]);
  return before;
}

function git(cwd: string | undefined, args: string[]): Promise<string> {
  const fullArgs = cwd === undefined ? args : ["-C", cwd, ...args];
  return new Promise((resolveRun, rejectRun) => {
    execFile("git", fullArgs, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolveRun(String(stdout).trim());
    });
  });
}

function readConfig(path: string): unknown {
  if (!existsSync(path)) throw new Error(`No config at ${path}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`The config at ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  // Validate now, so a bad replacement stops before anything is copied.
  parseEntityConfig(parsed);
  return parsed;
}

function prepareEmpty(dir: string): void {
  if (existsSync(dir)) {
    if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty. Choose a new output folder.`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
}
