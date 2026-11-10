// An act the game refused once in one game session is no longer offered in that session (D4; was twice).
// A deleted object (TARGET_DELETED, or a NO_OBJECT refusal) leaves the next view at once. A new session
// (attachment) starts over, and the hide expires HIDE_FOR_MS after the newest refusal, since the game may
// allow the act again later (S-D).

import type { DatabaseSync } from "node:sqlite";
import type { OptionObject } from "./answers.js";

/** Refusals of one act, in one session, after which the act is not offered again in that session. */
export const HIDE_AFTER_REFUSALS = 1;
/** How long a hide lasts after the newest refusal of the act. */
export const HIDE_FOR_MS = 30 * 60_000;
/** The probe's refusals that say the game cannot do this act now; a busy body or a paused clock does not count. */
const HIDING_CODES: ReadonlySet<string> = new Set(["NO_INTERACTION", "GAME_REFUSED"]);
/** A refusal that means the object itself is gone (D4). */
const GONE_CODES: ReadonlySet<string> = new Set(["NO_OBJECT"]);

const key = (objectId: string, guid64: string): string => `${objectId}\u0000${guid64}`;

function finishingType(detail: Record<string, unknown>): string {
  const raw = detail.finishing_type;
  if (typeof raw !== "string") return "";
  return raw.startsWith("FinishingType.") ? raw.slice("FinishingType.".length) : raw;
}

/** Object ids removed by TARGET_DELETED or NO_OBJECT in this attachment, so the next view must not list them (D4). */
export function goneObjectIds(db: DatabaseSync, attachment: string): Set<string> {
  const rows = db.prepare(`SELECT a.object_id AS object_id, e.phase AS phase, e.detail_json AS detail_json
    FROM acts a JOIN act_events e ON e.act_id = a.act_id
    WHERE a.attachment = ? AND e.phase IN ('finished', 'rejected')`).all(attachment);
  const gone = new Set<string>();
  for (const row of rows) {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(String(row.detail_json)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.phase === "finished" && finishingType(detail) === "TARGET_DELETED") {
      gone.add(String(row.object_id));
    } else if (row.phase === "rejected" && typeof detail.code === "string" && GONE_CODES.has(detail.code)) {
      gone.add(String(row.object_id));
    }
  }
  return gone;
}

/** The acts (object id and guid64) refused at least HIDE_AFTER_REFUSALS times in this attachment, the newest of them within HIDE_FOR_MS of nowMs. */
export function refusedKeys(db: DatabaseSync, attachment: string, nowMs: number): Set<string> {
  const rows = db.prepare(`SELECT a.object_id AS object_id, a.guid64 AS guid64, e.detail_json AS detail_json,
    e.received_at_ms AS received_at_ms
    FROM acts a JOIN act_events e ON e.act_id = a.act_id AND e.phase = 'rejected' WHERE a.attachment = ?`).all(attachment);
  const counts = new Map<string, number>();
  const newest = new Map<string, number>();
  for (const row of rows) {
    let code: unknown;
    try {
      code = (JSON.parse(String(row.detail_json)) as Record<string, unknown>)?.code;
    } catch {
      continue;
    }
    if (typeof code !== "string" || !HIDING_CODES.has(code)) continue;
    const k = key(String(row.object_id), String(row.guid64));
    counts.set(k, (counts.get(k) ?? 0) + 1);
    newest.set(k, Math.max(newest.get(k) ?? 0, Number(row.received_at_ms)));
  }
  return new Set([...counts]
    .filter(([k, count]) => count >= HIDE_AFTER_REFUSALS && (newest.get(k) ?? 0) > nowMs - HIDE_FOR_MS)
    .map(([k]) => k));
}

/** The act names a helper refusal line names: the words before ": refused:". */
function refusedActTexts(object: OptionObject): Set<string> {
  const texts = new Set<string>();
  for (const line of object.refused ?? []) {
    if (typeof line !== "string") continue;
    const index = line.indexOf(": refused:");
    if (index > 0) texts.add(line.slice(0, index).trim().toLowerCase());
  }
  return texts;
}

/**
 * The options without gone objects, without acts the game refused lately in this attachment, and without an act
 * listed as both offered and refused. An object left with no acts is dropped.
 */
export function withoutRefused(db: DatabaseSync, attachment: string, options: readonly OptionObject[], nowMs: number): OptionObject[] {
  const hidden = refusedKeys(db, attachment, nowMs);
  const gone = goneObjectIds(db, attachment);
  const kept: OptionObject[] = [];
  for (const object of options) {
    if (gone.has(object.object_id) && object.object_id !== "queue:her") continue;
    const paired = refusedActTexts(object);
    const acts = object.acts.filter((act) => {
      if (act && typeof act.guid64 === "string" && hidden.has(key(object.object_id, act.guid64))) return false;
      if (act && typeof act.text === "string" && paired.has(act.text.trim().toLowerCase())) return false;
      return true;
    });
    if (acts.length === object.acts.length) kept.push(object);
    else if (acts.length > 0) kept.push({ ...object, acts });
  }
  return kept;
}
