// The Domus wire, version 1: what the game's helper sends to this listener and what the listener answers.
// Ported from the old listener's ingress, its acts and its snapshot rules. Where the old prose and the old
// source disagree, the source is followed (the helper is built against the source). Every check here keeps
// the order and the status code of that source.

import { createHash, timingSafeEqual } from "node:crypto";

export const DOMUS_WORLD_ID = "domus";
/** The phases the helper reports for an act. Only the listener itself adds "expired" to a requested act. */
export type DomusActPhase = "received" | "accepted" | "rejected" | "pushed" | "finished" | "unknown" | "expired";
/** The wire's version. Every body carries v: 1 and nothing else is accepted. */
export const WIRE_VERSION = 1;
/** Every route but the snapshot route reads at most this many bytes of JSON. */
export const BODY_LIMIT = 64 * 1024;
/** The snapshot route: a 6 MiB picture travels as base64 inside its JSON body. */
export const SNAPSHOT_BODY_LIMIT = 9 * 1024 * 1024;
/** An observation's window (expiry minus source time) is at most this long. */
export const MAX_WINDOW_MS = 600_000;
/** An observation may claim a source time at most this far ahead of the listener's clock. */
export const MAX_SKEW_MS = 120_000;
/** The helper's token must be at least this many bytes. */
export const MIN_TOKEN_BYTES = 32;
export const SNAPSHOT_FAILURES = ["game_minimized", "no_game_window", "capture_failed"] as const;
export type SnapshotFailure = (typeof SNAPSHOT_FAILURES)[number];

/** A refusal of the wire: the HTTP status and the short error code the helper reads. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "WireError";
  }
}

export function fail(status: number, code: string): never {
  throw new WireError(status, code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail(400, "invalid_body");
  }
  return value;
}

function safeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(400, "invalid_body");
  return value;
}

function jsonObject(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!isRecord(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) fail(400, "invalid_body");
  return value;
}

/** Keys sorted at every level, so the same content always has the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function observationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** A token is compared by its SHA-256 digests, so the comparison takes the same time whatever the lengths. */
export function tokensEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

/**
 * Whether a helper token may be used: present, at least MIN_TOKEN_BYTES bytes, and not equal to any other
 * token the body holds. Returns the plain reason it may not, or null when it may.
 */
export function tokenProblem(token: string, otherTokens: readonly string[]): "missing" | "too_short" | "matches_other" | null {
  if (token.trim() === "") return "missing";
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) return "too_short";
  if (otherTokens.some((other) => other !== "" && tokensEqual(token, other))) return "matches_other";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Observations.

const OBSERVATION_KEYS = new Set([
  "v", "observation_id", "world", "branch", "session", "attachment", "body", "snapshot",
  "seq", "source_time_ms", "expires_at_ms", "lineage_class", "percepts", "portrait", "day", "options",
]);

export type Percept = { kind: string; salience: number; facts: Record<string, unknown> };

export type ParsedObservation = {
  observationId: string;
  /** The body as it is digested and stored: the fields the wire names, in the order it names them. */
  normalized: Record<string, unknown>;
  fields: {
    world: string; branch: string; session: string; attachment: string; body: string; snapshot: string;
    seq: number; sourceTimeMs: number; expiresAtMs: number; lineageClass: string;
  };
  percepts: Percept[];
  /** The option table: what the game offers the Lar to do, each act with the ref the Lar names. */
  options: Record<string, unknown>[] | undefined;
};

