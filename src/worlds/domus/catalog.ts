// The catalogue: she asks the game's catalogue what it sells for some words (game_catalog). One question is open per thread,
// as with game_memory. It is handed to the helper on its next sync; the helper searches what is purchasable (furniture and
// decor only) and answers with at most twelve items, each with its definition id, price and placement. The answer wakes her
// with each item's c ref, which game_buy takes. The asks live in domus.sqlite (catalog_asks), the items in catalog_seen.
// The tool only asks: nothing in the game changes.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import type { ThreadNote } from "./acts.js";
import { markListed } from "./lists.js";
import { type Row } from "./store.js";
import { type GameContext, gameGate, refused } from "./tool-context.js";
import { CATALOG_ITEMS_MAX } from "./wire.js";

/** A question the helper does not answer within this time expires. */
export const CATALOG_TTL_MS = 2 * 60_000;
/** The longest the words of a catalogue question may be, after trimming. */
export const WORDS_CATALOG_MAX = 80;
const PLACEMENTS: readonly string[] = ["floor", "wall", "surface"];

/** A catalogue item as the helper sent it, checked by the wire. */
export type CatalogItem = Record<string, unknown>;

/** The open question on a thread: owed or handed, and not yet past its two minutes. */
export function openCatalogAsk(db: DatabaseSync, thread: string, nowMs: number): Row | undefined {
  return db.prepare(`SELECT ask_id FROM catalog_asks WHERE thread = ? AND status IN ('owed', 'handed') AND requested_at_ms > ?
    ORDER BY requested_at_ms DESC LIMIT 1`).get(thread, nowMs - CATALOG_TTL_MS) as Row | undefined;
}

/** A catalogue item this helper session answered with, by its c ref, or undefined. */
export function seenItem(db: DatabaseSync, attachment: string, ref: string): { definitionId: string; name: string; price: number | undefined } | undefined {
  const row = db.prepare("SELECT definition_id, name, price FROM catalog_seen WHERE attachment = ? AND ref = ?").get(attachment, ref) as Row | undefined;
  if (!row) return undefined;
  return { definitionId: String(row.definition_id), name: String(row.name), price: row.price === null ? undefined : Number(row.price) };
}

