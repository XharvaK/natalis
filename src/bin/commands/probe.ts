// `natalis probe --dir <entity folder> [--turns N]`: a health probe that prints numbers and booleans only.
// It reads the Lar's folder without writing anything there: no lock, no migration, no checkpoint, no sidecar.
// The sizes, flags, counts and the ledger's cache share are enough for an operator to see how a Lar is doing
// without opening a note, a river row or a vault value.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { flagValue } from "./args.js";

export const PROBE_USAGE = "Usage: natalis probe --dir <entity folder> [--turns N]";
export const DEFAULT_PROBE_TURNS = 50;
const DAY_MS = 86_400_000;
const STATE_FILE = "state.json";
const KNOWN_THREAD_KINDS: ReadonlySet<string> = new Set(["summoner", "contact", "room", "game", "self", "other"]);

export type ProbeReport = {
  life: { codePoints: number; headings: number };
  character: { codePoints: number };
  river: { rows: number; dbBytes: number; walBytes: number; shmBytes: number };
  /** Row counts of every table in the river's file other than the river's own rows and search index. */
  tables: Record<string, number>;
  stoppedCleanly: boolean;
  rhythmTagged: boolean;
  open: { asks: number; wakes: number; grants: number; requests: number };
  ledger: { turns: number; measuredTurns: number; cacheShare: number; turnsPerDay: Record<string, number> };
};

type EmptyLedger = ProbeReport["ledger"];

/** The probe command. Returns the exit code; output goes to the writers given. */
export async function probeCommand(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(PROBE_USAGE);
    return 2;
  }
  const turnsText = flagValue(args, "--turns") ?? String(DEFAULT_PROBE_TURNS);
  if (!/^[1-9][0-9]*$/.test(turnsText)) {
    err("--turns takes a whole number of turns, 1 or more.");
    err(PROBE_USAGE);
    return 2;
  }
  const turns = Number(turnsText);
  if (!Number.isSafeInteger(turns)) {
    err("--turns takes a whole number of turns, 1 or more.");
    err(PROBE_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    err(`There is no folder at ${dir}.`);
    return 1;
  }
  try {
    const report = probeFolder(dir, turns);
    out(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    err(`natalis: ${messageOf(error)}`);
    return 1;
  }
}

/** Every number the probe prints, for one folder. It reads; it never writes to the folder. */
export function probeFolder(dir: string, turns: number = DEFAULT_PROBE_TURNS): ProbeReport {
  const state = readState(join(dir, STATE_FILE));
  const life = readOptionalText(join(dir, "notebook", "self", "life.md"));
  const character = readOptionalText(join(dir, "notebook", "self", "character.md"));
  const store = readRiverStore(dir, turns);
  const grantStore = readGrantStore(dir);
  return {
    life: { codePoints: codePointsOf(life), headings: headingCount(life) },
    character: { codePoints: codePointsOf(character) },
    river: {
      rows: store.rows,
      dbBytes: fileBytes(join(dir, "river.db")),
      walBytes: fileBytes(join(dir, "river.db-wal")),
      shmBytes: fileBytes(join(dir, "river.db-shm")),
    },
    tables: store.tables,
    stoppedCleanly: state?.["stoppedCleanly"] === true,
    rhythmTagged: state?.["rhythmTagged"] === true,
    open: {
      asks: listCount(state?.["asks"]),
      wakes: listCount(state?.["wakes"]),
      grants: grantStore.found ? grantStore.grants : listCount(state?.["grants"]),
      requests: grantStore.found ? grantStore.requests : listCount(state?.["requests"]),
    },
    ledger: store.ledger,
  };
}

// ---------------------------------------------------------------------------------------------------
// Files

function codePointsOf(text: string): number {
  return [...text].length;
}

/** Markdown ATX headings: one to six hashes at the start of a line, with a space after them. */
function headingCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^\s{0,3}#{1,6}(\s|$)/.test(line)).length;
}

function readOptionalText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------------
// state.json

type JsonObject = Record<string, unknown>;

function readState(path: string): JsonObject | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${STATE_FILE} could not be read as JSON; nothing was changed.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${STATE_FILE} is not a JSON object; nothing was changed.`);
  }
  return parsed as JsonObject;
}

function listCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

// ---------------------------------------------------------------------------------------------------
// SQLite, opened read-only

/**
 * Runs `work` on a read-only view of one database. The folder's file is never opened for writing, never locked and
 * never checkpointed. A database with a live write-ahead log is copied beside the system's temp folder first, so
 * the rows still in that log are counted without touching the Lar's folder. The copy is removed afterwards.
 */
function withReadOnlyDb<T>(file: string, missing: T, work: (db: DatabaseSync) => T): T {
  if (!existsSync(file)) return missing;
  const wal = `${file}-wal`;
  const shm = `${file}-shm`;
  if (fileBytes(wal) === 0) {
    const db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  const temp = mkdtempSync(join(tmpdir(), "natalis-probe-"));
  const copy = join(temp, basename(file));
  try {
    copyFileSync(file, copy);
    if (existsSync(wal)) copyFileSync(wal, `${copy}-wal`);
    if (existsSync(shm)) copyFileSync(shm, `${copy}-shm`);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return work(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
    name: unknown;
  }>;
  return rows.map((row) => String(row.name)).filter((name) => !name.startsWith("sqlite_"));
}

function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The row count of one table; 0 when the table is not there. */
function countTable(db: DatabaseSync, name: string): number {
  if (!tableExists(db, name)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(name)}`).get() as { n: number }).n);
}

