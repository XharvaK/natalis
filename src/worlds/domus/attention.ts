// Her attention to the game: whether a change in the game wakes her turn. The body sends every change; the setting is
// hers, kept per game thread in domus.sqlite, and changed only by her game_attention tool. The body never picks a
// mode, ranks what matters, or decides for her. A view's wake rule reads only facts about the change: a question put
// to her, someone speaking to her, someone arriving, a day's record, the first view after attach, a look she asked for.

import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { parseAtIso } from "../../entity/wake-schedule.js";
import { gameThreadNow, lastLookHanded, lookOwed, oweLook, readAtWork, readAttention, writeAtWork, writeAttention, type AttentionMode, type AttentionRow } from "./store.js";
import type { Percept } from "./wire.js";

export const LOOK_MIN = 5;
export const LOOK_MAX = 240;
/** A quiet may run at most this far ahead. */
export const UNTIL_MAX_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const MODES: readonly AttentionMode[] = ["every_change", "when_called", "quiet"];
const ARG_KEYS = new Set(["mode", "until", "look_every_minutes"]);

/** What the world reads about a view to decide whether it wakes her. */
export type ViewFacts = {
  percepts: readonly Percept[];
  /** The portrait the helper sent with the view, as it came. */
  portrait: unknown;
  /** Whether the view carries the day's record (a sleep onset). */
  dayRecord: boolean;
  /** Whether her job was at work in the game thread's last view and is not now (see workEnded). */
  workEnded: boolean;
  /** Whether the view is the first from the helper session the game is attached under now. */
  firstAfterAttach: boolean;
};

/**
 * The context the tool reads on each call: null while the world is not running. The setting is kept on the game's thread
 * (see gameThreadNow), whichever thread asks; the helper session that is attached now finds that thread.
 */
export type AttentionContext = {
  db: DatabaseSync; nowMs: () => number; timeZone: string | undefined; attachedSession: (nowMs: number) => string | undefined;
} | null;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A window held for her: an open question in the portrait that is held for her. */
function heldForHer(portrait: unknown): boolean {
  const asked = asRecord(portrait)?.asked;
  return Array.isArray(asked) && asked.some((item) => asRecord(item)?.held === true);
}

function isDistress(item: Percept): boolean {
  return item.kind === "need" && item.facts["band"] === "distress";
}

/** Whether any need in the portrait is in distress now. */
function needInDistress(portrait: unknown): boolean {
  const needs = asRecord(asRecord(portrait)?.needs);
  return needs !== undefined && Object.values(needs).some((entry) => asRecord(entry)?.band === "distress");
}

/**
 * Whether a view wakes her in this mode. A question put to her, a look she asked for, and a call or a notice on her phone
 * always wake her, in every mode (the body's alarm, as a held window is: she may still do nothing, D1). A need that has just
 * gone into distress wakes her in every mode but quiet: quiet means quiet (Q-1).
 * Otherwise every_change wakes her on every view, quiet on none, and when_called on a call (someone addressed her,
 * someone arrived or is on the lot, the day's record, the first view after the game attached).
 *
 * At work the game looks after her needs in the rabbit hole, so a distress does not wake her at work in any mode: a view
 * whose only changes are distress needs stays quiet. When work ends with a need still in distress, she wakes once.
 */
export function wakesFor(mode: AttentionMode, view: ViewFacts): boolean {
  if (view.percepts.some((item) => item.kind === "look")) return true;
  if (view.percepts.some((item) => item.kind === "env" && item.facts["bucket"] === "asked")) return true;
  if (heldForHer(view.portrait)) return true;
  // A notice on her phone or a call held for her is hers to answer in every mode, at work too (W13).
  if (view.percepts.some((item) => item.kind === "phone" && (item.facts["what"] === "notice" || item.facts["what"] === "call"))) return true;
  const atWork = atWorkNow(view.portrait);
  if (mode !== "quiet" && !atWork && view.percepts.some(isDistress)) return true;
  if (view.workEnded && needInDistress(view.portrait)) return true;
  if (mode === "every_change") return !(atWork && view.percepts.length > 0 && view.percepts.every(isDistress));
  if (mode === "quiet") return false;
  if (view.firstAfterAttach || view.dayRecord) return true;
  return view.percepts.some((item) =>
    (item.kind === "social" && item.facts["bucket"] === "addressed")
    || (item.kind === "presence" && (item.facts["bucket"] === "arrived" || item.facts["bucket"] === "on_lot"))
    || item.kind === "sleep_onset");
}

