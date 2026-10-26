// An act the game refused twice in one game session is no longer offered in that session (live 2026-10-26: she chose
// "Cancel (queued): stand Passive" three times and each was refused, NO_INTERACTION). A new session (attachment) starts over.

import type { DatabaseSync } from "node:sqlite";
import type { OptionObject } from "./answers.js";

/** Refusals of one act, in one session, after which the act is not offered again in that session. */
export const HIDE_AFTER_REFUSALS = 2;
/** The probe's refusals that say the game cannot do this act now; a busy body or a paused clock does not count. */
const HIDING_CODES: ReadonlySet<string> = new Set(["NO_INTERACTION", "GAME_REFUSED"]);

const key = (objectId: string, guid64: string): string => `${objectId}\u0000${guid64}`;

/** The acts (object id and guid64) refused at least HIDE_AFTER_REFUSALS times in this attachment. */
export function refusedKeys(db: DatabaseSync, attachment: string): Set<string> {
  const rows = db.prepare(`SELECT a.object_id AS object_id, a.guid64 AS guid64, e.detail_json AS detail_json
    FROM acts a JOIN act_events e ON e.act_id = a.act_id AND e.phase = 'rejected' WHERE a.attachment = ?`).all(attachment);
  const counts = new Map<string, number>();
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
  }
  return new Set([...counts].filter(([, count]) => count >= HIDE_AFTER_REFUSALS).map(([k]) => k));
}

/** The options without the acts the game refused twice in this attachment; an object left with no acts is dropped. */
export function withoutRefused(db: DatabaseSync, attachment: string, options: readonly OptionObject[]): OptionObject[] {
  const hidden = refusedKeys(db, attachment);
  if (hidden.size === 0) return [...options];
  const kept: OptionObject[] = [];
  for (const object of options) {
    const acts = object.acts.filter((act) => !(act && typeof act.guid64 === "string" && hidden.has(key(object.object_id, act.guid64))));
    if (acts.length === object.acts.length) kept.push(object);
    else if (acts.length > 0) kept.push({ ...object, acts });
  }
  return kept;
}
