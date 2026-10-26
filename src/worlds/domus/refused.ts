// An act the game refused twice in one game session is no longer offered in that session (live 2026-10-26: she chose
// "Cancel (queued): stand Passive" three times and each was refused, NO_INTERACTION). A new session (attachment) starts over,
// and the hide expires HIDE_FOR_MS after the newest refusal, since the game may allow the act again later (S-D).

import type { DatabaseSync } from "node:sqlite";
import type { OptionObject } from "./answers.js";

/** Refusals of one act, in one session, after which the act is not offered again in that session. */
export const HIDE_AFTER_REFUSALS = 2;
/** How long a hide lasts after the newest refusal of the act. */
export const HIDE_FOR_MS = 30 * 60_000;
/** The probe's refusals that say the game cannot do this act now; a busy body or a paused clock does not count. */
const HIDING_CODES: ReadonlySet<string> = new Set(["NO_INTERACTION", "GAME_REFUSED"]);

const key = (objectId: string, guid64: string): string => `${objectId}\u0000${guid64}`;

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

/** The options without the acts the game refused twice lately in this attachment; an object left with no acts is dropped. */
export function withoutRefused(db: DatabaseSync, attachment: string, options: readonly OptionObject[], nowMs: number): OptionObject[] {
  const hidden = refusedKeys(db, attachment, nowMs);
  if (hidden.size === 0) return [...options];
  const kept: OptionObject[] = [];
  for (const object of options) {
    const acts = object.acts.filter((act) => !(act && typeof act.guid64 === "string" && hidden.has(key(object.object_id, act.guid64))));
    if (acts.length === object.acts.length) kept.push(object);
    else if (acts.length > 0) kept.push({ ...object, acts });
  }
  return kept;
}
