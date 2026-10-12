// What the W13 tools share: the world's context on each call, the refusals every game tool gives in the same words, and the
// probe version a verb needs. A tool refuses before it changes anything; the refusal says what to do next.

import type { DatabaseSync } from "node:sqlite";
import type { Receipt } from "../../contracts.js";

/** The lowest probe version whose commands the W13 tools send (the lists, the verbs, the sim picker). */
export const PROBE_NEEDED = "2.40.0";

/** What the W13 tools read on each call: null while the world is not running. */
export type GameContext = {
  db: DatabaseSync;
  nowMs: () => number;
  /** Whether the summoner's emergency stop is on right now. */
  stopped: () => boolean;
  /** The helper session that is attached now, or undefined when the game is not attached. */
  attachedSession: (nowMs: number) => string | undefined;
  /** The last time the game was attached. */
  lastAttachedMs: () => number | undefined;
  /** The probe version a helper session's heartbeats named, or undefined. */
  probeOf: (session: string) => string | undefined;
  /** The time of the summoner's last message, or undefined when there is none yet. */
  ownerMs: () => number | undefined;
} | null;

export function refused(code: string, reason: string): Receipt {
  return { ok: false, summary: reason, refused: { code, reason } };
}

/** Whether a probe version is at least the needed one ("2.40.0" or later). An unreadable version is not. */
export function probeAtLeast(version: string | undefined, needed: string = PROBE_NEEDED): boolean {
  if (version === undefined) return false;
  const have = version.split(".").map((part) => Number(part));
  const want = needed.split(".").map((part) => Number(part));
  if (have.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < want.length; index++) {
    const a = have[index] ?? 0;
    const b = want[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The refusal that keeps a game tool from acting: the emergency stop (it refuses acts only; a read passes with reads: true), a
 * game that is not attached, or (for a tool that sends a probe command) a probe older than PROBE_NEEDED. Undefined when the
 * tool may go on; the attached session is then attachedSession(now).
 */
export function gameGate(game: NonNullable<GameContext>, options: { probe: boolean; reads?: boolean }): Receipt | undefined {
  if (!options.reads && game.stopped()) return refused("stopped", "The summoner's emergency stop is on, so the game is not asked.");
  const nowMs = game.nowMs();
  const session = game.attachedSession(nowMs);
  if (session === undefined) {
    const last = game.lastAttachedMs();
    const when = last === undefined ? "It has not been attached since this world started." : `It was last attached at ${new Date(last).toISOString()}.`;
    return refused("not_attached", `The game is not attached, so nothing was asked. ${when}`);
  }
  if (options.probe && !probeAtLeast(game.probeOf(session))) {
    if (game.probeOf(session) === undefined) {
      return refused("probe_too_old", "The link to the game has not said what the game's side is, so this is not asked. Nothing was asked.");
    }
    return refused("probe_too_old", "The game's side is too old for this, and it needs an update. Nothing was asked.");
  }
  return undefined;
}

/** A ref the tool was given that the attached game's lists or answers do not hold: the refusal names the tool that refreshes it. */
export function staleRef(ref: string, refreshedBy: string): Receipt {
  return refused("stale_list", `${ref} is not in the game's current list. ${refreshedBy} shows the current one; choose from it again.`);
}