// ---------------------------------------------------------------------------------------------------
// The river and the tables beside it

type RiverStore = { rows: number; tables: Record<string, number>; ledger: EmptyLedger };

function emptyLedger(): EmptyLedger {
  return { turns: 0, measuredTurns: 0, cacheShare: 0, turnsPerDay: {} };
}

function readRiverStore(dir: string, turns: number): RiverStore {
  const missing: RiverStore = { rows: 0, tables: {}, ledger: emptyLedger() };
  return withReadOnlyDb(join(dir, "river.db"), missing, (db) => {
    const rows = countTable(db, "rows");
    const tables: Record<string, number> = {};
    for (const name of tableNames(db)) {
      // The river's own table and the search index (with its shadow tables) are not derived tables.
      if (name === "rows" || name.startsWith("river_fts")) continue;
      tables[name] = countTable(db, name);
    }
    return { rows, tables, ledger: readLedger(db, turns) };
  });
}

type TurnRecord = {
  thread_kind: unknown;
  at_ms: number;
  prompt_tokens: number | null;
  cache_hit_tokens: number | null;
};

function readLedger(db: DatabaseSync, turns: number): EmptyLedger {
  if (!tableExists(db, "turn_ledger")) return emptyLedger();

  const window = db
    .prepare("SELECT prompt_tokens, cache_hit_tokens FROM turn_ledger ORDER BY seq DESC LIMIT ?")
    .all(turns) as unknown as Array<Pick<TurnRecord, "prompt_tokens" | "cache_hit_tokens">>;
  let promptTokens = 0;
  let cacheHitTokens = 0;
  let measuredTurns = 0;
  for (const row of window) {
    const prompt = finiteNumber(row.prompt_tokens);
    const hit = finiteNumber(row.cache_hit_tokens);
    if (prompt === undefined || hit === undefined || prompt <= 0) continue;
    promptTokens += prompt;
    cacheHitTokens += hit;
    measuredTurns += 1;
  }

  // A day is a UTC day: the ledger keeps no zone, so the probe does not pretend to know one.
  const grouped = db
    .prepare(
      "SELECT thread_kind, COUNT(*) AS turns, MIN(at_ms) AS first_ms, MAX(at_ms) AS last_ms " +
        "FROM turn_ledger GROUP BY thread_kind",
    )
    .all() as unknown as Array<{ thread_kind: unknown; turns: unknown; first_ms: unknown; last_ms: unknown }>;
  const spans = new Map<string, { turns: number; firstMs: number; lastMs: number }>();
  for (const row of grouped) {
    const count = finiteNumber(row.turns);
    const firstMs = finiteNumber(row.first_ms);
    const lastMs = finiteNumber(row.last_ms);
    if (count === undefined || firstMs === undefined || lastMs === undefined) continue;
    const kind = KNOWN_THREAD_KINDS.has(String(row.thread_kind)) ? String(row.thread_kind) : "other";
    const span = spans.get(kind) ?? { turns: 0, firstMs, lastMs };
    span.turns += count;
    span.firstMs = Math.min(span.firstMs, firstMs);
    span.lastMs = Math.max(span.lastMs, lastMs);
    spans.set(kind, span);
  }
  const turnsPerDay: Record<string, number> = {};
  for (const [kind, span] of spans) {
    const days = Math.floor(span.lastMs / DAY_MS) - Math.floor(span.firstMs / DAY_MS) + 1;
    turnsPerDay[kind] = round(span.turns / Math.max(1, days), 2);
  }

  return {
    turns: window.length,
    measuredTurns,
    cacheShare: promptTokens > 0 ? round(cacheHitTokens / promptTokens, 4) : 0,
    turnsPerDay,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------------------------------
// The permission store (grants.db), when a Lar has one

function readGrantStore(dir: string): { found: boolean; grants: number; requests: number } {
  const file = join(dir, "grants.db");
  if (!existsSync(file)) return { found: false, grants: 0, requests: 0 };
  return withReadOnlyDb(file, { found: true, grants: 0, requests: 0 }, (db) => ({
    found: true,
    grants: countTable(db, "grants"),
    requests: countTable(db, "requests"),
  }));
}
