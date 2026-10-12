// The Lar's acts in the game. The Lar names an option from the newest view of its game thread; the world keeps
// it as a requested act; the helper pulls it on its next sync and reports back what the game did. Each report is
// a note on the game thread. Nothing here chooses an act: the Lar chose it, the game did it or did not.
//
// Phases move forward only, a terminal phase is not overwritten, and a late report is still kept. A plan is the
// first act and up to two more: each later one is requested only after the one before completed. A refusal, an
// unknown or a cut-short act ends the plan. A new choice replaces whatever a plan still waited to do.
//
// Source: the old listener's acts (same phase rules, same expiry, same plan rules). Where the design and that source
// disagree, the source was followed; see the report on the Domus world.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Found, StoredAnswer } from "./answers.js";
import { endingOf } from "./endings.js";
import { labelOf } from "./options.js";
import { inTransaction, type Row } from "./store.js";
import { isRecord, type DomusActPhase, type SyncEvent } from "./wire.js";

/** A requested act the helper does not pick up within this time expires; the game never sees it. */
export const ACT_TTL_MS = 90_000;
/** A plan's waiting steps are released only while the plan is this young; an older plan is let go whole. */
export const PLAN_STEP_MAX_MS = 5 * 60 * 1000;
/** A plan is the first act and at most this many more. */
export const PLAN_MORE = 2;
/** Another thread's request for the game within this time holds a new act, unless the Lar says it knowingly. */
export const ACT_MEANWHILE_MS = 60_000;

const TERMINAL: ReadonlySet<string> = new Set(["rejected", "finished", "unknown", "expired"]);
const RANK: Readonly<Record<string, number>> = { requested: 0, received: 1, accepted: 2, pushed: 3 };
/**
 * An unknown the helper guessed is not final: the game was detached, it never answered, or the helper's session ended
 * while the act was in flight (the game may still report how it ended).
 */
const GUESSED_UNKNOWN_CODES: ReadonlySet<string> = new Set(["GAME_DETACHED", "NO_PROBE_REPLY", "SESSION_ENDED"]);
const REPLACES_GUESS: ReadonlySet<string> = new Set(["received", "accepted", "pushed", "waiting", "noted", "finished", "rejected"]);
/** States in which an act is still going to the game or has gone: the ones another thread's request holds for (B11). */
const LIVE_STATES: readonly string[] = ["requested", "received", "accepted", "pushed", "waiting", "noted", "finished"];
/** States in which the helper holds an act it has not reported finished: its session ending makes the act unknown. */
const IN_FLIGHT_STATES: readonly string[] = ["received", "accepted", "pushed", "waiting", "noted"];
/**
 * Every final phase wakes the Lar's thread, a finished act included: whatever way an act ended, the Lar should act on it.
 * The phases before the end (received, accepted, pushed) are kept as notes for its next turn and do not wake it.
 */
const WAKING: ReadonlySet<string> = new Set(["rejected", "finished", "unknown", "expired"]);

/** A note for the game thread: an act's report, or a plan that stopped. It becomes a body row there. */
export type ThreadNote = { thread: string; text: string; data: Record<string, unknown>; wake: boolean };

export type SyncAct = {
  act_id: string;
  object_id: string;
  /** A game act's guid. A verb act carries none (see verb). */
  guid64?: string;
  expires_at_ms: number;
  owner?: true;
  answer?: StoredAnswer;
  /** Her own words to the Sim the act targets, when she gave some (S1). */
  words?: string;
  /** A game act that opens a Sim picker: the Sim she chose (digits). */
  sim_id?: string;
  /** A home or travel verb (W13): the probe command, and its args without act_id. */
  verb?: string;
  args?: Record<string, unknown>;
};

export type RequestInput = {
  thread: string;
  turnId: string;
  attachment: string;
  observationId: string;
  found: Found;
  label: string;
  forSummoner: boolean;
  answer?: { json: string };
  /** Her words to the Sim the act targets (1 to 240 characters); the game's social act still decides what happens. */
  words?: string;
  /** The Sim she chose for a game act that needs one (a people ref, resolved by the caller to the sim id). */
  simId?: string;
  /** The plan's later steps, already resolved against the same view. */
  then: Array<{ ref: string; found: Found }>;
  nowMs: number;
};

export type RequestResult =
  | { ok: true; actId: string; expiresAtMs: number; steps: Array<{ ref: string; label: string }> }
  | { ok: false; code: "one_act_per_turn" | "answer_repeated" };

