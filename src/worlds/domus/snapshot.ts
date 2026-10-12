// The game's picture: the Lar asks for one picture of the game, the helper takes it on its next sync and posts the PNG
// (or the reason it could not) to /domus/snapshot, and the world keeps the picture on the Lar's shelf. Nothing here
// decides what a picture is for: the Lar asks, the helper takes it or says why not, and the shelf keeps it.
//
// Source: the old listener's snapshots (same statuses, same ten-minute expiry, same wire codes). The requests live in
// domus.sqlite, table snapshots.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import type { ThreadNote } from "./acts.js";
import { type Row } from "./store.js";
import { type SnapshotFailure, SNAPSHOT_FAILURES } from "./wire.js";

/** A requested picture the helper does not take within this time expires; the game never sees it again. */
export const SNAPSHOT_TTL_MS = 10 * 60_000;
/** The decoded picture is at most this large (the helper downscales it before it sends). */
export const SNAPSHOT_PICTURE_MAX = 6 * 1024 * 1024;
/** The name the picture gets on the shelf. */
export const SNAPSHOT_PICTURE_NAME = "game.png";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The v1 answer for each refusal of the snapshot route, as the helper reads it. */
export const SNAPSHOT_STATUS: Readonly<Record<SnapshotRefusal, number>> = {
  unknown_snapshot: 404,
  not_requested: 409,
  wrong_attachment: 409,
  too_large: 413,
  not_png: 400,
  invalid_body: 400,
  snapshots_unavailable: 503,
  write_failed: 500,
};
export type SnapshotRefusal =
  | "unknown_snapshot"
  | "not_requested"
  | "wrong_attachment"
  | "too_large"
  | "not_png"
  | "invalid_body"
  | "snapshots_unavailable"
  | "write_failed";

/** What the game_snapshot tool reads on each call: null while the world is not running. */
export type SnapshotContext = {
  db: DatabaseSync;
  nowMs: () => number;
  /** The helper session that is attached now, or undefined when the game is not attached. */
  attachedSession: (nowMs: number) => string | undefined;
} | null;

const FAILURE_WORDS: Readonly<Record<SnapshotFailure, string>> = {
  game_minimized: "the game window was minimized",
  minimized: "the game window was minimized",
  not_front: "the game window was not the front window",
  no_game_window: "no game window was found",
  capture_failed: "the capture failed",
};

/**
 * A failure whose text is the whole note: the helper refused to take a picture that would show an old moment, and the
 * Lar is told so in plain words. Every other failure keeps the "could not be taken: <reason>" sentence.
 */
const PLAIN_FAILURE_TEXT: Partial<Record<SnapshotFailure, string>> = {
  minimized: "No picture: the game is minimized on the summoner's screen, so it would show an old moment.",
  not_front: "No picture: the game is not the front window on the summoner's screen, so it would show an old moment.",
};

function refused(code: string, reason: string): Receipt {
  return { ok: false, summary: reason, refused: { code, reason } };
}

/**
 * Asks for one picture for a game thread. One request is open at a time per thread; a second one is refused with how
 * long the open one has waited. The request is for the attached helper session. A request past its time does not
 * count as open, even before the timed pass has marked it expired.
 */
export function requestSnapshot(
  db: DatabaseSync,
  input: { thread: string; attachment: string; nowMs: number },
): { ok: true; snapshotId: string; expiresAtMs: number } | { ok: false; openSinceMs: number } {
  const open = db.prepare("SELECT requested_at_ms FROM snapshots WHERE thread = ? AND status = 'requested' AND requested_at_ms > ? ORDER BY requested_at_ms DESC LIMIT 1")
    .get(input.thread, input.nowMs - SNAPSHOT_TTL_MS) as Row | undefined;
  if (open) return { ok: false, openSinceMs: Number(open.requested_at_ms) };
  const snapshotId = randomUUID();
  db.prepare("INSERT INTO snapshots (snapshot_id, thread, attachment, status, requested_at_ms) VALUES (?, ?, ?, 'requested', ?)")
    .run(snapshotId, input.thread, input.attachment, input.nowMs);
  return { ok: true, snapshotId, expiresAtMs: input.nowMs + SNAPSHOT_TTL_MS };
}

/**
 * The requests the helper may take now: open for its session and within their time, in the order asked. The caller
 * expires the stale ones first (expireSnapshots). A picture is a read, so the stop does not hold it (Q-j).
 */
export function openSnapshots(db: DatabaseSync, input: { helperSession: string; nowMs: number }): Array<{ snapshot_id: string }> {
  return (db.prepare("SELECT snapshot_id FROM snapshots WHERE attachment = ? AND status = 'requested' AND requested_at_ms > ? ORDER BY requested_at_ms, snapshot_id")
    .all(input.helperSession, input.nowMs - SNAPSHOT_TTL_MS) as Row[]).map((row) => ({ snapshot_id: String(row.snapshot_id) }));
}

