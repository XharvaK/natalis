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

export const GRANT_EVENTS = ["asked", "granted", "refused", "used", "revoked", "dropped"] as const;
export type GrantEvent = (typeof GRANT_EVENTS)[number];

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
  const selectOnce = db.prepare(
    "SELECT * FROM grants WHERE tool = ? AND kind = 'once' AND used_at IS NULL AND revoked_at IS NULL AND args_hash = ? ORDER BY id LIMIT 1",
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
  const revokeGrant = db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error("grants.db is closed");
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
      const once = selectOnce.get(input.tool, input.argsHmac) as GrantRecord | undefined;
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
