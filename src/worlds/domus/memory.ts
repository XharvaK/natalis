// The game_memory tool: she asks the game what it remembers about an act, a person or an object, in her own words. One
// question is open per thread. It is handed to the helper on the helper's next sync; the helper searches the game's own
// record and answers with what it recorded (never whether it was good or bad), and the answer wakes her. A question not
// answered within two minutes expires; the summoner's stop withdraws it. The questions live in domus.sqlite, table
// memory_asks. The tool only asks: nothing in the game changes.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import type { ThreadNote } from "./acts.js";
import { localStamp, memoryActLine, personLine } from "./day-record.js";
import { type Row } from "./store.js";

/** A question the helper does not answer within this time expires. */
export const MEMORY_TTL_MS = 2 * 60_000;
/** The longest a question's words may be, after trimming. */
export const ABOUT_MAX = 80;

/** What the helper recorded for one question: how many acts matched, the act lines and the people. */
export type MemoryFacts = { matched: number; acts: Record<string, unknown>[]; people: Record<string, unknown>[] };

/** What the game_memory tool reads on each call: null while the world is not running. */
export type MemoryContext = {
  db: DatabaseSync;
  nowMs: () => number;
  /** The helper session that is attached now, or undefined when the game is not attached. */
  attachedSession: (nowMs: number) => string | undefined;
  /** The last time the game was attached. */
  lastAttachedMs: () => number | undefined;
} | null;

function refused(code: string, reason: string): Receipt {
  return { ok: false, summary: reason, refused: { code, reason } };
}

/** The question open on a thread: owed or handed, and not yet past its two minutes. */
export function openMemoryAsk(db: DatabaseSync, thread: string, nowMs: number): Row | undefined {
  return db.prepare(`SELECT ask_id FROM memory_asks WHERE thread = ? AND status IN ('owed', 'handed') AND requested_at_ms > ?
    ORDER BY requested_at_ms DESC LIMIT 1`).get(thread, nowMs - MEMORY_TTL_MS) as Row | undefined;
}