/** Whether any of her jobs in the portrait is at work now (the job's at_work flag). */
function atWorkNow(portrait: unknown): boolean {
  const jobs = asRecord(asRecord(portrait)?.self)?.jobs;
  return Array.isArray(jobs) && jobs.some((job) => asRecord(job)?.at_work === true);
}

/**
 * Whether her job was at work in the game thread's last view and is not now, so a work end is seen once. The state is kept
 * per thread in domus.sqlite (work_watch), so a restart keeps it. A view that reads no job leaves the thread as it was.
 */
export function workEnded(db: DatabaseSync, thread: string, portrait: unknown): boolean {
  const jobs = asRecord(asRecord(portrait)?.self)?.jobs;
  if (!Array.isArray(jobs)) return false;
  const now = atWorkNow(portrait);
  const before = readAtWork(db, thread);
  writeAtWork(db, thread, now);
  return before === true && !now;
}

function localParts(ms: number, timeZone: string | undefined): Record<string, string> {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-GB", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return parts;
}

/** A time for a quiet: the clock alone when it is today in the Lar's zone, else the date and the clock. */
function untilWords(untilMs: number, nowMs: number, timeZone: string | undefined): string {
  const until = localParts(untilMs, timeZone);
  const now = localParts(nowMs, timeZone);
  const clock = `${until["hour"] ?? "00"}:${until["minute"] ?? "00"}`;
  const today = until["year"] === now["year"] && until["month"] === now["month"] && until["day"] === now["day"];
  return today ? clock : `${until["year"]}-${until["month"]}-${until["day"]} ${clock}`;
}

/** Her attention in plain words, with the look when there is one: "every change, and a look every 30 minutes". */
export function attentionWords(row: AttentionRow, nowMs: number, timeZone: string | undefined): string {
  const base = row.mode === "every_change" ? "every change"
    : row.mode === "when_called" ? "when something calls you"
      : `quiet until ${untilWords(row.quietUntilMs ?? nowMs, nowMs, timeZone)}`;
  return row.lookEveryMinutes > 0 ? `${base}, and a look every ${row.lookEveryMinutes} minutes` : base;
}

/** The body block's first line. */
export function attentionLine(row: AttentionRow, nowMs: number, timeZone: string | undefined): string {
  return `Your attention: ${attentionWords(row, nowMs, timeZone)}.`;
}

/**
 * The setting as it is now. A quiet whose time has passed reverts to the mode it had before, and that is written down.
 * Called on the timed pass, when a view arrives, when the body block is shown, and when she changes it.
 */
export function currentAttention(db: DatabaseSync, thread: string, nowMs: number): AttentionRow {
  const row = readAttention(db, thread);
  if (row.mode !== "quiet" || row.quietUntilMs === undefined || row.quietUntilMs > nowMs) return row;
  const reverted: AttentionRow = { ...row, mode: row.resumeMode, quietUntilMs: undefined };
  writeAttention(db, reverted);
  return reverted;
}

/**
 * The timed pass (also run at each helper sync): reverts the quiets whose time has passed, and owes a look to the
 * attached helper session for each thread that asked for one after a gap with no waking view, unless one is owed
 * already. The gap runs from the last waking view, the last look handed over, or the setting, whichever is newest.
 */
export function reviewAttention(db: DatabaseSync, nowMs: number, attachedSession: string | undefined): void {
  for (const row of db.prepare("SELECT thread FROM game_attention WHERE mode = 'quiet' AND quiet_until_ms <= ?").all(nowMs) as Array<{ thread: string }>) {
    currentAttention(db, String(row.thread), nowMs);
  }
  if (attachedSession === undefined) return;
  if (lookOwed(db, attachedSession)) return;
  const handed = lastLookHanded(db, attachedSession);
  for (const row of db.prepare("SELECT thread FROM game_attention WHERE look_every_minutes > 0").all() as Array<{ thread: string }>) {
    const attention = readAttention(db, String(row.thread));
    const since = Math.max(attention.setAtMs, attention.lastWakeMs ?? 0, handed ?? 0);
    if (nowMs - since >= attention.lookEveryMinutes * MINUTE_MS) {
      oweLook(db, attachedSession);
      return;
    }
  }
}

