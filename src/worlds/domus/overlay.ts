// The game_overlay_say tool: the Lar puts one line on the game overlay, the panel viewers see on the summoner's screen
// while the game is shown. Nothing reaches the overlay unless she sends it, and her line passes the body's privacy
// check first. The helper reads the lines from the feed (/domus/feed) and shows them; the lines since the last clear,
// at most OVERLAY_FEED_MAX, oldest first. The lines live in domus.sqlite, table overlay_lines (a clear is a row with no
// line). Nothing here decides what she should say.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OutwardHold, Receipt, Tool, ToolContext } from "../../contracts.js";
import { outwardHoldWords } from "../../entity/privacy.js";
import { FORGOTTEN_LINE } from "../../notebook/forget.js";
import { type Row } from "./store.js";

/** The newest lines kept in the store (a clear is one of them). */
export const OVERLAY_KEEP = 20;
/** The most lines the feed answers with: the newest since the last clear. */
export const OVERLAY_FEED_MAX = 6;
/** A line is at least one character and at most this many, after trimming. */
export const OVERLAY_LINE_MAX = 200;

/** What the game_overlay_say tool reads on each call: null while the world is not running. */
export type OverlayContext = {
  db: DatabaseSync;
  nowMs: () => number;
  /** Whether the summoner's emergency stop is on right now. */
  stopped: () => boolean;
  /** The body's privacy check of the words that leave (see WorldBody.outwardHold). */
  outwardHold: (texts: readonly string[]) => OutwardHold | undefined;
} | null;

/** One line as the feed answers it: the helper reads inputs, at_ms, pass (the line's id), line and regime. */
export type OverlayItem = { inputs: "chosen"; at_ms: number; pass: string; line: string; regime: Record<string, never> };

function refused(code: string, reason: string, summary = reason): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

/**
 * The lines the feed answers: the newest since the last clear, at most OVERLAY_FEED_MAX, oldest first. Nothing while the
 * summoner's stop is on. A line forgotten by the summoner is never answered.
 */
export function overlayItems(db: DatabaseSync, stopped: boolean): OverlayItem[] {
  if (stopped) return [];
  const clear = db.prepare("SELECT MAX(rowid) AS rid FROM overlay_lines WHERE line IS NULL").get() as Row | undefined;
  const since = clear?.rid === null || clear?.rid === undefined ? 0 : Number(clear.rid);
  const rows = db.prepare(`SELECT line_id, at_ms, line FROM overlay_lines
    WHERE rowid > ? AND line IS NOT NULL AND line != ? ORDER BY rowid DESC LIMIT ?`)
    .all(since, FORGOTTEN_LINE, OVERLAY_FEED_MAX) as Row[];
  return rows.reverse().map((row) => ({
    inputs: "chosen" as const,
    at_ms: Number(row.at_ms),
    pass: String(row.line_id),
    line: String(row.line),
    regime: {},
  }));
}

/** Keeps the newest OVERLAY_KEEP rows; older ones are dropped. */
function keepNewest(db: DatabaseSync): void {
  db.prepare("DELETE FROM overlay_lines WHERE rowid NOT IN (SELECT rowid FROM overlay_lines ORDER BY rowid DESC LIMIT ?)").run(OVERLAY_KEEP);
}

export function gameOverlaySayTool(open: () => OverlayContext): Tool {
  return {
    spec: {
      name: "game_overlay_say",
      description:
        "Put one line on the game: it shows in the game as a notification from you only while the game is open and its talk is on, and on the overlay panel viewers see " +
        "on the summoner's screen while the game is shown. Viewers read it. Use it for a short thought or feeling you want " +
        `seen, one line. Your newest ${OVERLAY_FEED_MAX} lines show. Nothing of yours is on the overlay unless you put ` +
        "it there. clear removes your lines.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `One line, 1 to ${OVERLAY_LINE_MAX} characters.` },
          clear: { type: "boolean", description: "true to remove your lines from the overlay." },
        },
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameOverlaySay(open, args, context);
    },
  };
}

function gameOverlaySay(open: () => OverlayContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const overlay = open();
  if (!overlay) return refused("not_running", "The game is not connected to you right now, so nothing was put on the overlay.");
  for (const key of Object.keys(args)) {
    if (key !== "text" && key !== "clear") return refused("bad_args", `${key} is not a field of game_overlay_say.`);
  }
  const hasText = args.text !== undefined;
  const hasClear = args.clear !== undefined;
  if (hasText === hasClear) return refused("bad_args", "Give text (one line) or clear: true, not both and not neither.");
  if (hasClear && args.clear !== true) return refused("bad_args", "clear must be true.");
  if (overlay.stopped()) {
    return refused("stopped", "The summoner's emergency stop is on, so nothing reaches the game.", "The emergency stop is on, so nothing was put on the overlay.");
  }
  const nowMs = overlay.nowMs();
  if (hasClear) {
    insertLine(overlay.db, null, context.thread, nowMs);
    return { ok: true, summary: "Cleared your lines on the game overlay.", data: { cleared: true } };
  }
  const text = typeof args.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
  if (text === "" || text.length > OVERLAY_LINE_MAX) {
    return refused("bad_args", `text must be one line of 1 to ${OVERLAY_LINE_MAX} characters.`);
  }
  const hold = overlay.outwardHold([text]);
  if (hold !== undefined) {
    const words = outwardHoldWords(hold, "the line");
    return refused(words.code, words.reason, words.summary);
  }
  const lineId = insertLine(overlay.db, text, context.thread, nowMs);
  return {
    ok: true,
    summary: "Put your line on the game overlay. Viewers read it; clear removes it.",
    data: { lineId },
  };
}

function insertLine(db: DatabaseSync, line: string | null, thread: string, atMs: number): string {
  const lineId = randomUUID();
  db.prepare("INSERT INTO overlay_lines (line_id, at_ms, thread, line) VALUES (?, ?, ?, ?)").run(lineId, atMs, thread, line);
  keepNewest(db);
  return lineId;
}