export function gameCatalogTool(open: () => GameContext): Tool {
  return {
    spec: {
      name: "game_catalog",
      description:
        "Ask the game's catalogue what it sells for some words: furniture and decor you can buy. The answer comes on its next " +
        "sync, within two minutes, as up to twelve items, each with a c ref for game_buy, its price and its placement. Nothing is bought.",
      parameters: {
        type: "object",
        properties: {
          words: { type: "string", description: `What you look for, in your words: 1 to ${WORDS_CATALOG_MAX} characters.` },
          max_price: { type: "integer", minimum: 0, description: "Optional: the most it may cost." },
          placement: { type: "string", enum: [...PLACEMENTS], description: "Optional: floor, wall or surface." },
        },
        required: ["words"],
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameCatalog(open, args, context);
    },
  };
}

function gameCatalog(open: () => GameContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  for (const key of Object.keys(args)) {
    if (!["words", "max_price", "placement"].includes(key)) return refused("bad_args", `${key} is not a field of game_catalog.`);
  }
  const words = typeof args.words === "string" ? args.words.trim() : "";
  if (words === "" || words.length > WORDS_CATALOG_MAX) {
    return refused("bad_args", `words must be 1 to ${WORDS_CATALOG_MAX} characters: what you look for, in your words.`);
  }
  if (args.max_price !== undefined && !(typeof args.max_price === "number" && Number.isSafeInteger(args.max_price) && args.max_price >= 0)) {
    return refused("bad_args", "max_price must be a whole number of simoleons, 0 or more.");
  }
  if (args.placement !== undefined && !(typeof args.placement === "string" && PLACEMENTS.includes(args.placement))) {
    return refused("bad_args", "placement must be floor, wall or surface.");
  }
  const gate = gameGate(game, { probe: false });
  if (gate) return gate;
  const nowMs = game.nowMs();
  if (openCatalogAsk(game.db, context.thread, nowMs) !== undefined) {
    return refused("already_asked", "You already asked the game's catalogue about something on this thread, and it has not answered yet. Wait for its answer.");
  }
  const askId = randomUUID();
  // The room column is kept for asks written before the room was dropped; no new ask names one.
  game.db.prepare(`INSERT INTO catalog_asks (ask_id, thread, about, status, requested_at_ms, room, max_price, placement)
    VALUES (?, ?, ?, 'owed', ?, NULL, ?, ?)`)
    .run(askId, context.thread, words, nowMs,
      typeof args.max_price === "number" ? args.max_price : null, typeof args.placement === "string" ? args.placement : null);
  return {
    ok: true,
    summary: `Asked the game's catalogue for ${words}. The answer comes on its next sync and wakes you.`,
    data: { askId, expiresAtMs: nowMs + CATALOG_TTL_MS },
  };
}

/** The questions owed to a helper session on its sync: each becomes handed to that session, and is returned once. */
export function handCatalog(db: DatabaseSync, input: { helperSession: string; nowMs: number }): Array<Record<string, unknown>> {
  const since = input.nowMs - CATALOG_TTL_MS;
  const owed = db.prepare(`SELECT ask_id, about, max_price, placement FROM catalog_asks WHERE status = 'owed' AND requested_at_ms > ?
    ORDER BY requested_at_ms, rowid`).all(since) as Row[];
  if (owed.length === 0) return [];
  db.prepare("UPDATE catalog_asks SET status = 'handed', handed_session = ? WHERE status = 'owed' AND requested_at_ms > ?")
    .run(input.helperSession, since);
  return owed.map((row) => ({
    ask_id: String(row.ask_id),
    words: String(row.about),
    ...(row.max_price === null ? {} : { max_price: Number(row.max_price) }),
    ...(row.placement === null ? {} : { placement: String(row.placement) }),
  }));
}

/**
 * The helper's answer to an ask: applied once, when the ask was handed to this session and is still within its two minutes.
 * The items are kept by their refs for this session (game_buy takes them), and the answer becomes one note with a wake.
 */
export function settleCatalog(
  db: DatabaseSync,
  input: { askId: string; helperSession: string; matched: number; items: CatalogItem[]; funds?: number; nowMs: number },
): { applied: false } | { applied: true; note: ThreadNote } {
  const row = db.prepare("SELECT thread, about, status, handed_session, requested_at_ms FROM catalog_asks WHERE ask_id = ?")
    .get(input.askId) as Row | undefined;
  if (!row || row.status !== "handed" || row.handed_session !== input.helperSession) return { applied: false };
  if (Number(row.requested_at_ms) <= input.nowMs - CATALOG_TTL_MS) return { applied: false };
  db.prepare("UPDATE catalog_asks SET status = 'answered', settled_at_ms = ? WHERE ask_id = ? AND status = 'handed'").run(input.nowMs, input.askId);
  const items = input.items.slice(0, CATALOG_ITEMS_MAX);
  for (const item of items) {
    db.prepare(`INSERT INTO catalog_seen (attachment, ref, definition_id, name, price, at_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (attachment, ref) DO UPDATE SET definition_id = excluded.definition_id, name = excluded.name, price = excluded.price,
      at_ms = excluded.at_ms`).run(input.helperSession, String(item.ref), String(item.id), String(item.name),
      typeof item.price === "number" ? item.price : null, input.nowMs);
  }
  markListed(db, input.helperSession);
  return {
    applied: true,
    note: {
      thread: String(row.thread),
      text: catalogText(String(row.about), input.matched, items, input.funds),
      data: { askId: input.askId, status: "answered", matched: input.matched },
      wake: true,
    },
  };
}

/** The answer in plain words: each item with its c ref, name, price and placement, and her money when it is known. */
export function catalogText(words: string, matched: number, items: CatalogItem[], funds: number | undefined): string {
  const lines = items.map((item) => {
    const placement = typeof item.placement === "string" ? `, ${item.placement}` : "";
    return `- ${String(item.ref)} ${String(item.name)}, §${String(item.price)}${placement}`;
  });
  const head = matched === 0 ? `The game's catalogue has nothing for "${words}".`
    : `What the game's catalogue has for "${words}" (${matched} matched${matched > items.length ? `, ${items.length} shown` : ""}):`;
  const money = funds === undefined ? [] : [`Your money: §${funds}.`];
  return [head, ...lines, ...money].join("\n");
}

/** Questions past their two minutes expire here, whoever asks. The asking thread is told, without a wake. */
export function expireCatalog(db: DatabaseSync, nowMs: number): ThreadNote[] {
  const stale = db.prepare(`SELECT ask_id, thread, about FROM catalog_asks WHERE status IN ('owed', 'handed') AND requested_at_ms <= ?
    ORDER BY requested_at_ms, rowid`).all(nowMs - CATALOG_TTL_MS) as Row[];
  if (stale.length === 0) return [];
  db.prepare("UPDATE catalog_asks SET status = 'expired', settled_at_ms = ? WHERE status IN ('owed', 'handed') AND requested_at_ms <= ?")
    .run(nowMs, nowMs - CATALOG_TTL_MS);
  return stale.map((row) => ({
    thread: String(row.thread),
    text: `The game's catalogue did not answer about "${String(row.about)}".`,
    data: { askId: String(row.ask_id), status: "expired" },
    wake: false,
  }));
}

/** While the summoner's stop is on, open catalogue questions are withdrawn: none is handed over. The asking thread is told, without a wake. */
export function withdrawCatalog(db: DatabaseSync, nowMs: number): ThreadNote[] {
  const open = db.prepare("SELECT ask_id, thread, about FROM catalog_asks WHERE status IN ('owed', 'handed') ORDER BY requested_at_ms, rowid")
    .all() as Row[];
  if (open.length === 0) return [];
  db.prepare("UPDATE catalog_asks SET status = 'withdrawn', settled_at_ms = ? WHERE status IN ('owed', 'handed')").run(nowMs);
  return open.map((row) => ({
    thread: String(row.thread),
    text: `Your question to the game's catalogue about "${String(row.about)}" was withdrawn: your summoner's emergency stop is on.`,
    data: { askId: String(row.ask_id), status: "withdrawn" },
    wake: false,
  }));
}