/** A reason a waiting plan step is let go, in the words the Lar reads. */
const DROP_REASON: Readonly<Record<string, string>> = {
  session_ended: "the game's session ended",
  too_old: "it was more than five minutes old",
  after_rejected: "the game refused the act before it",
  after_unknown: "nobody knows how the act before it ended",
  after_expired: "the act before it expired before the game picked it up",
  after_cut_short: "the act before it was cut short",
  stopped: "your summoner's stop is on",
  undone: "the game went back before the view it was chosen from",
  forgotten: "its words were forgotten",
};

function insertAct(db: DatabaseSync, row: {
  actId: string; turnId: string; thread: string; attachment: string; observationId: string | null; ref: string;
  objectId: string; guid64: string; label: string; nowMs: number; forSummoner: boolean; answerJson: string | null; words: string | null;
  verb: string | null; argsJson: string | null;
}): void {
  db.prepare(`INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state,
    requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json, words, verb, args_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.actId, row.turnId, row.thread, row.attachment, row.observationId, row.ref, row.objectId, row.guid64, row.label,
      row.nowMs, row.nowMs + ACT_TTL_MS, row.nowMs, row.forSummoner ? 1 : 0, row.answerJson, row.words, row.verb, row.argsJson);
}

/**
 * The newest request of any other thread of hers within ACT_MEANWHILE_MS that is still live, or undefined. A refused,
 * expired or withdrawn request holds nobody (B11). A released plan step is an act row of the thread that planned it, so it
 * counts as that thread's request, at the time it was released.
 */
export function actRequestedMeanwhile(db: DatabaseSync, input: { thread: string; nowMs: number }): {
  thread: string; label: string; requestedAtMs: number;
} | undefined {
  const live = LIVE_STATES.map(() => "?").join(", ");
  const row = db.prepare(`SELECT thread, label, requested_at_ms FROM acts WHERE thread != ? AND requested_at_ms >= ?
    AND state IN (${live}) AND (state != 'requested' OR expires_at_ms > ?)
    ORDER BY requested_at_ms DESC, act_id LIMIT 1`)
    .get(input.thread, input.nowMs - ACT_MEANWHILE_MS, ...LIVE_STATES, input.nowMs) as Row | undefined;
  if (!row) return undefined;
  return { thread: String(row.thread), label: String(row.label), requestedAtMs: Number(row.requested_at_ms) };
}

/**
 * Keeps the Lar's choice as a requested act, with its plan. A new choice replaces what an earlier plan still waited
 * to do. One act per turn: a second act in the same turn is refused, not queued behind the first. An answer is a reply
 * to a question the game holds open, not an act: it is not held by the one-act rule, and one answer per question per turn.
 */
export function requestAct(db: DatabaseSync, input: RequestInput): RequestResult {
  return inTransaction(db, () => {
    if (input.answer !== undefined) {
      if (db.prepare("SELECT 1 FROM acts WHERE turn_id = ? AND object_id = ? AND answer_json IS NOT NULL LIMIT 1")
        .get(input.turnId, input.found.object.object_id)) {
        return { ok: false as const, code: "answer_repeated" as const };
      }
    } else if (db.prepare(`SELECT 1 FROM acts WHERE turn_id = ? AND answer_json IS NULL AND (verb IS NULL OR verb IN (${SLOT_VERB_SQL})) LIMIT 1`)
      .get(input.turnId)) {
      return { ok: false as const, code: "one_act_per_turn" as const };
    }
    dropPlanned(db, { attachment: input.attachment, reason: "replaced", notify: false, nowMs: input.nowMs });
    const actId = randomUUID().replaceAll("-", "");
    insertAct(db, {
      actId, turnId: input.turnId, thread: input.thread, attachment: input.attachment, observationId: input.observationId,
      ref: input.found.act.ref, objectId: input.found.object.object_id, guid64: input.found.act.guid64, label: input.label,
      nowMs: input.nowMs, forSummoner: input.forSummoner, answerJson: input.answer?.json ?? null, words: input.words ?? null,
      verb: null, argsJson: input.simId === undefined ? null : JSON.stringify({ args: { sim_id: input.simId } }),
    });
    const steps = input.then.slice(0, PLAN_MORE).map((step, index) => {
      const label = labelOf(step.found);
      db.prepare(`INSERT INTO plan_steps (plan_id, step, thread, attachment, option_ref, object_id, guid64, label, for_summoner,
        state, reason, act_id, planned_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, ?)`)
        .run(actId, index + 1, input.thread, input.attachment, step.ref, step.found.object.object_id, step.found.act.guid64,
          label, input.forSummoner ? 1 : 0, input.nowMs, input.nowMs);
      return { ref: step.ref, label };
    });
    return { ok: true as const, actId, expiresAtMs: input.nowMs + ACT_TTL_MS, steps };
  });
}

/** The home edits one turn may make (buy, place, move, sell): each has its own receipt and is not held by the one-act rule. */
export const HOME_EDITS_PER_TURN = 6;
/** The verbs that are home edits (see HOME_EDITS_PER_TURN). */
export const HOME_VERBS: readonly string[] = ["buy", "place", "move", "sell"];
/** The verbs that hold the one-act slot of a turn, as a game act does: travel, saving and planning an event. */
export const SLOT_VERBS: readonly string[] = ["go", "save", "event"];
const SLOT_VERB_SQL = SLOT_VERBS.map((verb) => `'${verb}'`).join(", ");
const HOME_VERB_SQL = HOME_VERBS.map((verb) => `'${verb}'`).join(", ");

export type VerbInput = {
  thread: string;
  turnId: string;
  attachment: string;
  /** The newest view the choice was made on, or null when the game has shown none yet. */
  observationId: string | null;
  verb: string;
  label: string;
  /** The thing the verb is about (a thing\x27s id), or "0" when it is about none. */
  objectId: string;
  /** The probe command\x27s args, without act_id. */
  args: Record<string, unknown>;
  /** What the Lar\x27s side keeps and the helper never sees (the summoner\x27s last message, for travel). */
  record?: Record<string, unknown>;
  nowMs: number;
};

export type VerbResult =
  | { ok: true; actId: string; expiresAtMs: number }
  | { ok: false; code: "one_act_per_turn" | "home_edits_full" };

/**
 * Keeps a home or travel verb as a requested act (W13). Travel, saving and planning an event hold the turn\x27s one-act slot,
 * as a game act does, and replace what a plan still waited to do. A home edit does neither: it is counted, and a turn may
 * make HOME_EDITS_PER_TURN of them.
 */
export function requestVerb(db: DatabaseSync, input: VerbInput): VerbResult {
  return inTransaction(db, () => {
    const holdsSlot = SLOT_VERBS.includes(input.verb);
    if (holdsSlot) {
      if (db.prepare(`SELECT 1 FROM acts WHERE turn_id = ? AND answer_json IS NULL AND (verb IS NULL OR verb IN (${SLOT_VERB_SQL})) LIMIT 1`)
        .get(input.turnId)) {
        return { ok: false as const, code: "one_act_per_turn" as const };
      }
      dropPlanned(db, { attachment: input.attachment, reason: "replaced", notify: false, nowMs: input.nowMs });
    } else {
      const edits = Number((db.prepare(`SELECT COUNT(*) AS n FROM acts WHERE turn_id = ? AND verb IN (${HOME_VERB_SQL})`)
        .get(input.turnId) as Row).n);
      if (edits >= HOME_EDITS_PER_TURN) return { ok: false as const, code: "home_edits_full" as const };
    }
    const actId = randomUUID().replaceAll("-", "");
    insertAct(db, {
      actId, turnId: input.turnId, thread: input.thread, attachment: input.attachment, observationId: input.observationId,
      ref: "", objectId: input.objectId, guid64: "", label: input.label, nowMs: input.nowMs, forSummoner: false,
      answerJson: null, words: null, verb: input.verb,
      argsJson: JSON.stringify({ args: input.args, ...(input.record ? { record: input.record } : {}) }),
    });
    return { ok: true as const, actId, expiresAtMs: input.nowMs + ACT_TTL_MS };
  });
}

/** The home edits a turn has made so far (refused ones are not kept, so these are the ones the game was asked for). */
export function homeEditsIn(db: DatabaseSync, turnId: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM acts WHERE turn_id = ? AND verb IN (${HOME_VERB_SQL})`).get(turnId) as Row).n);
}