/** POST /domus/observation. Throws WireError for every refusal; returns the parsed body otherwise. */
export function parseObservation(body: unknown, nowMs: number): ParsedObservation {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!OBSERVATION_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1) fail(400, "invalid_body");
  const observationId = textOf(body.observation_id, 1, 128, /^[A-Za-z0-9._:-]+$/);
  const world = textOf(body.world, 1, 64);
  const branch = textOf(body.branch, 1, 64);
  const session = textOf(body.session, 1, 64);
  const attachment = textOf(body.attachment, 1, 64);
  const snapshot = textOf(body.snapshot, 1, 64);
  const bodyId = textOf(body.body, 1, 64);
  const seq = safeInt(body.seq);
  const sourceTimeMs = safeInt(body.source_time_ms);
  const expiresAtMs = safeInt(body.expires_at_ms);
  const lineageClass = textOf(body.lineage_class, 1, 32, /^[A-Z_]+$/);
  if (!Array.isArray(body.percepts) || body.percepts.length < 1 || body.percepts.length > 32) fail(400, "invalid_body");
  const percepts: Percept[] = body.percepts.map((item) => {
    if (!isRecord(item)) fail(400, "invalid_body");
    for (const key of Object.keys(item)) if (key !== "kind" && key !== "salience" && key !== "facts") fail(400, "invalid_body");
    const salience = item.salience;
    if (typeof salience !== "number" || !Number.isFinite(salience) || salience < 0 || salience > 1) fail(400, "invalid_body");
    return { kind: textOf(item.kind, 1, 32, /^[a-z0-9_]+$/), salience, facts: jsonObject(item.facts, 2048) };
  });
  const normalized: Record<string, unknown> = {
    v: 1, observation_id: observationId, world, branch, session, attachment, body: bodyId, snapshot,
    seq, source_time_ms: sourceTimeMs, expires_at_ms: expiresAtMs, lineage_class: lineageClass, percepts,
  };
  if ("portrait" in body) normalized.portrait = jsonObject(body.portrait, 8192);
  if ("day" in body) normalized.day = jsonObject(body.day, 16384);
  let options: Record<string, unknown>[] | undefined;
  if ("options" in body) {
    if (!Array.isArray(body.options) || body.options.length > 32 || !body.options.every(isRecord)
      || Buffer.byteLength(JSON.stringify(body.options), "utf8") > 8192) fail(400, "invalid_body");
    options = body.options as Record<string, unknown>[];
    normalized.options = body.options;
  }
  if (expiresAtMs <= sourceTimeMs || expiresAtMs - sourceTimeMs > MAX_WINDOW_MS) fail(400, "invalid_body");
  if (sourceTimeMs > nowMs + MAX_SKEW_MS) fail(400, "clock_skew");
  if (nowMs > expiresAtMs) fail(410, "expired");
  return {
    observationId,
    normalized,
    fields: { world, branch, session, attachment, body: bodyId, snapshot, seq, sourceTimeMs, expiresAtMs, lineageClass },
    percepts,
    options,
  };
}

// ---------------------------------------------------------------------------------------------------
// Heartbeats, undo, feed.

const HEARTBEAT_KEYS = new Set(["v", "helper_session", "sent_at_ms", "attached", "world", "probe_version", "inputs"]);

export type ParsedHeartbeat = {
  helperSession: string;
  sentAtMs: number;
  attached: boolean;
  world?: string;
  probeVersion?: string;
  inputs?: "full" | "game_only";
};

/** POST /domus/heartbeat. */
export function parseHeartbeat(body: unknown): ParsedHeartbeat {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!HEARTBEAT_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1 || typeof body.attached !== "boolean") fail(400, "invalid_body");
  const parsed: ParsedHeartbeat = {
    helperSession: textOf(body.helper_session, 1, 64),
    sentAtMs: safeInt(body.sent_at_ms),
    attached: body.attached,
  };
  if ("world" in body) parsed.world = textOf(body.world, 0, 64);
  if ("probe_version" in body) parsed.probeVersion = textOf(body.probe_version, 0, 16);
  if ("inputs" in body) {
    if (body.inputs !== "full" && body.inputs !== "game_only") fail(400, "invalid_body");
    parsed.inputs = body.inputs;
  }
  return parsed;
}

const UNDO_KEYS = new Set(["v", "world", "branch", "session", "after_source_time_ms", "reason"]);

export type ParsedUndo = { world: string; branch: string; session: string; afterSourceTimeMs: number; reason: string };