/** Requests not taken in time expire here, whoever asks. The Lar is told, without a wake. */
export function expireSnapshots(db: DatabaseSync, nowMs: number): ThreadNote[] {
  const stale = db.prepare("SELECT snapshot_id, thread FROM snapshots WHERE status = 'requested' AND requested_at_ms <= ?")
    .all(nowMs - SNAPSHOT_TTL_MS) as Row[];
  db.prepare("UPDATE snapshots SET status = 'expired', reason = 'not_taken_in_time', settled_at_ms = ? WHERE status = 'requested' AND requested_at_ms <= ?")
    .run(nowMs, nowMs - SNAPSHOT_TTL_MS);
  return stale.map((row) => ({
    thread: String(row.thread),
    text: "Your picture of the game was not taken within ten minutes, so the request expired.",
    data: { snapshotId: String(row.snapshot_id), status: "expired" },
    wake: false,
  }));
}


/**
 * Checks one answer of the helper against v1: the request must exist, be open, and be for this session. A picture is
 * decoded and checked (base64, size, PNG signature). Nothing is written here.
 */
export function checkSnapshot(
  db: DatabaseSync,
  input: { helperSession: string; snapshotId: string; pngBase64?: string; failed?: SnapshotFailure },
): { ok: true; thread: string; bytes?: Buffer } | { ok: false; code: SnapshotRefusal } {
  const row = db.prepare("SELECT thread, status, attachment FROM snapshots WHERE snapshot_id = ?").get(input.snapshotId) as Row | undefined;
  if (!row) return { ok: false, code: "unknown_snapshot" };
  if (row.status !== "requested") return { ok: false, code: "not_requested" };
  if (row.attachment !== input.helperSession) return { ok: false, code: "wrong_attachment" };
  const thread = String(row.thread);
  if (input.failed !== undefined) return { ok: true, thread };
  const picture = decodePng(input.pngBase64 ?? "");
  if ("code" in picture) return { ok: false, code: picture.code };
  return { ok: true, thread, bytes: picture.bytes };
}

/** The request is marked failed, and the Lar is told why, with a wake. */
export function settleFailed(db: DatabaseSync, input: { snapshotId: string; failed: SnapshotFailure; thread: string; nowMs: number }): ThreadNote {
  db.prepare("UPDATE snapshots SET status = 'failed', reason = ?, settled_at_ms = ? WHERE snapshot_id = ? AND status = 'requested'")
    .run(input.failed, input.nowMs, input.snapshotId);
  return {
    thread: input.thread,
    text: PLAIN_FAILURE_TEXT[input.failed] ?? `Your picture of the game could not be taken: ${FAILURE_WORDS[input.failed]}.`,
    data: { snapshotId: input.snapshotId, status: "failed", reason: input.failed },
    wake: true,
  };
}

/** The request is marked taken, and the Lar is told where its picture is, with a wake. */
export function settleTaken(db: DatabaseSync, input: { snapshotId: string; thread: string; pictureId: string; nowMs: number }): ThreadNote {
  db.prepare("UPDATE snapshots SET status = 'taken', picture_id = ?, settled_at_ms = ? WHERE snapshot_id = ? AND status = 'requested'")
    .run(input.pictureId, input.nowMs, input.snapshotId);
  return {
    thread: input.thread,
    text: `Your picture of the game is on your shelf as ${input.pictureId}.`,
    data: { snapshotId: input.snapshotId, status: "taken", pictureId: input.pictureId },
    wake: true,
  };
}

function decodePng(pngBase64: string): { bytes: Buffer } | { code: "invalid_body" | "too_large" | "not_png" } {
  if (pngBase64.length === 0 || pngBase64.length % 4 !== 0) return { code: "invalid_body" };
  const padding = pngBase64.endsWith("==") ? 2 : pngBase64.endsWith("=") ? 1 : 0;
  if ((pngBase64.length / 4) * 3 - padding > SNAPSHOT_PICTURE_MAX) return { code: "too_large" };
  if (!BASE64.test(pngBase64)) return { code: "invalid_body" };
  const bytes = Buffer.from(pngBase64, "base64");
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { code: "not_png" };
  return { bytes };
}

/** The game_snapshot tool: no arguments. What the picture is for is the Lar's own business. */
export function gameSnapshotTool(open: () => SnapshotContext): Tool {
  return {
    spec: {
      name: "game_snapshot",
      // Q-j (the User, 2026-10-12): the summoner's stop refuses acts, not reads; this one only reads the game.
      safeWhenStopped: true,
      description:
        "Ask for one picture of the game as it looks now. The game takes it at the link to the game's next check-in, within ten minutes, and it is kept on your shelf as a picture id. Only one request is open at a time for this game. Nothing is sent anywhere by this: a picture comes to your shelf for you to look at, or to send with say (attach).",
      parameters: { type: "object", properties: {} },
    },
    async run(_args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameSnapshot(open, context);
    },
  };
}

function gameSnapshot(open: () => SnapshotContext, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  const nowMs = game.nowMs();
  const attachment = game.attachedSession(nowMs);
  if (attachment === undefined) {
    return refused("not_attached", "The game is not attached right now, so no picture can be taken. Ask again when it is.");
  }
  const requested = requestSnapshot(game.db, { thread: context.thread, attachment, nowMs });
  if (!requested.ok) {
    const waited = Math.max(0, Math.round((nowMs - requested.openSinceMs) / 1000));
    return refused("one_open", `You already asked for a picture of the game ${waited} s ago, and it is still open. Wait for it.`);
  }
  return {
    ok: true,
    summary: "Asked for a picture of the game. It comes to your shelf when the game takes it, or a note says why not.",
    data: { snapshotId: requested.snapshotId, expiresAtMs: requested.expiresAtMs },
  };
}
