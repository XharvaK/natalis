// The Domus world's memory, kept in the Lar's folder under domus/: observations (with their option tables, for
// dedup and for the refs a Lar names), acts and their events, plan steps, undo records (in domus.sqlite), and
// the helper's heartbeats (in state.json). A restart keeps all of it.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORGOTTEN_LINE } from "../../notebook/forget.js";

export const DOMUS_FOLDER = "domus";
export const DOMUS_DB_FILE = "domus.sqlite";
export const DOMUS_STATE_FILE = "state.json";
/** A helper's latest heartbeat counts as attached for this long after it arrived. */
export const ARMED_MS = 180_000;
/** An expired observation is kept this long before it is pruned (a re-send after expiry is refused anyway). */
const OBSERVATION_KEEP_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_SESSIONS_KEPT = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  observation_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  thread TEXT NOT NULL,
  world TEXT NOT NULL,
  branch TEXT NOT NULL,
  session TEXT NOT NULL,
  attachment TEXT NOT NULL,
  body TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source_time_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  receipt_time_ms INTEGER NOT NULL,
  lineage_class TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  undone_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS observations_thread ON observations (thread);
CREATE INDEX IF NOT EXISTS observations_attachment ON observations (attachment);
CREATE TABLE IF NOT EXISTS acts (
  act_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  attachment TEXT NOT NULL,
  observation_id TEXT,
  option_ref TEXT NOT NULL,
  object_id TEXT NOT NULL,
  guid64 TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  for_summoner INTEGER NOT NULL,
  answer_json TEXT
);
CREATE INDEX IF NOT EXISTS acts_attachment_state ON acts (attachment, state);
CREATE TABLE IF NOT EXISTS act_events (
  act_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  PRIMARY KEY (act_id, phase)
);
CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  thread TEXT NOT NULL,
  attachment TEXT NOT NULL,
  option_ref TEXT NOT NULL,
  object_id TEXT NOT NULL,
  guid64 TEXT NOT NULL,
  label TEXT NOT NULL,
  for_summoner INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  act_id TEXT,
  planned_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (plan_id, step)
);
CREATE INDEX IF NOT EXISTS plan_steps_attachment_state ON plan_steps (attachment, state);
CREATE TABLE IF NOT EXISTS undos (
  undo_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread TEXT NOT NULL,
  world TEXT NOT NULL,
  branch TEXT NOT NULL,
  session TEXT NOT NULL,
  after_source_time_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  observations INTEGER NOT NULL,
  undone_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  attachment TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  picture_id TEXT,
  requested_at_ms INTEGER NOT NULL,
  settled_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS snapshots_thread_status ON snapshots (thread, status);
CREATE TABLE IF NOT EXISTS game_attention (
  thread TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  resume_mode TEXT NOT NULL,
  quiet_until_ms INTEGER,
  look_every_minutes INTEGER NOT NULL,
  set_at_ms INTEGER NOT NULL,
  viewed_session TEXT,
  last_wake_ms INTEGER
);
CREATE TABLE IF NOT EXISTS looks (
  attachment TEXT PRIMARY KEY,
  owed INTEGER NOT NULL,
  last_handed_ms INTEGER
);
CREATE TABLE IF NOT EXISTS look_asks (
  attachment TEXT NOT NULL,
  thread TEXT NOT NULL,
  asked_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attachment, thread)
);
CREATE TABLE IF NOT EXISTS overlay_lines (
  line_id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  thread TEXT NOT NULL,
  line TEXT
);
CREATE TABLE IF NOT EXISTS memory_asks (
  ask_id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  about TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  handed_session TEXT,
  settled_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS memory_asks_status ON memory_asks (status);
CREATE TABLE IF NOT EXISTS lists (
  attachment TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  items_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (attachment, kind)
);
CREATE TABLE IF NOT EXISTS catalog_asks (
  ask_id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  about TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  handed_session TEXT,
  settled_at_ms INTEGER,
  room TEXT,
  max_price INTEGER,
  placement TEXT
);
CREATE INDEX IF NOT EXISTS catalog_asks_status ON catalog_asks (status);
CREATE TABLE IF NOT EXISTS list_marks (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  attachment TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_seen (
  attachment TEXT NOT NULL,
  ref TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (attachment, ref)
);
`;

/** How the game's changes reach the Lar's turns. A quiet mode reverts to resumeMode when quietUntilMs passes. */
export type AttentionMode = "every_change" | "when_called" | "quiet";
export type AttentionRow = {
  thread: string;
  mode: AttentionMode;
  resumeMode: "every_change" | "when_called";
  quietUntilMs: number | undefined;
  lookEveryMinutes: number;
  setAtMs: number;
  /** The helper session of the newest view the thread got: a view from another session is the first after attach. */
  viewedSession: string | undefined;
  /** When a view last woke the thread, or undefined before the first one. */
  lastWakeMs: number | undefined;
};

/** The refusal for a choice or a picture request that rests on a view from a helper session the game is no longer on. */
export const STALE_VIEW_CODE = "view_from_earlier_session";
export const STALE_VIEW_REASON =
  "The game restarted since that view, and its new view has not arrived yet. Wait for the game's new view, then choose again.";

export type Row = Record<string, unknown>;

/**
 * The schema version this code reads and writes (PRAGMA user_version). Version 1 adds two nullable columns to acts: words
 * (what the Lar said to the Sim the act targets) and pulled_at_ms (when the helper first took the act). Version 2 adds
 * acts.verb and acts.args_json (the home and travel verbs, and a Sim an act names), and the tables lists, catalog_asks and
 * catalog_seen (the game's lists on demand, and the catalogue asks).
 */
export const DOMUS_SCHEMA_VERSION = 2;
const ACT_COLUMNS_V1: ReadonlyArray<readonly [name: string, type: string]> = [["words", "TEXT"], ["pulled_at_ms", "INTEGER"]];
const ACT_COLUMNS_V2: ReadonlyArray<readonly [name: string, type: string]> = [["verb", "TEXT"], ["args_json", "TEXT"]];

/**
 * Brings an open Domus database to DOMUS_SCHEMA_VERSION. The schema's tables are created when missing (a store from before
 * a table was added lacks it), each column is added only when it is missing, and all of it is one transaction that also sets
 * the version. A database from a later version is refused, not read. Forgetting runs this too, so the tables come first.
 */
export function migrateDomusDb(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
  if (version > DOMUS_SCHEMA_VERSION) {
    throw new Error(`The Domus database has schema version ${version}; this code reads version ${DOMUS_SCHEMA_VERSION}.`);
  }
  if (version === DOMUS_SCHEMA_VERSION) return;
  const present = new Set((db.prepare("PRAGMA table_info(acts)").all() as Row[]).map((column) => String(column.name)));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    for (const [name, type] of [...ACT_COLUMNS_V1, ...ACT_COLUMNS_V2]) {
      if (!present.has(name)) db.exec(`ALTER TABLE acts ADD COLUMN ${name} ${type}`);
    }
    db.exec(`PRAGMA user_version = ${DOMUS_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Opens (or creates) the Domus database in the Lar's domus folder, at the current schema version. */
export function openDomusDb(dir: string): DatabaseSync {
  const folder = join(dir, DOMUS_FOLDER);
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, DOMUS_DB_FILE));
  try {
    db.exec(SCHEMA);
    migrateDomusDb(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** One transaction; the callers do not nest them. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* keep the first error */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// Observations.

export type ObservationRow = {
  observationId: string;
  digest: string;
  thread: string;
  world: string;
  branch: string;
  session: string;
  attachment: string;
  body: string;
  snapshot: string;
  seq: number;
  sourceTimeMs: number;
  expiresAtMs: number;
  receiptTimeMs: number;
  lineageClass: string;
  payloadJson: string;
};

export type AdmitResult = { status: "admitted" | "duplicate"; receiptTimeMs: number } | { status: "conflict" };

/** Admits an observation once. The same id with the same digest is a duplicate (the original receipt time); another digest is a conflict. */
export function admitObservation(db: DatabaseSync, row: ObservationRow): AdmitResult {
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT digest, receipt_time_ms FROM observations WHERE observation_id = ?")
      .get(row.observationId) as Row | undefined;
    if (existing) {
      return String(existing.digest) === row.digest
        ? { status: "duplicate" as const, receiptTimeMs: Number(existing.receipt_time_ms) }
        : { status: "conflict" as const };
    }
    db.prepare(`INSERT INTO observations (observation_id, digest, thread, world, branch, session, attachment, body, snapshot, seq,
      source_time_ms, expires_at_ms, receipt_time_ms, lineage_class, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.observationId, row.digest, row.thread, row.world, row.branch, row.session, row.attachment, row.body, row.snapshot,
        row.seq, row.sourceTimeMs, row.expiresAtMs, row.receiptTimeMs, row.lineageClass, row.payloadJson);
    return { status: "admitted" as const, receiptTimeMs: row.receiptTimeMs };
  });
}

/**
 * Drops observations whose window closed a day ago, except the newest of each game thread. Such an id can no
 * longer be admitted (the wire answers expired before it looks for a duplicate), so dedup is unchanged.
 */
export function pruneObservations(db: DatabaseSync, nowMs: number): number {
  const result = db.prepare(`DELETE FROM observations WHERE expires_at_ms < ? AND rowid NOT IN
    (SELECT MAX(rowid) FROM observations GROUP BY thread)`).run(nowMs - OBSERVATION_KEEP_MS);
  return Number(result.changes);
}

/** The newest admitted, not undone observation of a game thread (the only one its refs resolve against), or undefined. */
export function newestObservation(db: DatabaseSync, thread: string): { observationId: string; attachment: string; payload: Row } | undefined {
  const row = db.prepare(`SELECT observation_id, attachment, payload_json FROM observations
    WHERE thread = ? AND undone_at_ms IS NULL ORDER BY rowid DESC LIMIT 1`).get(thread) as Row | undefined;
  if (!row) return undefined;
  let payload: Row = {};
  try { payload = JSON.parse(String(row.payload_json)) as Row; } catch { payload = {}; }
  return { observationId: String(row.observation_id), attachment: String(row.attachment), payload };
}

/**
 * The game's thread: the thread of the attached helper session's newest view. A session that has sent no view yet
 * gets the thread of the newest view of any session (there is one game). Undefined when no view has come at all.
 */
export function gameThreadNow(db: DatabaseSync, attachedSession: string | undefined): string | undefined {
  if (attachedSession !== undefined) {
    const own = db.prepare("SELECT thread FROM observations WHERE attachment = ? ORDER BY rowid DESC LIMIT 1").get(attachedSession) as Row | undefined;
    if (own) return String(own.thread);
  }
  const newest = db.prepare("SELECT thread FROM observations ORDER BY rowid DESC LIMIT 1").get() as Row | undefined;
  return newest ? String(newest.thread) : undefined;
}

export type UndoSpan = { thread: string; world: string; branch: string; session: string; afterSourceTimeMs: number; reason: string };

/**
 * Undo: every observation of the span after the given time counts as undone (not admitted, no longer the newest
 * view). Returns how many were undone now. Nothing else is rewritten.
 */
export function markSpanUndone(db: DatabaseSync, span: UndoSpan, nowMs: number): number {
  return inTransaction(db, () => markSpanUndoneIn(db, span, nowMs));
}

/** The undo's rows, without a transaction of their own: for a caller that runs them inside its own (the Domus undo route). */
export function markSpanUndoneIn(db: DatabaseSync, span: UndoSpan, nowMs: number): number {
  const changed = db.prepare(`UPDATE observations SET undone_at_ms = ?
    WHERE world = ? AND branch = ? AND session = ? AND source_time_ms > ? AND undone_at_ms IS NULL`)
    .run(nowMs, span.world, span.branch, span.session, span.afterSourceTimeMs);
  const count = Number(changed.changes);
  db.prepare(`INSERT INTO undos (thread, world, branch, session, after_source_time_ms, reason, observations, undone_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(span.thread, span.world, span.branch, span.session, span.afterSourceTimeMs,
    span.reason, count, nowMs);
  return count;
}

// ---------------------------------------------------------------------------------------------------
// Forgetting the game's own words (the summoner's forget, and the Lar's). Ids, digests and times stay: rows keep their
// place, and only the text they hold is replaced.

type ForgetColumn = { name: string; json: boolean; erased: string };

/**
 * Every table that keeps game or Lar text, its text columns, and what a forgotten cell holds instead. A table with
 * deleteRow loses the whole row: a list the game sent is sent again by the helper, so its digest must go with it.
 */
const FORGET_TABLES: ReadonlyArray<{ table: string; columns: readonly ForgetColumn[]; deleteRow?: true }> = [
  { table: "observations", columns: [{ name: "payload_json", json: true, erased: "{}" }] },
  {
    table: "acts",
    columns: [
      { name: "label", json: false, erased: FORGOTTEN_LINE }, { name: "answer_json", json: true, erased: "{}" },
      { name: "words", json: false, erased: FORGOTTEN_LINE }, { name: "args_json", json: true, erased: "{}" },
    ],
  },
  { table: "act_events", columns: [{ name: "detail_json", json: true, erased: "{}" }] },
  { table: "plan_steps", columns: [{ name: "label", json: false, erased: FORGOTTEN_LINE }] },
  { table: "undos", columns: [{ name: "reason", json: false, erased: FORGOTTEN_LINE }] },
  { table: "overlay_lines", columns: [{ name: "line", json: false, erased: FORGOTTEN_LINE }] },
  { table: "memory_asks", columns: [{ name: "about", json: false, erased: FORGOTTEN_LINE }] },
  { table: "lists", columns: [{ name: "items_json", json: true, erased: "[]" }], deleteRow: true },
  { table: "catalog_asks", columns: [{ name: "about", json: false, erased: FORGOTTEN_LINE }, { name: "room", json: false, erased: FORGOTTEN_LINE }] },
  { table: "catalog_seen", columns: [{ name: "name", json: false, erased: FORGOTTEN_LINE }] },
];

/** The form words are compared in: NFKC and lower case, as the notebook and the river fold them. */
function foldForget(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The text of one cell to search: a JSON cell by its strings (not its keys or shape), any other cell as it is. */
function searchableCell(value: string, json: boolean): string {
  if (!json) return value;
  try {
    const parts: string[] = [];
    collectStrings(JSON.parse(value) as unknown, parts);
    return parts.join("\n");
  } catch {
    return value;
  }
}

function collectStrings(value: unknown, parts: string[]): void {
  if (typeof value === "string") parts.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, parts);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, parts);
}

/**
 * What was still waiting to go to the game does not go once its words are forgotten: a requested act is withdrawn (kept
 * as expired, code FORGOTTEN) with the waiting steps of its plan, and a waiting plan step is dropped. The game never
 * receives an act whose words were erased, nor one stripped of its answer.
 */
function withdrawForgotten(db: DatabaseSync, table: string, rowid: number, nowMs: number): void {
  if (table === "acts") {
    const act = db.prepare("SELECT act_id FROM acts WHERE rowid = ? AND state = 'requested'").get(rowid) as Row | undefined;
    if (!act) return;
    const actId = String(act.act_id);
    db.prepare("UPDATE acts SET state = 'expired', updated_at_ms = ? WHERE act_id = ?").run(nowMs, actId);
    db.prepare("INSERT OR IGNORE INTO act_events (act_id, phase, at_ms, received_at_ms, detail_json) VALUES (?, 'expired', ?, ?, ?)")
      .run(actId, nowMs, nowMs, JSON.stringify({ code: "FORGOTTEN" }));
    db.prepare("UPDATE plan_steps SET state = 'dropped', reason = 'forgotten', updated_at_ms = ? WHERE plan_id = ? AND state = 'planned'")
      .run(nowMs, actId);
  } else if (table === "plan_steps") {
    db.prepare("UPDATE plan_steps SET state = 'dropped', reason = 'forgotten', updated_at_ms = ? WHERE rowid = ? AND state = 'planned'")
      .run(nowMs, rowid);
  } else if (table === "memory_asks") {
    // A question still waiting to be handed over is withdrawn, so the helper never receives the erased words.
    db.prepare("UPDATE memory_asks SET status = 'withdrawn', settled_at_ms = ? WHERE rowid = ? AND status IN ('owed', 'handed')")
      .run(nowMs, rowid);
  } else if (table === "catalog_asks") {
    db.prepare("UPDATE catalog_asks SET status = 'withdrawn', settled_at_ms = ? WHERE rowid = ? AND status IN ('owed', 'handed')")
      .run(nowMs, rowid);
  }
}

/**
 * Forgets words in the game's store. In every table that keeps game or Lar text, each row whose live text holds all the
 * words (case and form aside) has that text replaced: a marker for plain text, an empty object for JSON. Rows already
 * forgotten are not counted again. Returns how many rows were erased; the file is then vacuumed.
 */
export function forgetText(db: DatabaseSync, words: readonly string[]): number {
  const wanted = words.map(foldForget).filter((word) => word.length > 0);
  if (wanted.length === 0) return 0;
  let erased = 0;
  inTransaction(db, () => {
    for (const spec of FORGET_TABLES) {
      const names = spec.columns.map((column) => column.name).join(", ");
      const rows = db.prepare(`SELECT rowid AS rid, ${names} FROM ${spec.table}`).all() as Row[];
      for (const row of rows) {
        const live = spec.columns.filter((column) => typeof row[column.name] === "string" && row[column.name] !== column.erased);
        if (live.length === 0) continue;
        const haystack = foldForget(live.map((column) => searchableCell(String(row[column.name]), column.json)).join("\n"));
        if (!wanted.every((word) => haystack.includes(word))) continue;
        if (spec.deleteRow) {
          db.prepare(`DELETE FROM ${spec.table} WHERE rowid = ?`).run(row.rid as number);
        } else {
          const sets = live.map((column) => `${column.name} = ?`).join(", ");
          db.prepare(`UPDATE ${spec.table} SET ${sets} WHERE rowid = ?`).run(...live.map((column) => column.erased), row.rid as number);
        }
        withdrawForgotten(db, spec.table, row.rid as number, Date.now());
        erased += 1;
      }
    }
  });
  db.exec("VACUUM");
  return erased;
}

/**
 * The summoner's forget in the game's store when no world is running: opens domus/domus.sqlite if it exists (it is not
 * created here), forgets, and closes it. Returns how many rows were erased; 0 when there is no store.
 */
export function forgetInDomusFile(dir: string, words: readonly string[]): number {
  const path = join(dir, DOMUS_FOLDER, DOMUS_DB_FILE);
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    migrateDomusDb(db);
    return forgetText(db, words);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Heartbeats (state.json): the latest heartbeat of each helper session, kept so a restart still knows whether the game was attached.

type HeartbeatRecord = {
  receivedAtMs: number;
  sentAtMs: number;
  attached: boolean;
  /** When the attached value last changed (the time it began, or when it began to be absent). */
  changedAtMs: number;
  /** The last time a heartbeat of this session said attached. Absent until one has. */
  lastAttachedMs?: number;
  /** The game's world, as the helper named it on its last heartbeat that named one. */
  world?: string;
  probeVersion?: string;
};

type StateFile = { version: 1; sessions: Record<string, HeartbeatRecord> };

export class HeartbeatBook {
  private readonly path: string;
  private sessions: Record<string, HeartbeatRecord>;

  constructor(dir: string) {
    this.path = join(dir, DOMUS_FOLDER, DOMUS_STATE_FILE);
    this.sessions = load(this.path);
  }

  /** Records one heartbeat. The attached value's change time is kept while it stays the same. */
  record(session: string, input: { sentAtMs: number; attached: boolean; probeVersion?: string; world?: string }, nowMs: number): void {
    const before = this.sessions[session];
    const lastAttachedMs = input.attached ? nowMs : before?.lastAttachedMs;
    const world = input.world ? input.world : before?.world;
    this.sessions[session] = {
      receivedAtMs: nowMs,
      sentAtMs: input.sentAtMs,
      attached: input.attached,
      changedAtMs: before && before.attached === input.attached ? before.changedAtMs : nowMs,
      ...(lastAttachedMs === undefined ? {} : { lastAttachedMs }),
      ...(world === undefined ? {} : { world }),
      // A heartbeat that names no probe version keeps the one the session named last (the verb gate reads it).
      ...(input.probeVersion ? { probeVersion: input.probeVersion } : before?.probeVersion ? { probeVersion: before.probeVersion } : {}),
    };
    this.prune();
    this.save();
  }

  /** The heartbeat that arrived last, from any session. */
  latest(): (HeartbeatRecord & { session: string }) | undefined {
    let found: (HeartbeatRecord & { session: string }) | undefined;
    for (const [session, record] of Object.entries(this.sessions)) {
      if (!found || record.receivedAtMs > found.receivedAtMs) found = { ...record, session };
    }
    return found;
  }

  /** Attached: the latest heartbeat says so and it arrived within ARMED_MS. */
  attachedAt(nowMs: number): boolean {
    return this.attachedSession(nowMs) !== undefined;
  }

  /** The last time any session's heartbeat said attached, or undefined when none ever did. */
  lastAttachedAt(): number | undefined {
    let last: number | undefined;
    for (const record of Object.values(this.sessions)) {
      if (record.lastAttachedMs !== undefined && (last === undefined || record.lastAttachedMs > last)) last = record.lastAttachedMs;
    }
    return last;
  }

  /** The game's world as a session's heartbeats named it, or undefined when none did. */
  worldOf(session: string): string | undefined {
    return this.sessions[session]?.world;
  }

  /** The game's helper probe version as a session's heartbeats named it, or undefined when none did. */
  probeOf(session: string): string | undefined {
    return this.sessions[session]?.probeVersion;
  }

  /** The helper session that is attached now (see attachedAt), or undefined. */
  attachedSession(nowMs: number): string | undefined {
    const latest = this.latest();
    return latest !== undefined && latest.attached && latest.receivedAtMs >= nowMs - ARMED_MS ? latest.session : undefined;
  }

  private prune(): void {
    const keep = Object.entries(this.sessions).sort((a, b) => b[1].receivedAtMs - a[1].receivedAtMs).slice(0, HEARTBEAT_SESSIONS_KEPT);
    this.sessions = Object.fromEntries(keep);
  }

  private save(): void {
    mkdirSync(join(this.path, ".."), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const body: StateFile = { version: 1, sessions: this.sessions };
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, this.path);
  }
}

function load(path: string): Record<string, HeartbeatRecord> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`The Domus state file (${DOMUS_FOLDER}/${DOMUS_STATE_FILE}) is damaged; not starting, so the game's attachment is not guessed.`);
  }
  const sessions = (parsed as Partial<StateFile> | null)?.sessions;
  if ((parsed as Partial<StateFile> | null)?.version !== 1 || typeof sessions !== "object" || sessions === null) {
    throw new Error(`The Domus state file (${DOMUS_FOLDER}/${DOMUS_STATE_FILE}) has an unknown version; not starting.`);
  }
  return sessions as Record<string, HeartbeatRecord>;
}

// ---------------------------------------------------------------------------------------------------
// Her attention to the game, per game thread, and the looks owed to the helper, per helper session.

/** The setting a thread has before she sets one: every change wakes her, and no look is asked for. */
export function defaultAttention(thread: string): AttentionRow {
  return { thread, mode: "every_change", resumeMode: "every_change", quietUntilMs: undefined, lookEveryMinutes: 0, setAtMs: 0, viewedSession: undefined, lastWakeMs: undefined };
}

export function readAttention(db: DatabaseSync, thread: string): AttentionRow {
  const row = db.prepare("SELECT * FROM game_attention WHERE thread = ?").get(thread) as Row | undefined;
  if (!row) return defaultAttention(thread);
  return {
    thread,
    mode: String(row.mode) as AttentionMode,
    resumeMode: String(row.resume_mode) as "every_change" | "when_called",
    quietUntilMs: row.quiet_until_ms === null ? undefined : Number(row.quiet_until_ms),
    lookEveryMinutes: Number(row.look_every_minutes),
    setAtMs: Number(row.set_at_ms),
    viewedSession: row.viewed_session === null ? undefined : String(row.viewed_session),
    lastWakeMs: row.last_wake_ms === null ? undefined : Number(row.last_wake_ms),
  };
}

export function writeAttention(db: DatabaseSync, row: AttentionRow): void {
  db.prepare(`INSERT INTO game_attention (thread, mode, resume_mode, quiet_until_ms, look_every_minutes, set_at_ms, viewed_session, last_wake_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread) DO UPDATE SET mode = excluded.mode, resume_mode = excluded.resume_mode, quiet_until_ms = excluded.quiet_until_ms,
      look_every_minutes = excluded.look_every_minutes, set_at_ms = excluded.set_at_ms, viewed_session = excluded.viewed_session,
      last_wake_ms = excluded.last_wake_ms`)
    .run(
      row.thread, row.mode, row.resumeMode, row.quietUntilMs ?? null, row.lookEveryMinutes, row.setAtMs,
      row.viewedSession ?? null, row.lastWakeMs ?? null,
    );
}

/** Whether a look is owed to this helper session and not yet handed over. */
export function lookOwed(db: DatabaseSync, attachment: string): boolean {
  const row = db.prepare("SELECT owed FROM looks WHERE attachment = ?").get(attachment) as Row | undefined;
  return row !== undefined && Number(row.owed) === 1;
}

/** The last time a look was handed to this helper session, or undefined when none has been. */
export function lastLookHanded(db: DatabaseSync, attachment: string): number | undefined {
  const row = db.prepare("SELECT last_handed_ms FROM looks WHERE attachment = ?").get(attachment) as Row | undefined;
  if (row === undefined || row.last_handed_ms === null) return undefined;
  return Number(row.last_handed_ms);
}

/** Records that a look is owed to this helper session. One flag: asking again changes nothing. */
export function oweLook(db: DatabaseSync, attachment: string): void {
  db.prepare("INSERT INTO looks (attachment, owed, last_handed_ms) VALUES (?, 1, NULL) ON CONFLICT (attachment) DO UPDATE SET owed = 1")
    .run(attachment);
}

/** Hands the owed look over: true once, and the flag is cleared. False when none was owed. */
export function takeLook(db: DatabaseSync, attachment: string, nowMs: number): boolean {
  const result = db.prepare("UPDATE looks SET owed = 0, last_handed_ms = ? WHERE attachment = ? AND owed = 1").run(nowMs, attachment);
  return Number(result.changes) > 0;
}

/** A look asked for from a thread waits this long for the look view that answers it; an older ask is not handed on. */
export const LOOK_ASK_KEEP_MS = 10 * 60_000;

/** Records that a thread asked for a look of this helper session. A thread that asks twice is kept once. */
export function recordLookAsk(db: DatabaseSync, attachment: string, thread: string, nowMs: number): void {
  db.prepare("INSERT INTO look_asks (attachment, thread, asked_at_ms) VALUES (?, ?, ?) ON CONFLICT (attachment, thread) DO UPDATE SET asked_at_ms = excluded.asked_at_ms")
    .run(attachment, thread, nowMs);
}

/**
 * The threads that asked for a look of this helper session, in the order they asked, within LOOK_ASK_KEEP_MS. They are
 * all forgotten here: a look view that comes for the session is the answer to them.
 */
export function takeLookAskers(db: DatabaseSync, attachment: string, nowMs: number): string[] {
  const rows = db.prepare("SELECT thread, asked_at_ms FROM look_asks WHERE attachment = ? ORDER BY rowid").all(attachment) as Row[];
  db.prepare("DELETE FROM look_asks WHERE attachment = ?").run(attachment);
  return rows.filter((row) => Number(row.asked_at_ms) > nowMs - LOOK_ASK_KEEP_MS).map((row) => String(row.thread));
}