/** POST /domus/undo. */
export function parseUndo(body: unknown): ParsedUndo {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!UNDO_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1) fail(400, "invalid_body");
  return {
    world: textOf(body.world, 1, 64),
    branch: textOf(body.branch, 1, 64),
    session: textOf(body.session, 1, 64),
    afterSourceTimeMs: safeInt(body.after_source_time_ms),
    reason: textOf(body.reason, 1, 32, /^[A-Z_]+$/),
  };
}

const FEED_KEYS = new Set(["v", "helper_session"]);

/** POST /domus/feed. The helper's session only; the answer is the same for every session. */
export function parseFeed(body: unknown): { helperSession: string } {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!FEED_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1) fail(400, "invalid_body");
  return { helperSession: textOf(body.helper_session, 1, 64) };
}

// ---------------------------------------------------------------------------------------------------
// Acts sync.

const SYNC_KEYS = new Set(["v", "helper_session", "events"]);
const SYNC_EVENT_KEYS = new Set(["act_id", "phase", "at_ms", "detail"]);
const PHASES: ReadonlySet<string> = new Set(["received", "accepted", "rejected", "pushed", "finished", "unknown", "expired"]);

export function isActPhase(value: unknown): value is DomusActPhase {
  return typeof value === "string" && PHASES.has(value);
}

export type SyncEvent = { actId: string; phase: DomusActPhase; atMs: number; detail?: Record<string, unknown> };

/** POST /domus/acts/sync. */
export function parseActSync(body: unknown): { helperSession: string; events: SyncEvent[] } {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!SYNC_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1 || !Array.isArray(body.events) || body.events.length > 64) fail(400, "invalid_body");
  const events = body.events.map((item): SyncEvent => {
    if (!isRecord(item)) fail(400, "invalid_body");
    for (const key of Object.keys(item)) if (!SYNC_EVENT_KEYS.has(key)) fail(400, "invalid_body");
    if (!isActPhase(item.phase)) fail(400, "invalid_body");
    return {
      actId: textOf(item.act_id, 1, 64, /^[A-Za-z0-9]+$/),
      phase: item.phase,
      atMs: safeInt(item.at_ms),
      ...("detail" in item ? { detail: jsonObject(item.detail, 1024) } : {}),
    };
  });
  return { helperSession: textOf(body.helper_session, 1, 64), events };
}

// ---------------------------------------------------------------------------------------------------
// Snapshot (validated here; no picture is requested in this world, so every well-formed one is unknown).

const SNAPSHOT_KEYS = new Set(["v", "helper_session", "snapshot_id", "png_base64", "failed"]);

export type ParsedSnapshot = { helperSession: string; snapshotId: string; pngBase64?: string; failed?: SnapshotFailure };

/** POST /domus/snapshot: exactly one of a picture or a failure, both checked before the id is looked at. */
export function parseSnapshot(body: unknown): ParsedSnapshot {
  if (!isRecord(body)) fail(400, "invalid_body");
  for (const key of Object.keys(body)) if (!SNAPSHOT_KEYS.has(key)) fail(400, "invalid_body");
  if (body.v !== 1) fail(400, "invalid_body");
  const hasPicture = "png_base64" in body;
  const hasFailure = "failed" in body;
  if (hasPicture === hasFailure) fail(400, "invalid_body");
  const helperSession = textOf(body.helper_session, 1, 64);
  const snapshotId = textOf(body.snapshot_id, 1, 64, /^[A-Za-z0-9-]+$/);
  if (hasFailure) {
    if (!(SNAPSHOT_FAILURES as readonly unknown[]).includes(body.failed)) fail(400, "invalid_body");
    return { helperSession, snapshotId, failed: body.failed as SnapshotFailure };
  }
  if (typeof body.png_base64 !== "string" || body.png_base64.length === 0) fail(400, "invalid_body");
  return { helperSession, snapshotId, pngBase64: body.png_base64 };
}

/**
 * The game thread of an observation's game world: "domus:" and the world's name, with anything outside
 * letters, digits, "_" and "-" made "_" so the place is a plain alias (the helper names worlds "slot3" and the like).
 */
export function gameThreadOf(world: string): string {
  const alias = world.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
  return `${DOMUS_WORLD_ID}:${alias}`;
}
