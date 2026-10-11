// The Domus world's memory, kept in the Lar's folder under domus/: observations (with their option tables, for
// dedup and for the refs a Lar names), acts and their events, plan steps, undo records (in domus.sqlite), and
// the helper's heartbeats (in state.json). A restart keeps all of it.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
`;

/** The refusal for a choice or a picture request that rests on a view from a helper session the game is no longer on. */
export const STALE_VIEW_CODE = "view_from_earlier_session";
export const STALE_VIEW_REASON =
  "The game restarted since that view, and its new view has not arrived yet. Wait for the game's new view, then choose again.";

export type Row = Record<string, unknown>;

/** Opens (or creates) the Domus database in the Lar's domus folder. */
export function openDomusDb(dir: string): DatabaseSync {
  const folder = join(dir, DOMUS_FOLDER);
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, DOMUS_DB_FILE));
  try {
    db.exec(SCHEMA);
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
// Heartbeats (state.json): the latest heartbeat of each helper session, kept so a restart still knows whether the game was attached.

type HeartbeatRecord = {
  receivedAtMs: number;
  sentAtMs: number;
  attached: boolean;
  /** When the attached value last changed (the time it began, or when it began to be absent). */
  changedAtMs: number;
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
  record(session: string, input: { sentAtMs: number; attached: boolean; probeVersion?: string }, nowMs: number): void {
    const before = this.sessions[session];
    this.sessions[session] = {
      receivedAtMs: nowMs,
      sentAtMs: input.sentAtMs,
      attached: input.attached,
      changedAtMs: before && before.attached === input.attached ? before.changedAtMs : nowMs,
      ...(input.probeVersion ? { probeVersion: input.probeVersion } : {}),
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