export function gameMemoryTool(open: () => MemoryContext): Tool {
  return {
    spec: {
      name: "game_memory",
      // Q-j (the User, 2026-10-12): the summoner's stop refuses acts, not reads; this one only reads the game.
      safeWhenStopped: true,
      description:
        "Ask the game what it remembers about one act, one person or one object, in your own words. The game's record is " +
        "searched on its next sync, and the answer comes to you within two minutes as the facts it recorded (when, how long, " +
        "what it did to needs and moods, who was there). It says what was recorded, never whether anything was good or bad.",
      parameters: {
        type: "object",
        properties: {
          about: { type: "string", description: `An act, a person or an object, in your words: 1 to ${ABOUT_MAX} characters.` },
        },
        required: ["about"],
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameMemory(open, args, context);
    },
  };
}

function gameMemory(open: () => MemoryContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  for (const key of Object.keys(args)) {
    if (key !== "about") return refused("bad_args", `${key} is not a field of game_memory.`);
  }
  const about = typeof args.about === "string" ? args.about.trim() : "";
  if (about === "" || about.length > ABOUT_MAX) {
    return refused("bad_args", `about must be 1 to ${ABOUT_MAX} characters: an act, a person or an object, in your words.`);
  }
  const nowMs = game.nowMs();
  if (game.attachedSession(nowMs) === undefined) {
    const last = game.lastAttachedMs();
    const when = last === undefined ? "It has not been attached since this world started." : `It was last attached at ${new Date(last).toISOString()}.`;
    return refused("not_attached", `The game is not attached, so nothing was asked. ${when}`);
  }
  if (openMemoryAsk(game.db, context.thread, nowMs) !== undefined) {
    return refused("already_asked", "You already asked the game about something on this thread, and it has not answered yet. Wait for its answer.");
  }
  const askId = randomUUID();
  game.db.prepare("INSERT INTO memory_asks (ask_id, thread, about, status, requested_at_ms) VALUES (?, ?, ?, 'owed', ?)")
    .run(askId, context.thread, about, nowMs);
  return {
    ok: true,
    summary: `Asked the game what it remembers about ${about}. The answer comes on its next sync and wakes you.`,
    data: { askId, expiresAtMs: nowMs + MEMORY_TTL_MS },
  };
}

/**
 * The questions owed to a helper session on its sync: each becomes handed to that session, and is returned once. Only
 * questions within their two minutes are handed over (the timed pass expires the others first).
 */
export function handMemory(db: DatabaseSync, input: { helperSession: string; nowMs: number }): Array<{ ask_id: string; about: string }> {
  const since = input.nowMs - MEMORY_TTL_MS;
  const owed = db.prepare("SELECT ask_id, about FROM memory_asks WHERE status = 'owed' AND requested_at_ms > ? ORDER BY requested_at_ms, rowid")
    .all(since) as Row[];
  if (owed.length === 0) return [];
  db.prepare("UPDATE memory_asks SET status = 'handed', handed_session = ? WHERE status = 'owed' AND requested_at_ms > ?")
    .run(input.helperSession, since);
  return owed.map((row) => ({ ask_id: String(row.ask_id), about: String(row.about) }));
}

/**
 * The helper's answer to a question: applied once, when the question was handed to this session and is still within its
 * two minutes. Anything else (unknown, settled, another session's, or late) is not applied. The answer becomes one note
 * for the asking thread, with a wake.
 */
export function settleMemory(
  db: DatabaseSync,
  input: { askId: string; helperSession: string; facts: MemoryFacts; nowMs: number; stamp?: (ms: number) => string },
): { applied: false } | { applied: true; note: ThreadNote } {
  const row = db.prepare("SELECT thread, about, status, handed_session, requested_at_ms FROM memory_asks WHERE ask_id = ?")
    .get(input.askId) as Row | undefined;
  if (!row || row.status !== "handed" || row.handed_session !== input.helperSession) return { applied: false };
  if (Number(row.requested_at_ms) <= input.nowMs - MEMORY_TTL_MS) return { applied: false };
  db.prepare("UPDATE memory_asks SET status = 'answered', settled_at_ms = ? WHERE ask_id = ? AND status = 'handed'")
    .run(input.nowMs, input.askId);
  const about = String(row.about);
  return {
    applied: true,
    note: {
      thread: String(row.thread),
      text: memoryEventText(about, input.facts, input.stamp ?? ((ms) => localStamp(ms))),
      data: { askId: input.askId, status: "answered", matched: input.facts.matched },
      wake: true,
    },
  };
}

/**
 * The words of an answer, in plain form: the acts that matched (newest first, as the helper sent them) and the people, each
 * on its own line. Nothing is judged. "The game remembers nothing" when nothing matched.
 */
export function memoryEventText(about: string, facts: MemoryFacts, stamp: (ms: number) => string): string {
  const acts = facts.acts.map((act) => memoryActLine(act)).filter((line): line is string => line !== undefined).map((line) => `- ${line}`);
  const people = facts.people.map((person) => personLine(person, stamp)).filter((line): line is string => line !== undefined).map((line) => `- ${line}`);
  if (acts.length === 0 && people.length === 0) return `The game remembers nothing about "${about}".`;
  return [`What the game remembers about "${about}" (${facts.matched} matched, newest first):`, ...acts, ...people].join("\n");
}

/** Questions past their two minutes expire here, whoever asks. The asking thread is told, without a wake. */
export function expireMemory(db: DatabaseSync, nowMs: number): ThreadNote[] {
  const stale = db.prepare("SELECT ask_id, thread, about FROM memory_asks WHERE status IN ('owed', 'handed') AND requested_at_ms <= ? ORDER BY requested_at_ms, rowid")
    .all(nowMs - MEMORY_TTL_MS) as Row[];
  if (stale.length === 0) return [];
  db.prepare("UPDATE memory_asks SET status = 'expired', settled_at_ms = ? WHERE status IN ('owed', 'handed') AND requested_at_ms <= ?")
    .run(nowMs, nowMs - MEMORY_TTL_MS);
  return stale.map((row) => ({
    thread: String(row.thread),
    text: `The game did not answer about "${String(row.about)}".`,
    data: { askId: String(row.ask_id), status: "expired" },
    wake: false,
  }));
}