function isMode(value: unknown): value is AttentionMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function refused(code: string, reason: string): Receipt {
  return { ok: false, summary: reason, refused: { code, reason } };
}

const SET_UP =
  "Set how the game reaches you. Always, in every mode: a question the game holds open for you, a call or a notice on your " +
  "phone, and a look you asked for. When work ends with a need still in distress you wake once, in every mode. " +
  "Except in quiet, a need that goes into distress wakes you when you are not at work. " +
  "every_change (the default): every other change in the game wakes you too; at work, a view whose only changes are needs " +
  "in distress stays quiet. " +
  "when_called: otherwise a change wakes you only when something calls you: someone speaking to you, someone arriving on the " +
  "lot or being on it, the day's record at sleep, or the first view after the game attached. " +
  "quiet: otherwise nothing wakes you until, then the mode goes back to what it was. " +
  "until is a date and time, such as 2026-10-12T14:30, in your own zone unless it has an offset, at most 24 hours ahead; " +
  "it goes with quiet only. " +
  "Changes still reach the game's thread, and you see them by their brief in your next turn. look_every_minutes (5 to 240, " +
  "or 0 for off) asks the game for a fresh view while it is attached and nothing has woken you for that long.";

export function gameAttentionTool(open: () => AttentionContext): Tool {
  return {
    spec: {
      name: "game_attention",
      description: SET_UP,
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...MODES], description: "every_change, when_called or quiet." },
          until: { type: "string", description: "For quiet only: a date and time, such as 2026-10-12T14:30." },
          look_every_minutes: { type: "integer", description: "0 for off, or 5 to 240." },
        },
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameAttention(open, args, context);
    },
  };
}

function gameAttention(open: () => AttentionContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  for (const key of Object.keys(args)) {
    if (!ARG_KEYS.has(key)) return refused("bad_args", `${key} is not a field of game_attention.`);
  }
  const mode = isMode(args.mode) ? args.mode : undefined;
  if (args.mode !== undefined && mode === undefined) return refused("bad_args", "mode must be every_change, when_called or quiet.");
  const look = args.look_every_minutes;
  const lookOk = look === undefined || (typeof look === "number" && Number.isInteger(look)
    && (look === 0 || (look >= LOOK_MIN && look <= LOOK_MAX)));
  if (!lookOk) {
    return refused("bad_args", `look_every_minutes must be 0 (off) or a whole number from ${LOOK_MIN} to ${LOOK_MAX}.`);
  }
  if (mode === undefined && look === undefined) return refused("bad_args", "Give mode, look_every_minutes, or both.");
  const until = args.until;
  if (mode === "quiet" && until === undefined) return refused("bad_args", "quiet needs until: a date and time, such as 2026-10-12T14:30.");
  if (mode !== "quiet" && until !== undefined) return refused("bad_args", "until goes with quiet only.");

  const nowMs = game.nowMs();
  let untilMs: number | undefined;
  if (until !== undefined) {
    const parsed = typeof until === "string" ? parseAtIso(until, game.timeZone) : Number.NaN;
    if (!Number.isFinite(parsed)) return refused("bad_args", "until must be a date and time, such as 2026-10-12T14:30.");
    if (parsed <= nowMs) return refused("bad_args", "until must be later than now.");
    if (parsed - nowMs > UNTIL_MAX_MS) return refused("bad_args", "until can be at most 24 hours ahead.");
    untilMs = parsed;
  }

  const thread = gameThreadNow(game.db, game.attachedSession(nowMs));
  if (thread === undefined) {
    return refused("no_view", "The game has not shown you a view yet, so there is no game thread to set your attention on.");
  }
  const current = currentAttention(game.db, thread, nowMs);
  const next: AttentionRow = { ...current, setAtMs: nowMs };
  if (mode === "quiet") {
    next.resumeMode = current.mode === "quiet" ? current.resumeMode : current.mode;
    next.mode = "quiet";
    next.quietUntilMs = untilMs;
  } else if (mode !== undefined) {
    next.mode = mode;
    next.resumeMode = mode;
    next.quietUntilMs = undefined;
  }
  if (typeof look === "number") next.lookEveryMinutes = look;
  writeAttention(game.db, next);
  return {
    ok: true,
    summary: `Your attention is now: ${attentionWords(next, nowMs, game.timeZone)}.`,
    data: { mode: next.mode, quietUntilMs: next.quietUntilMs ?? null, lookEveryMinutes: next.lookEveryMinutes },
  };
}