/**
 * The time of her newest save that was not refused, or undefined. The save floor counts from it. A save the game refused, or
 * one that expired before the game took it up, is not a save.
 */
export function lastSaveAt(db: DatabaseSync): number | undefined {
  const row = db.prepare(`SELECT requested_at_ms FROM acts WHERE verb = 'save' AND state NOT IN ('rejected', 'expired')
    ORDER BY requested_at_ms DESC LIMIT 1`).get() as Row | undefined;
  return row === undefined ? undefined : Number(row.requested_at_ms);
}

// ---------------------------------------------------------------------------------------------------
// Phases.

function actRow(db: DatabaseSync, actId: string, attachment?: string): Row | undefined {
  return (attachment === undefined
    ? db.prepare("SELECT * FROM acts WHERE act_id = ?").get(actId)
    : db.prepare("SELECT * FROM acts WHERE act_id = ? AND attachment = ?").get(actId, attachment)) as Row | undefined;
}

/** The helper's own record of a finished act, or none. */
function finishedDetail(db: DatabaseSync, actId: string): Record<string, unknown> {
  const row = db.prepare("SELECT detail_json FROM act_events WHERE act_id = ? AND phase = 'finished'").get(actId) as Row | undefined;
  return parseDetail(row?.detail_json);
}

function parseDetail(json: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(json ?? "{}")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** An unknown the helper guessed (it never heard from the game), not the game's own verdict. */
function isGuessedUnknown(db: DatabaseSync, actId: string): boolean {
  const row = db.prepare("SELECT detail_json FROM act_events WHERE act_id = ? AND phase = 'unknown'").get(actId) as Row | undefined;
  if (!row) return false;
  const code = parseDetail(row.detail_json).code;
  return typeof code === "string" && GUESSED_UNKNOWN_CODES.has(code);
}

/**
 * An unknown that a later report may still settle: a guess (isGuessedUnknown), or one written before the game ever said
 * it pushed the act, so the act never reached her queue as far as anyone was told (B6).
 */
function isReplaceableUnknown(db: DatabaseSync, actId: string): boolean {
  if (isGuessedUnknown(db, actId)) return true;
  return db.prepare("SELECT 1 FROM act_events WHERE act_id = ? AND phase = 'pushed' LIMIT 1").get(actId) === undefined;
}

/**
 * An act of an earlier helper session that the session's end made unknown (SESSION_ENDED): a later report for it is
 * still taken, from the session that now holds it (B5). Any other act of another session is not.
 */
function sessionLostRow(db: DatabaseSync, actId: string): Row | undefined {
  const row = actRow(db, actId);
  if (!row || String(row.state) !== "unknown") return undefined;
  const unknown = db.prepare("SELECT detail_json FROM act_events WHERE act_id = ? AND phase = 'unknown'").get(actId) as Row | undefined;
  return parseDetail(unknown?.detail_json).code === "SESSION_ENDED" ? row : undefined;
}

/** The next state for a phase, or null when the phase does not move the act (it is kept all the same). */
export function nextState(current: string, phase: DomusActPhase, guessed: boolean): string | null {
  if (guessed && REPLACES_GUESS.has(phase)) return phase;
  if (TERMINAL.has(current)) return null;
  if (Object.prototype.hasOwnProperty.call(RANK, phase)) {
    return (RANK[phase] ?? -1) > (RANK[current] ?? -1) ? phase : null;
  }
  return phase;
}

function setState(db: DatabaseSync, actId: string, state: string, nowMs: number): void {
  db.prepare("UPDATE acts SET state = ?, updated_at_ms = ? WHERE act_id = ?").run(state, nowMs, actId);
}

/** Keeps one event (once per act and phase). Returns whether it was new. */
function keepEvent(db: DatabaseSync, actId: string, phase: string, atMs: number, nowMs: number, detail: Record<string, unknown>): boolean {
  const changed = db.prepare("INSERT OR IGNORE INTO act_events (act_id, phase, at_ms, received_at_ms, detail_json) VALUES (?, ?, ?, ?, ?)")
    .run(actId, phase, atMs, nowMs, JSON.stringify(detail));
  return Number(changed.changes) > 0;
}

/** Who refused an act, in words she reads. A refusal with no source named is said as that: it was refused. */
const REFUSED_BY: Readonly<Record<string, string>> = {
  game: "the game refused it",
  probe: "the game's side refused it",
  helper: "your helper refused it",
  host: "the host refused it",
};

/** The game's own sentence for a refusal (or the reason key's words), cleaned by the helper and cut here to 240 characters. */
function refusedText(detail: Record<string, unknown>): string | undefined {
  const text = typeof detail.text === "string" && detail.text.trim() !== "" ? detail.text.trim()
    : typeof detail.reason === "string" && detail.reason.trim() !== "" ? detail.reason.trim() : undefined;
  return text === undefined ? undefined : text.slice(0, 240);
}

function refusedSentence(detail: Record<string, unknown>): string {
  const code = typeof detail.code === "string" && detail.code ? ` (${detail.code})` : "";
  const text = refusedText(detail);
  const who = typeof detail.by === "string" ? REFUSED_BY[detail.by] : undefined;
  return `${who ?? "it was refused"}${code}${text === undefined ? "" : ` - ${text}`}`;
}

function phaseSentence(phase: DomusActPhase, detail: Record<string, unknown>, late: boolean): string {
  const code = typeof detail.code === "string" && detail.code ? ` (${detail.code})` : "";
  switch (phase) {
    case "received": return "your helper took it up and passed it on to the game";
    case "accepted": return "the game accepted it";
    case "pushed": return "the game put it in its queue";
    case "waiting": {
      const window = typeof detail.window === "string" && detail.window.trim() !== "" ? ` (${detail.window.trim().slice(0, 80)})` : "";
      return `a window is open on the game${window}, so the game keeps it out of your queue until the window closes`;
    }
    case "noted":
      if (detail.code === "SCREEN_WITHHELD") return "the game opened a screen you cannot use, so it was cancelled";
      return `the game noted something about it${code}`;
    case "finished": {
      if (detail.code === "ANSWER_SENT_OPEN") return "your answer was sent, but the game's question is still open";
      const ending = endingOf(detail.finishing_type, detail.started);
      if (ending.ended === "completed") return "it finished";
      if (ending.ended === "asked") return "it opened a question from the game, which you answer with game_act";
      if (ending.ended === "answered") return "you answered the game's question";
      return `it was cut short: ${ending.why ?? "the game ended it early"}`;
    }
    case "rejected": return refusedSentence(detail);
    case "unknown":
      // The game took the act out of its queue and never said how it ended: the words say only that.
      if (detail.code === "LEFT_QUEUE") {
        return "the game took it out of its queue and did not say how it ended; what changed in your next view tells what it did";
      }
      return `nothing says how it ended${code}${detail.reason ? ` - ${String(detail.reason).slice(0, 200)}` : ""}`;
    case "expired":
      if (detail.code === "STOPPED") return "it was withdrawn before the game picked it up, because your summoner's stop is on";
      if (detail.code === "UNDONE") return "it was withdrawn, because the game went back before the view you chose it from";
      if (detail.code === "FORGOTTEN") return "it was withdrawn before the game picked it up, because its words were forgotten";
      return late ? "it expired" : "it expired before the game picked it up";
  }
}

/**
 * A verb act\x27s words for its phase: a finished one says what the helper saw in the game (detail.result, in its words),
 * else that it finished; the other phases are the game act\x27s own sentences.
 */
function verbSentence(phase: DomusActPhase, detail: Record<string, unknown>, late: boolean): string {
  if (phase !== "finished") return phaseSentence(phase, detail, late);
  const result = typeof detail.result === "string" ? detail.result.trim().replace(/[.!?]+$/, "") : "";
  return result === "" ? "it finished" : result;
}

function noteFor(act: Row, phase: DomusActPhase, detail: Record<string, unknown>, late: boolean): ThreadNote {
  const label = String(act.label);
  const ref = String(act.option_ref);
  const verb = typeof act.verb === "string";
  const sentence = verb ? verbSentence(phase, detail, late) : phaseSentence(phase, detail, late);
  // Her own words to the Sim are kept on the act line (S1); they say what she said, not what the game did with it.
  const said = typeof act.words === "string" && act.words !== "" ? ` You said: "${act.words}".` : "";
  const named = verb ? `Your act "${label}"` : `Your act "${label}" (${ref})`;
  return {
    thread: String(act.thread),
    text: `${named}: ${sentence}${late ? " (this report came after the act had already ended)" : ""}.${said}`,
    data: verb
      ? { actId: String(act.act_id), verb: act.verb, phase, ...(late ? { late: true } : {}) }
      : { actId: String(act.act_id), option: ref, phase, ...(late ? { late: true } : {}) },
    wake: WAKING.has(phase),
  };
}

/**
 * One helper sync: its reports are kept (only for acts of its own attachment), the acts it may run are returned,
 * and the notes for the game thread come back with them. The helper gets the acts still requested for it, not expired.
 */
export function syncActs(db: DatabaseSync, input: { attachment: string; events: readonly SyncEvent[]; nowMs: number }): {
  applied: number; acts: SyncAct[]; planned: number; notes: ThreadNote[];
} {
  return inTransaction(db, () => {
    const notes: ThreadNote[] = [];
    let applied = 0;
    for (const event of input.events) {
      // A session that ended left its in-flight acts unknown, as a guess: a report for one of them still counts (B5).
      const act = actRow(db, event.actId, input.attachment) ?? sessionLostRow(db, event.actId);
      if (!act) continue;
      const actId = String(act.act_id);
      const detail = event.detail ?? {};
      if (!keepEvent(db, actId, event.phase, event.atMs, input.nowMs, detail)) continue;
      applied++;
      const current = String(act.state);
      const guessed = current === "unknown" && isReplaceableUnknown(db, actId);
      const next = nextState(current, event.phase, guessed);
      if (next !== null) setState(db, actId, next, input.nowMs);
      notes.push(noteFor(act, event.phase, detail, next === null));
    }
    notes.push(...expireRequested(db, input.nowMs));
    // Acts still in flight from an earlier helper session can no longer be told about: unknown, as a guess, so a later
    // report can still settle them. Requested acts the old session had already taken (pulled) are in flight too.
    const orphans = db.prepare(`SELECT act_id FROM acts WHERE attachment != ? AND (state IN (${IN_FLIGHT_STATES.map(() => "?").join(", ")})
      OR (state = 'requested' AND pulled_at_ms IS NOT NULL))`).all(input.attachment, ...IN_FLIGHT_STATES) as Row[];
    for (const orphan of orphans) {
      const actId = String(orphan.act_id);
      keepEvent(db, actId, "unknown", input.nowMs, input.nowMs, { code: "SESSION_ENDED" });
      setState(db, actId, "unknown", input.nowMs);
      const act = actRow(db, actId);
      if (act) notes.push(noteFor(act, "unknown", { code: "SESSION_ENDED" }, false));
    }
    dropPlanned(db, { notAttachment: input.attachment, reason: "session_ended", notify: true, nowMs: input.nowMs }, notes);
    releasePlans(db, { attachment: input.attachment, nowMs: input.nowMs }, notes);
    const acts = (db.prepare(`SELECT act_id, object_id, guid64, expires_at_ms, for_summoner, answer_json, words, verb, args_json FROM acts
      WHERE attachment = ? AND state = 'requested' AND expires_at_ms > ? ORDER BY requested_at_ms, act_id`)
      .all(input.attachment, input.nowMs) as Row[]).map((row): SyncAct => {
      const answer = row.answer_json === null || row.answer_json === undefined ? undefined : parseDetail(row.answer_json) as StoredAnswer;
      // The helper's pull is recorded here: from now on the act is the helper's, and its report is owed (B8).
      db.prepare("UPDATE acts SET pulled_at_ms = ? WHERE act_id = ? AND pulled_at_ms IS NULL").run(input.nowMs, String(row.act_id));
      const stored = parseDetail(row.args_json);
      const args = isRecord(stored.args) ? stored.args : {};
      if (typeof row.verb === "string") {
        // A verb act: no guid; its args are the probe command's, and the record (kept here only) stays behind.
        return {
          act_id: String(row.act_id), object_id: String(row.object_id), verb: row.verb, args,
          expires_at_ms: Number(row.expires_at_ms),
          ...(Number(row.for_summoner) === 1 ? { owner: true as const } : {}),
        };
      }
      return {
        act_id: String(row.act_id), object_id: String(row.object_id), guid64: String(row.guid64),
        expires_at_ms: Number(row.expires_at_ms),
        ...(Number(row.for_summoner) === 1 ? { owner: true as const } : {}),
        ...(answer !== undefined && Object.keys(answer).length > 0 ? { answer } : {}),
        ...(typeof row.words === "string" && row.words !== "" ? { words: row.words } : {}),
        ...(typeof args.sim_id === "string" ? { sim_id: args.sim_id } : {}),
      };
    });
    const planned = Number((db.prepare("SELECT COUNT(*) AS n FROM plan_steps WHERE attachment = ? AND state = 'planned'")
      .get(input.attachment) as Row).n);
    return { applied, acts, planned, notes };
  });
}

/**
 * Requested acts whose time is up expire here, whoever asks: the game never sees them. An act the helper has pulled is
 * the helper's: its time runs from the pull (a full TTL), so a report that is a little late does not leave the act expired
 * while the game runs it (B8).
 */
function expireRequested(db: DatabaseSync, nowMs: number): ThreadNote[] {
  const stale = db.prepare(`SELECT * FROM acts WHERE state = 'requested'
    AND (CASE WHEN pulled_at_ms IS NULL THEN expires_at_ms ELSE pulled_at_ms + ? END) <= ?`).all(ACT_TTL_MS, nowMs) as Row[];
  return stale.map((row) => {
    const actId = String(row.act_id);
    keepEvent(db, actId, "expired", nowMs, nowMs, {});
    setState(db, actId, "expired", nowMs);
    return noteFor(row, "expired", {}, false);
  });
}

// ---------------------------------------------------------------------------------------------------
// Plans.

/** Lets go of the planned steps that match. A dropped plan says why, once, unless the Lar itself replaced it. */
function dropPlanned(db: DatabaseSync, input: { attachment?: string; notAttachment?: string; reason: string; notify: boolean; nowMs: number },
  notes: ThreadNote[] = []): void {
  const where = input.attachment !== undefined ? "attachment = ?" : "attachment != ?";
  const value = input.attachment ?? input.notAttachment ?? "";
  const dropping = db.prepare(`SELECT plan_id, step, thread, label FROM plan_steps WHERE state = 'planned' AND ${where}
    ORDER BY plan_id, step`).all(value) as Row[];
  if (dropping.length === 0) return;
  db.prepare(`UPDATE plan_steps SET state = 'dropped', reason = ?, updated_at_ms = ? WHERE state = 'planned' AND ${where}`)
    .run(input.reason, input.nowMs, value);
  if (!input.notify) return;
  const seen = new Set<string>();
  for (const step of dropping) {
    const planId = String(step.plan_id);
    if (seen.has(planId)) continue;
    seen.add(planId);
    notes.push(planNote(step, input.reason));
  }
}

function planNote(step: Row, reason: string): ThreadNote {
  const why = DROP_REASON[reason] ?? "the plan could not go on";
  return {
    thread: String(step.thread),
    text: `Your plan stopped before "${String(step.label)}": ${why}. It was not requested.`,
    data: { planId: String(step.plan_id), step: Number(step.step), reason },
    wake: false,
  };
}

/** Requests the next step of each plan when the act before it completed; ends the plan when that act did not. */
function releasePlans(db: DatabaseSync, scope: { attachment?: string; nowMs: number }, notes: ThreadNote[]): void {
  const plans = (scope.attachment === undefined
    ? db.prepare("SELECT DISTINCT plan_id FROM plan_steps WHERE state = 'planned'").all()
    : db.prepare("SELECT DISTINCT plan_id FROM plan_steps WHERE state = 'planned' AND attachment = ?").all(scope.attachment)) as Row[];
  for (const plan of plans) releasePlan(db, String(plan.plan_id), scope.nowMs, notes);
}

function releasePlan(db: DatabaseSync, planId: string, nowMs: number, notes: ThreadNote[]): void {
  const steps = db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step").all(planId) as Row[];
  const next = steps.find((step) => String(step.state) === "planned");
  if (!next) return;
  const nextStep = Number(next.step);
  const previous = nextStep === 1 ? undefined : steps.find((step) => Number(step.step) === nextStep - 1);
  if (previous && String(previous.state) !== "released") return;
  const headId = previous ? String(previous.act_id) : planId;
  const head = actRow(db, headId);
  if (!head) return;
  const headState = String(head.state);
  // The step is aged from the end of the act before it, not from the time it was chosen (B7): a long first act does not
  // let the rest go. While that act still runs, the step waits.
  if (!TERMINAL.has(headState)) return;
  if (nowMs - Number(head.updated_at_ms) > PLAN_STEP_MAX_MS) {
    dropPlanSteps(db, planId, "too_old", nowMs, notes, next);
    return;
  }
  if (headState === "finished") {
    const finished = finishedDetail(db, headId);
    const ending = endingOf(finished.finishing_type, finished.started);
    if (ending.ended === "completed" || ending.ended === "asked" || ending.ended === "answered") {
      const actId = randomUUID().replaceAll("-", "");
      insertAct(db, {
        actId, turnId: `plan:${planId}:${nextStep}`, thread: String(next.thread), attachment: String(next.attachment),
        observationId: head.observation_id === null ? null : String(head.observation_id), ref: String(next.option_ref),
        objectId: String(next.object_id), guid64: String(next.guid64), label: String(next.label), nowMs,
        forSummoner: Number(next.for_summoner) === 1, answerJson: null, words: null, verb: null, argsJson: null,
      });
      db.prepare("UPDATE plan_steps SET state = 'released', act_id = ?, updated_at_ms = ? WHERE plan_id = ? AND step = ?")
        .run(actId, nowMs, planId, nextStep);
      return;
    }
    dropPlanSteps(db, planId, "after_cut_short", nowMs, notes, next);
    return;
  }
  if (headState === "unknown" && isGuessedUnknown(db, headId)) return;
  dropPlanSteps(db, planId, `after_${headState}`, nowMs, notes, next);
}

function dropPlanSteps(db: DatabaseSync, planId: string, reason: string, nowMs: number, notes: ThreadNote[], first: Row): void {
  db.prepare("UPDATE plan_steps SET state = 'dropped', reason = ?, updated_at_ms = ? WHERE plan_id = ? AND state = 'planned'")
    .run(reason, nowMs, planId);
  notes.push(planNote(first, reason));
}

/**
 * The timer's pass between syncs: expires the requests whose time is up and moves plans on, so the Lar hears of an
 * expired act even while the helper is detached.
 */
export function expireDue(db: DatabaseSync, nowMs: number): ThreadNote[] {
  return inTransaction(db, () => {
    const notes = expireRequested(db, nowMs);
    releasePlans(db, { nowMs }, notes);
    return notes;
  });
}

/**
 * While the summoner's stop is on, nothing more goes to the game: every act still waiting to be picked up is withdrawn
 * (kept as expired, code STOPPED) and every waiting plan step is dropped. Acts the game already took are its own.
 */
export function withholdForStop(db: DatabaseSync, nowMs: number): ThreadNote[] {
  return inTransaction(db, () => {
    const notes: ThreadNote[] = [];
    const waiting = db.prepare("SELECT * FROM acts WHERE state = 'requested'").all() as Row[];
    for (const row of waiting) {
      const actId = String(row.act_id);
      keepEvent(db, actId, "expired", nowMs, nowMs, { code: "STOPPED" });
      setState(db, actId, "expired", nowMs);
      notes.push(noteFor(row, "expired", { code: "STOPPED" }, false));
    }
    const dropping = db.prepare("SELECT plan_id, step, thread, label FROM plan_steps WHERE state = 'planned' ORDER BY plan_id, step")
      .all() as Row[];
    db.prepare("UPDATE plan_steps SET state = 'dropped', reason = 'stopped', updated_at_ms = ? WHERE state = 'planned'").run(nowMs);
    const seen = new Set<string>();
    for (const step of dropping) {
      const planId = String(step.plan_id);
      if (seen.has(planId)) continue;
      seen.add(planId);
      notes.push(planNote(step, "stopped"));
    }
    return notes;
  });
}

/**
 * An undo: the game went back, so what was chosen on the views after that time did not happen. Each requested act chosen
 * on such a view is withdrawn (kept as expired, code UNDONE), and each waiting plan step of a plan chosen there is
 * dropped. The Lar is told, without a wake. Runs inside the undo's transaction; the span's views are already marked.
 */
export function withdrawUndone(db: DatabaseSync, span: { world: string; branch: string; session: string; afterSourceTimeMs: number }, nowMs: number): ThreadNote[] {
  const chosenOn = "SELECT observation_id FROM observations WHERE world = ? AND branch = ? AND session = ? AND source_time_ms > ?";
  const args = [span.world, span.branch, span.session, span.afterSourceTimeMs];
  const notes: ThreadNote[] = [];
  const waiting = db.prepare(`SELECT * FROM acts WHERE state = 'requested' AND observation_id IN (${chosenOn})`).all(...args) as Row[];
  for (const row of waiting) {
    const actId = String(row.act_id);
    keepEvent(db, actId, "expired", nowMs, nowMs, { code: "UNDONE" });
    setState(db, actId, "expired", nowMs);
    notes.push({ ...noteFor(row, "expired", { code: "UNDONE" }, false), wake: false });
  }
  const planOf = `plan_id IN (SELECT act_id FROM acts WHERE observation_id IN (${chosenOn}))`;
  const dropping = db.prepare(`SELECT plan_id, step, thread, label FROM plan_steps WHERE state = 'planned' AND ${planOf} ORDER BY plan_id, step`)
    .all(...args) as Row[];
  db.prepare(`UPDATE plan_steps SET state = 'dropped', reason = 'undone', updated_at_ms = ? WHERE state = 'planned' AND ${planOf}`)
    .run(nowMs, ...args);
  const seen = new Set<string>();
  for (const step of dropping) {
    const planId = String(step.plan_id);
    if (seen.has(planId)) continue;
    seen.add(planId);
    notes.push(planNote(step, "undone"));
  }
  return notes;
}

/** Acts requested and not yet picked up, and steps still waiting, for the now board. */
export function pendingCounts(db: DatabaseSync, nowMs: number): { requested: number; planned: number } {
  const requested = Number((db.prepare("SELECT COUNT(*) AS n FROM acts WHERE state = 'requested' AND expires_at_ms > ?").get(nowMs) as Row).n);
  const planned = Number((db.prepare("SELECT COUNT(*) AS n FROM plan_steps WHERE state = 'planned'").get() as Row).n);
  return { requested, planned };
}
