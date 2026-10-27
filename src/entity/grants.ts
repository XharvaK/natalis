// grants.db: what the Owner allowed or refused, held in the Lar's folder and outside notebook/, so no notebook tool
// can read or edit it. It keeps no argument text and no free text: a request holds the tool, its site or place,
// an HMAC of the call's canonical arguments, and where the request was posted. The per-Lar key behind the HMAC is the
// B0 P5 thread-hash key, made on first need in the Lar's own folder and never stored here.
//
// The tables follow SPEC §5.5 and design §11. grant_log is append-only: a trigger refuses UPDATE and DELETE. Deleting
// grants.db fails safe (every ask tool asks again) but loses "never" refusals; the river's request rows are the
// second record. A migration must keep the trigger.

import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readThreadHashKey } from "../river/thread-key.js";

export const GRANTS_FILE = "grants.db";

/** The scope of a standing grant that covers every site or place. A tool with no scope extractor says "anywhere". */
export const ANYWHERE = "anywhere";
/** The design's name for a grant on the whole tool. It covers every site or place too. */
export const WHOLE_TOOL = "whole tool";

export const GRANT_KINDS = ["once", "always", "never"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export const GRANT_EVENTS = ["asked", "granted", "refused", "used", "revoked", "dropped", "cleared by forget"] as const;
export type GrantEvent = (typeof GRANT_EVENTS)[number];

/** A forgotten request's scope, and its grant's scope: neither matches a real call, so the tool asks again. */
export const CLEARED_SCOPE = "cleared";

/** A read-back may hold at most five requests, so one "yes to all" costs one message. */
export const READBACK_ITEMS_MAX = 5;
/** A read-back closes after fifteen minutes. */
export const READBACK_TTL_MS = 15 * 60_000;
/** A request that nobody answered is no longer open after twenty-four hours. */
export const REQUEST_TTL_MS = 24 * 60 * 60_000;

/** What a call-start check says: run the tool, refuse it, or post a request. */
export type GrantDecision =
  | { outcome: "allow"; grantId: number; scope: string; kind: "once" | "always" }
  | { outcome: "refuse"; grantId: number; scope: string }
  | { outcome: "ask" };

export type RequestRow = {
  id: number;
  tool: string;
  scopeKey: string;
  argsHmac: string;
  postedSeq: number;
  place: string;
  askingThread: string;
  createdAt: number;
  status: string;
  closedAt?: number;
};

export type GrantRow = {
  id: number;
  tool: string;
  scope: string;
  kind: GrantKind;
  requestSeq?: number;
  argsHmac?: string;
  createdAt: number;
  createdBy: string;
  usedAt?: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

/** What one twenty-four-hour sweep closed: the requests it expired and the unused once grants it dropped. */
export type ExpiredClose = { requests: RequestRow[]; onceGrants: GrantRow[] };

/** One request inside a read-back: the request id, the kind it would store, and the exact scope. */
export type ReadbackItem = { requestId: number; kind: GrantKind; scope: string };

export type ReadbackRow = {
  id: number;
  items: ReadbackItem[];
  postedSeq: number;
  status: string;
  createdAt: number;
  closedAt?: number;
};

export type CreateReadbackInput = { items: ReadbackItem[]; nowMs: number };
export type AnswerRequestInput = { requestId: number; kind: GrantKind; scope: string; createdBy: string; nowMs: number };
export type ConfirmReadbackInput = { id: number; createdBy: string; nowMs: number };
export type ConfirmedReadback = { readback: ReadbackRow; grants: GrantRow[] };

export type CheckInput = { tool: string; scope: string; argsHmac: string; nowMs: number };

export type RequestInput = {
  tool: string;
  scopeKey: string;
  argsHmac: string;
  postedSeq: number;
  place: string;
  askingThread: string;
  nowMs: number;
};

export type AddGrantInput = {
  tool: string;
  scope: string;
  kind: GrantKind;
  /** The request id this grant answers, when it answers one. */
  requestSeq?: number;
  /** The HMAC of the approved call's arguments; required for a once grant. */
  argsHmac?: string;
  /** Always the summoner's alias. */
  createdBy: string;
  nowMs: number;
};

export type Grants = {
  readonly path: string;
  /** HMAC-SHA-256 of the canonical arguments under this Lar's key. */
  hmac(args: Record<string, unknown>): string;
  check(input: CheckInput): GrantDecision;
  /** Records a posted request and its "asked" log row; returns the request id. */
  request(input: RequestInput): number;
  addGrant(input: AddGrantInput): number;
  /** Takes back one grant. Returns false when it was already revoked or does not exist. */
  revoke(grantId: number, nowMs: number): boolean;
  /** Stores one answer that needs no read-back. Undefined when the request is no longer open. */
  answerRequest(input: AnswerRequestInput): GrantRow | undefined;
  /** Closes one request as answered with a "no", storing nothing. False when it is no longer open. */
  declineRequest(requestId: number, nowMs: number): boolean;
  /** Creates the one open read-back. Undefined when another is already open. */
  createReadback(input: CreateReadbackInput): number | undefined;
  setReadbackPostedSeq(id: number, postedSeq: number): void;
  /** The one open read-back that has not closed, if any. Read only: an expired row is left for the next write. */
  openReadback(nowMs: number): ReadbackRow | undefined;
  getReadback(id: number): ReadbackRow | undefined;
  /** Stores every item of one agreed read-back in one transaction. Undefined when it is not open. */
  confirmReadback(input: ConfirmReadbackInput): ConfirmedReadback | undefined;
  /** Closes a read-back that the Owner did not agree to. The requests inside it stay waiting. */
  declineReadback(id: number, nowMs: number): boolean;
  /** Closes what passed its day, requests and unused once grants. Returns how many requests changed. */
  expireRequests(nowMs: number): number;
  /**
   * Closes open requests and unused once grants older than twenty-four hours in one transaction, and logs each dropped
   * once grant. Returns only what this sweep changed, so a caller posts one close line per request and one row per drop.
   */
  closeExpired(nowMs: number): ExpiredClose;
  /** Drops every unused once grant, for a restore: the calls they were given for did not survive. Logs each drop. */
  dropUnusedOnce(nowMs: number): GrantRow[];
  /**
   * Clears the hash and scope of every request whose posted river row was forgotten, and of the grants that answered
   * it. A cleared grant no longer matches a call, so the next call asks again. Logs "cleared by forget" per grant.
   */
  clearForgottenRequests(seqs: readonly number[], nowMs: number): number;
  openRequests(): RequestRow[];
  getRequest(id: number): RequestRow | undefined;
  listGrants(): GrantRow[];
  close(): void;
};

const CREATE_REQUESTS = `CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  args_hmac TEXT NOT NULL,
  posted_seq INTEGER NOT NULL,
  place TEXT NOT NULL,
  asking_thread TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  closed_at INTEGER
)`;

const CREATE_READBACKS = `CREATE TABLE IF NOT EXISTS readbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  items TEXT NOT NULL,
  posted_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
)`;

const CREATE_GRANTS = `CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_seq INTEGER,
  args_hash TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  used_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
)`;

const CREATE_LOG = `CREATE TABLE IF NOT EXISTS grant_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  grant_id INTEGER,
  event TEXT NOT NULL
)`;

const CREATE_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS grant_log_update BEFORE UPDATE ON grant_log
  BEGIN SELECT RAISE(ABORT, 'grant_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS grant_log_delete BEFORE DELETE ON grant_log
  BEGIN SELECT RAISE(ABORT, 'grant_log is append-only'); END;
`;

const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS grants_tool_scope ON grants(tool, scope);
  CREATE INDEX IF NOT EXISTS grants_args_hash ON grants(args_hash);
  CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
`;

const SCOPE_MATCH = "(scope = ? OR scope = ? OR scope = ?)";

type GrantRecord = {
  id: number;
  tool: string;
  scope: string;
  kind: string;
  request_seq: number | null;
  args_hash: string | null;
  created_at: number;
  created_by: string;
  used_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

type RequestRecord = {
  id: number;
  tool: string;
  scope_key: string;
  args_hmac: string;
  posted_seq: number;
  place: string;
  asking_thread: string;
  created_at: number;
  status: string;
  closed_at: number | null;
};

type ReadbackRecord = {
  id: number;
  items: string;
  posted_seq: number;
  status: string;
  created_at: number;
  closed_at: number | null;
};

/** The file for one Lar folder. */
export function grantsPath(dir: string): string {
  return join(dir, GRANTS_FILE);
}

/** Opens grants.db in a Lar folder, creating its tables and the append-only trigger on first use. */
export function openGrants(dir: string, options: { key?: Buffer } = {}): Grants {
  const path = grantsPath(dir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // A forgotten request's scope or hash must not linger in freed pages (design §11).
    db.exec("PRAGMA secure_delete = ON");
    db.exec(CREATE_REQUESTS);
    db.exec(CREATE_READBACKS);
    db.exec(CREATE_GRANTS);
    db.exec(CREATE_LOG);
    db.exec(CREATE_TRIGGERS);
    db.exec(CREATE_INDEXES);
  } catch (err) {
    db.close();
    throw err;
  }
  const key = options.key ?? readThreadHashKey(dir);

  const selectNever = db.prepare(
    `SELECT * FROM grants WHERE tool = ? AND kind = 'never' AND revoked_at IS NULL AND ${SCOPE_MATCH} ORDER BY id DESC LIMIT 1`,
  );
  const selectAlways = db.prepare(
    `SELECT * FROM grants WHERE tool = ? AND kind = 'always' AND revoked_at IS NULL AND ${SCOPE_MATCH} ORDER BY id DESC LIMIT 1`,
  );
  // An unused once grant closes after a day (Q-D), even when no sweep has run yet. It matches one scope, like never/always.
  const selectOnce = db.prepare(
    `SELECT * FROM grants WHERE tool = ? AND kind = 'once' AND used_at IS NULL AND revoked_at IS NULL AND ${SCOPE_MATCH} AND created_at > ? AND args_hash = ? ORDER BY id LIMIT 1`,
  );
  const useAlways = db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL");
  const useOnce = db.prepare(
    "UPDATE grants SET used_at = ?, last_used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
  );
  const insertLog = db.prepare("INSERT INTO grant_log (at, grant_id, event) VALUES (?, ?, ?)");
  const insertRequest = db.prepare(
    "INSERT INTO requests (tool, scope_key, args_hmac, posted_seq, place, asking_thread, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertGrant = db.prepare(
    "INSERT INTO grants (tool, scope, kind, request_seq, args_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRequest = db.prepare("SELECT * FROM requests WHERE id = ?");
  const selectOpenRequests = db.prepare("SELECT * FROM requests WHERE status = 'open' ORDER BY id");
  const selectGrants = db.prepare("SELECT * FROM grants ORDER BY id");
  const selectGrant = db.prepare("SELECT * FROM grants WHERE id = ?");
  const revokeGrant = db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
  const closeRequest = db.prepare("UPDATE requests SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'");
  const expireRequestRows = db.prepare(
    "UPDATE requests SET status = 'expired', closed_at = ? WHERE status = 'open' AND created_at <= ?",
  );
  const selectExpiredRequests = db.prepare(
    "SELECT * FROM requests WHERE status = 'open' AND created_at <= ? ORDER BY id",
  );
  const selectExpiredOnce = db.prepare(
    "SELECT * FROM grants WHERE kind = 'once' AND used_at IS NULL AND revoked_at IS NULL AND created_at <= ? ORDER BY id",
  );
  const selectUnusedOnce = db.prepare(
    "SELECT * FROM grants WHERE kind = 'once' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id",
  );
  const selectAllRequests = db.prepare("SELECT * FROM requests ORDER BY id");
  const selectGrantsByRequest = db.prepare("SELECT * FROM grants WHERE request_seq = ? ORDER BY id");
  const clearRequest = db.prepare(
    "UPDATE requests SET scope_key = ?, args_hmac = ?, status = 'cleared', closed_at = ? WHERE id = ?",
  );
  const clearGrant = db.prepare("UPDATE grants SET scope = ?, args_hash = NULL WHERE id = ?");
  const insertReadback = db.prepare(
    "INSERT INTO readbacks (items, posted_seq, status, created_at) VALUES (?, 0, 'open', ?)",
  );
  const selectReadback = db.prepare("SELECT * FROM readbacks WHERE id = ?");
  const selectOpenReadback = db.prepare("SELECT * FROM readbacks WHERE status = 'open' ORDER BY id DESC LIMIT 1");
  const setReadbackPostedSeq = db.prepare("UPDATE readbacks SET posted_seq = ? WHERE id = ?");
  const closeReadback = db.prepare("UPDATE readbacks SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'");
  const expireReadbackRows = db.prepare(
    "UPDATE readbacks SET status = 'expired', closed_at = ? WHERE status = 'open' AND created_at <= ?",
  );
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error("grants.db is closed");
  };

  /** The one twenty-four-hour close, shared by the sweep and by the older expireRequests call. */
  const closeExpiredNow = (nowMs: number): ExpiredClose => {
    ensureOpen();
    return transaction(db, () => {
      const cutoff = nowMs - REQUEST_TTL_MS;
      const requests = (selectExpiredRequests.all(cutoff) as unknown as RequestRecord[]).map(requestFromRecord);
      const onceGrants = (selectExpiredOnce.all(cutoff) as unknown as GrantRecord[]).map(grantFromRecord);
      if (requests.length === 0 && onceGrants.length === 0) return { requests: [], onceGrants: [] };
      expireRequestRows.run(nowMs, cutoff);
      for (const grant of onceGrants) {
        const result = revokeGrant.run(nowMs, grant.id);
        if (Number(result.changes) === 1) insertLog.run(nowMs, grant.id, "dropped");
      }
      return { requests, onceGrants };
    });
  };

  return {
    path,
    hmac(args: Record<string, unknown>): string {
      return hmacArgs(key, args);
    },
    check(input: CheckInput): GrantDecision {
      ensureOpen();
      const never = selectNever.get(input.tool, input.scope, ANYWHERE, WHOLE_TOOL) as GrantRecord | undefined;
      if (never !== undefined) {
        return { outcome: "refuse", grantId: Number(never.id), scope: never.scope };
      }
      const always = selectAlways.get(input.tool, input.scope, ANYWHERE, WHOLE_TOOL) as GrantRecord | undefined;
      if (always !== undefined) {
        const id = Number(always.id);
        return transaction(db, () => {
          const used = useAlways.run(input.nowMs, id);
          if (Number(used.changes) !== 1) return { outcome: "ask" };
          insertLog.run(input.nowMs, id, "used");
          return { outcome: "allow", grantId: id, scope: always.scope, kind: "always" };
        });
      }
      const once = selectOnce.get(
        input.tool,
        input.scope,
        ANYWHERE,
        WHOLE_TOOL,
        input.nowMs - REQUEST_TTL_MS,
        input.argsHmac,
      ) as GrantRecord | undefined;
      if (once !== undefined) {
        const id = Number(once.id);
        return transaction(db, () => {
          const used = useOnce.run(input.nowMs, input.nowMs, id);
          if (Number(used.changes) !== 1) return { outcome: "ask" };
          insertLog.run(input.nowMs, id, "used");
          return { outcome: "allow", grantId: id, scope: once.scope, kind: "once" };
        });
      }
      return { outcome: "ask" };
    },
    request(input: RequestInput): number {
      ensureOpen();
      if (!/^[0-9a-f]{64}$/.test(input.argsHmac)) {
        throw new Error("A request needs the HMAC of the call's arguments, never the arguments themselves.");
      }
      return transaction(db, () => {
        const result = insertRequest.run(
          input.tool,
          input.scopeKey,
          input.argsHmac,
          input.postedSeq,
          input.place,
          input.askingThread,
          input.nowMs,
          "open",
        );
        const id = Number(result.lastInsertRowid);
        insertLog.run(input.nowMs, null, "asked");
        return id;
      });
    },
    addGrant(input: AddGrantInput): number {
      ensureOpen();
      if (!(GRANT_KINDS as readonly string[]).includes(input.kind)) throw new Error(`Unknown grant kind "${input.kind}".`);
      if (input.createdBy.trim() === "") throw new Error("A grant needs the summoner's alias in created_by.");
      if (input.kind === "once" && (input.argsHmac === undefined || !/^[0-9a-f]{64}$/.test(input.argsHmac))) {
        throw new Error("A once grant needs the HMAC of the approved call's arguments.");
      }
      const event: GrantEvent = input.kind === "never" ? "refused" : "granted";
      return transaction(db, () => {
        const result = insertGrant.run(
          input.tool,
          input.scope,
          input.kind,
          input.requestSeq ?? null,
          input.kind === "once" ? (input.argsHmac ?? null) : null,
          input.nowMs,
          input.createdBy,
        );
        const id = Number(result.lastInsertRowid);
        insertLog.run(input.nowMs, id, event);
        return id;
      });
    },
    revoke(grantId: number, nowMs: number): boolean {
      ensureOpen();
      return transaction(db, () => {
        const result = revokeGrant.run(nowMs, grantId);
        if (Number(result.changes) !== 1) return false;
        insertLog.run(nowMs, grantId, "revoked");
        return true;
      });
    },
    answerRequest(input: AnswerRequestInput): GrantRow | undefined {
      ensureOpen();
      if (!(GRANT_KINDS as readonly string[]).includes(input.kind)) throw new Error(`Unknown grant kind "${input.kind}".`);
      if (input.createdBy.trim() === "") throw new Error("An answer needs the summoner's alias in created_by.");
      if (input.scope.trim() === "") throw new Error("An answer needs a scope.");
      return transaction(db, () => {
        expireRequestRows.run(input.nowMs, input.nowMs - REQUEST_TTL_MS);
        const request = selectRequest.get(input.requestId) as RequestRecord | undefined;
        if (request === undefined || request.status !== "open") return undefined;
        const event: GrantEvent = input.kind === "never" ? "refused" : "granted";
        const result = insertGrant.run(
          request.tool,
          input.scope,
          input.kind,
          Number(request.id),
          input.kind === "once" ? request.args_hmac : null,
          input.nowMs,
          input.createdBy,
        );
        const id = Number(result.lastInsertRowid);
        insertLog.run(input.nowMs, id, event);
        const closed = closeRequest.run("answered", input.nowMs, request.id);
        if (Number(closed.changes) !== 1) throw new Error(`Request ${request.id} changed while it was answered.`);
        const stored = selectGrant.get(id) as GrantRecord | undefined;
        if (stored === undefined) throw new Error(`Grant ${id} was not stored.`);
        return grantFromRecord(stored);
      });
    },
    declineRequest(requestId: number, nowMs: number): boolean {
      ensureOpen();
      return transaction(db, () => {
        expireRequestRows.run(nowMs, nowMs - REQUEST_TTL_MS);
        const result = closeRequest.run("answered", nowMs, requestId);
        return Number(result.changes) === 1;
      });
    },
    createReadback(input: CreateReadbackInput): number | undefined {
      ensureOpen();
      if (input.items.length === 0 || input.items.length > READBACK_ITEMS_MAX) {
        throw new Error(`A read-back holds one to ${READBACK_ITEMS_MAX} requests.`);
      }
      const ids = new Set<number>();
      for (const item of input.items) {
        if (!(GRANT_KINDS as readonly string[]).includes(item.kind)) throw new Error(`Unknown grant kind "${item.kind}".`);
        if (item.scope.trim() === "") throw new Error("A read-back item needs a scope.");
        if (!Number.isSafeInteger(item.requestId) || item.requestId < 1) throw new Error("A read-back item needs a request id.");
        if (ids.has(item.requestId)) throw new Error("A read-back cannot name one request twice.");
        ids.add(item.requestId);
      }
      return transaction(db, () => {
        expireReadbackRows.run(input.nowMs, input.nowMs - READBACK_TTL_MS);
        expireRequestRows.run(input.nowMs, input.nowMs - REQUEST_TTL_MS);
        const open = selectOpenReadback.get() as ReadbackRecord | undefined;
        if (open !== undefined) return undefined;
        for (const item of input.items) {
          const request = selectRequest.get(item.requestId) as RequestRecord | undefined;
          if (request === undefined || request.status !== "open") return undefined;
        }
        const result = insertReadback.run(JSON.stringify(input.items), input.nowMs);
        return Number(result.lastInsertRowid);
      });
    },
    setReadbackPostedSeq(id: number, postedSeq: number): void {
      ensureOpen();
      const result = setReadbackPostedSeq.run(postedSeq, id);
      if (Number(result.changes) !== 1) throw new Error(`Read-back ${id} was not found.`);
    },
    openReadback(nowMs: number): ReadbackRow | undefined {
      ensureOpen();
      const record = selectOpenReadback.get() as ReadbackRecord | undefined;
      if (record === undefined) return undefined;
      if (Number(record.created_at) + READBACK_TTL_MS <= nowMs) return undefined;
      return readbackFromRecord(record);
    },
    getReadback(id: number): ReadbackRow | undefined {
      ensureOpen();
      const record = selectReadback.get(id) as ReadbackRecord | undefined;
      return record === undefined ? undefined : readbackFromRecord(record);
    },
    confirmReadback(input: ConfirmReadbackInput): ConfirmedReadback | undefined {
      ensureOpen();
      if (input.createdBy.trim() === "") throw new Error("A confirmed read-back needs the summoner's alias in created_by.");
      return transaction(db, () => {
        expireReadbackRows.run(input.nowMs, input.nowMs - READBACK_TTL_MS);
        expireRequestRows.run(input.nowMs, input.nowMs - REQUEST_TTL_MS);
        const record = selectReadback.get(input.id) as ReadbackRecord | undefined;
        if (record === undefined || record.status !== "open") return undefined;
        const readback = readbackFromRecord(record);
        const requests: RequestRecord[] = [];
        for (const item of readback.items) {
          const request = selectRequest.get(item.requestId) as RequestRecord | undefined;
          if (request === undefined || request.status !== "open") return undefined;
          requests.push(request);
        }
        const stored: GrantRow[] = [];
        for (const [index, item] of readback.items.entries()) {
          const request = requests[index]!;
          const event: GrantEvent = item.kind === "never" ? "refused" : "granted";
          const result = insertGrant.run(
            request.tool,
            item.scope,
            item.kind,
            Number(request.id),
            item.kind === "once" ? request.args_hmac : null,
            input.nowMs,
            input.createdBy,
          );
          const id = Number(result.lastInsertRowid);
          insertLog.run(input.nowMs, id, event);
          const closed = closeRequest.run("answered", input.nowMs, request.id);
          if (Number(closed.changes) !== 1) throw new Error(`Request ${request.id} changed while its read-back was agreed.`);
          const grant = selectGrant.get(id) as GrantRecord | undefined;
          if (grant === undefined) throw new Error(`Grant ${id} was not stored.`);
          stored.push(grantFromRecord(grant));
        }
        const closed = closeReadback.run("confirmed", input.nowMs, input.id);
        if (Number(closed.changes) !== 1) throw new Error(`Read-back ${input.id} changed while it was agreed.`);
        return { readback, grants: stored };
      });
    },
    declineReadback(id: number, nowMs: number): boolean {
      ensureOpen();
      return transaction(db, () => {
        expireReadbackRows.run(nowMs, nowMs - READBACK_TTL_MS);
        const result = closeReadback.run("declined", nowMs, id);
        return Number(result.changes) === 1;
      });
    },
    expireRequests(nowMs: number): number {
      return closeExpiredNow(nowMs).requests.length;
    },
    closeExpired(nowMs: number): ExpiredClose {
      return closeExpiredNow(nowMs);
    },
    dropUnusedOnce(nowMs: number): GrantRow[] {
      ensureOpen();
      return transaction(db, () => {
        const rows = (selectUnusedOnce.all() as unknown as GrantRecord[]).map(grantFromRecord);
        for (const grant of rows) {
          const result = revokeGrant.run(nowMs, grant.id);
          if (Number(result.changes) === 1) insertLog.run(nowMs, grant.id, "dropped");
        }
        return rows;
      });
    },
    clearForgottenRequests(seqs: readonly number[], nowMs: number): number {
      ensureOpen();
      const wanted = new Set(seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0));
      if (wanted.size === 0) return 0;
      return transaction(db, () => {
        let cleared = 0;
        for (const request of selectAllRequests.all() as unknown as RequestRecord[]) {
          if (!wanted.has(Number(request.posted_seq))) continue;
          if (request.scope_key === CLEARED_SCOPE && request.args_hmac === "") continue;
          const changed = clearRequest.run(CLEARED_SCOPE, "", nowMs, request.id);
          if (Number(changed.changes) !== 1) continue;
          cleared += 1;
          for (const grant of selectGrantsByRequest.all(request.id) as unknown as GrantRecord[]) {
            if (grant.scope === CLEARED_SCOPE && grant.args_hash === null) continue;
            const result = clearGrant.run(CLEARED_SCOPE, grant.id);
            if (Number(result.changes) === 1) insertLog.run(nowMs, Number(grant.id), "cleared by forget");
          }
        }
        return cleared;
      });
    },
    openRequests(): RequestRow[] {
      ensureOpen();
      return (selectOpenRequests.all() as unknown as RequestRecord[]).map(requestFromRecord);
    },
    getRequest(id: number): RequestRow | undefined {
      ensureOpen();
      const record = selectRequest.get(id) as RequestRecord | undefined;
      return record === undefined ? undefined : requestFromRecord(record);
    },
    listGrants(): GrantRow[] {
      ensureOpen();
      return (selectGrants.all() as unknown as GrantRecord[]).map(grantFromRecord);
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** Runs one write as a transaction, so a once grant is marked used before the tool runs or not at all. */
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already rolled back by SQLite; the first error is the one to raise.
    }
    throw err;
  }
}

/** Keys sorted at every level, with JSON's own treatment of undefined and non-finite numbers. */
function canonicalArgs(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalArgs(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalArgs(record[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value) ?? "null";
}

function hmacArgs(key: Buffer, args: Record<string, unknown>): string {
  return createHmac("sha256", key).update(canonicalArgs(args), "utf8").digest("hex");
}

function requestFromRecord(record: RequestRecord): RequestRow {
  const row: RequestRow = {
    id: Number(record.id),
    tool: record.tool,
    scopeKey: record.scope_key,
    argsHmac: record.args_hmac,
    postedSeq: Number(record.posted_seq),
    place: record.place,
    askingThread: record.asking_thread,
    createdAt: Number(record.created_at),
    status: record.status,
  };
  if (record.closed_at !== null) row.closedAt = Number(record.closed_at);
  return row;
}

function readbackFromRecord(record: ReadbackRecord): ReadbackRow {
  const items = JSON.parse(record.items) as ReadbackItem[];
  const row: ReadbackRow = {
    id: Number(record.id),
    items,
    postedSeq: Number(record.posted_seq),
    status: record.status,
    createdAt: Number(record.created_at),
  };
  if (record.closed_at !== null) row.closedAt = Number(record.closed_at);
  return row;
}

function grantFromRecord(record: GrantRecord): GrantRow {
  const row: GrantRow = {
    id: Number(record.id),
    tool: record.tool,
    scope: record.scope,
    kind: record.kind as GrantKind,
    createdAt: Number(record.created_at),
    createdBy: record.created_by,
  };
  if (record.request_seq !== null) row.requestSeq = Number(record.request_seq);
  if (record.args_hash !== null) row.argsHmac = record.args_hash;
  if (record.used_at !== null) row.usedAt = Number(record.used_at);
  if (record.last_used_at !== null) row.lastUsedAt = Number(record.last_used_at);
  if (record.revoked_at !== null) row.revokedAt = Number(record.revoked_at);
  return row;
}
