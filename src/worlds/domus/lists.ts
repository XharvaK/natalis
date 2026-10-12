// The game's lists on demand: the people she knows, the places she can go, her things and the event types. The helper sends
// a list only when its content changed (POST /domus/lists), and Natalis keeps the newest one per helper session and kind.
// The game_list tool reads it and changes nothing. Refs in a list (p, h, t, e) resolve only against the list of the helper
// session her last list answer named, and only while that session is attached (see listedSession and findListed). Her view
// carries one count line from these lists (listCountLine).

import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { type GameContext, gameGate, refused } from "./tool-context.js";
import { type ListKind, LIST_KINDS } from "./wire.js";
import type { Row } from "./store.js";

/** A ref as the view and the tools name it: a letter and up to eight digits. */
export const REF_PATTERN = /^[a-z][0-9]{1,8}$/;
/** A room's name as the tools take it: 1 to 64 characters. */
const ROOM_MAX = 64;
/** Above this many things, and with no room named, the things answer is counts per room and her inventory. */
const THINGS_IN_FULL = 80;

export type ListItem = Record<string, unknown>;

/** One list's newest row for a helper session: its digest, its items and the time it arrived. */
export type StoredList = { digest: string; items: ListItem[]; atMs: number };

/** Lists and catalogue items of other helper sessions are kept this long after their last write, then let go. */
export const LISTS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keeps the newest list of one kind for a helper session (one row per session and kind). The lists and catalogue items of
 * other sessions not written for LISTS_KEEP_MS are let go: their refs can no longer be used, and a things list is large.
 */
export function storeList(db: DatabaseSync, input: { attachment: string; kind: ListKind; digest: string; items: ListItem[]; nowMs: number }): void {
  db.prepare(`INSERT INTO lists (attachment, kind, digest, items_json, at_ms) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (attachment, kind) DO UPDATE SET digest = excluded.digest, items_json = excluded.items_json, at_ms = excluded.at_ms`)
    .run(input.attachment, input.kind, input.digest, JSON.stringify(input.items), input.nowMs);
  const before = input.nowMs - LISTS_KEEP_MS;
  db.prepare("DELETE FROM lists WHERE attachment != ? AND at_ms < ?").run(input.attachment, before);
  db.prepare("DELETE FROM catalog_seen WHERE attachment != ? AND at_ms < ?").run(input.attachment, before);
}

/** The lists a helper session holds, by kind and digest: what the sync answer says, so the helper resends only what changed. */
export function listDigests(db: DatabaseSync, attachment: string): Record<string, string> {
  const rows = db.prepare("SELECT kind, digest FROM lists WHERE attachment = ?").all(attachment) as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.kind), String(row.digest)]));
}

/** The stored list of one kind for a helper session, or undefined when it has none. */
export function readList(db: DatabaseSync, attachment: string | undefined, kind: string): StoredList | undefined {
  if (attachment === undefined) return undefined;
  const row = db.prepare("SELECT digest, items_json, at_ms FROM lists WHERE attachment = ? AND kind = ?").get(attachment, kind) as Row | undefined;
  if (!row) return undefined;
  let items: unknown;
  try { items = JSON.parse(String(row.items_json)); } catch { items = []; }
  return {
    digest: String(row.digest),
    items: Array.isArray(items) ? items.filter((item): item is ListItem => typeof item === "object" && item !== null) : [],
    atMs: Number(row.at_ms),
  };
}

/**
 * Records the helper session whose list (or catalogue answer) she read last. Her refs name items of that session only: a
 * ref she was given before the game was attached to another session is not mapped to whatever that session numbered it.
 */
export function markListed(db: DatabaseSync, attachment: string): void {
  db.prepare(`INSERT INTO list_marks (id, attachment) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET attachment = excluded.attachment`).run(attachment);
}

/** The helper session her list and catalogue refs name, when it is the session attached now; undefined otherwise (her refs are stale). */
export function listedSession(db: DatabaseSync, attached: string): string | undefined {
  const row = db.prepare("SELECT attachment FROM list_marks WHERE id = 1").get() as Row | undefined;
  return row !== undefined && String(row.attachment) === attached ? attached : undefined;
}

/** The item a ref names in a helper session's stored list of that kind, or undefined. Only an exact ref matches. */
export function findListed(db: DatabaseSync, attachment: string | undefined, kind: ListKind, ref: string): ListItem | undefined {
  if (attachment === undefined) return undefined;
  return readList(db, attachment, kind)?.items.find((item) => item.ref === ref);
}

/**
 * The count line of her view, from the stored lists: "You know 23 people; 9 places, 41 things, 6 kinds of event: game_list
 * shows them." A list Natalis lacks is left out. Undefined when it holds none.
 */
export function listCountLine(db: DatabaseSync, attachment: string): string | undefined {
  const size = (kind: string): number | undefined => readList(db, attachment, kind)?.items.length;
  const people = size("people");
  const rest = [
    size("places") === undefined ? undefined : `${size("places")} places`,
    size("things") === undefined ? undefined : `${size("things")} things`,
    size("events") === undefined ? undefined : `${size("events")} kinds of event`,
  ].filter((part): part is string => part !== undefined);
  const head = people === undefined ? undefined : `You know ${people} people`;
  const words = [head, rest.length ? rest.join(", ") : undefined].filter((part): part is string => part !== undefined).join("; ");
  return words === "" ? undefined : `${words}: game_list shows them.`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function personLine(item: ListItem): string {
  const flags = [
    text(item.how),
    item.home === true ? "has a home" : "",
    item.here === true ? "here with you" : "",
    item.waiting === true ? "waiting at your door" : "",
  ].filter((part) => part !== "");
  return `- ${text(item.ref)} ${text(item.name)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function placeLine(item: ListItem): string {
  const what = text(item.what);
  const where = item.kind === "home" ? "your home" : item.kind === "household" ? `home of ${what}` : what || "venue";
  return `- ${text(item.ref)} ${text(item.name)} (${where})`;
}

function thingLine(item: ListItem): string {
  const where = item.where === "inventory" ? "in your inventory" : item.where === "outside" ? "outside" : `in ${text(item.where)}`;
  const states = Array.isArray(item.states) ? item.states.filter((state): state is string => typeof state === "string") : [];
  const count = typeof item.count === "number" && item.count > 1 ? `×${item.count}` : "";
  const parts = [
    where,
    typeof item.value === "number" ? `value ${item.value}` : "",
    item.made_by_her === true ? "made by you" : "",
    states.length ? `states: ${states.join(", ")}` : "",
    item.in_use === true ? "in use" : "",
    count,
    text(item.placement),
  ].filter((part) => part !== "");
  return `- ${text(item.ref)} ${text(item.name)} (${parts.join("; ")})`;
}

function eventLine(item: ListItem): string {
  const cost = typeof item.cost === "number" ? ` (cost §${item.cost})` : "";
  return `- ${text(item.ref)} ${text(item.name)}${cost}`;
}

const LINE: Readonly<Record<ListKind, (item: ListItem) => string>> = {
  people: personLine, places: placeLine, things: thingLine, events: eventLine,
};

/** The things answer: all of them when few or when a room is named; else counts per room, and her inventory in full. */
function thingsLines(items: ListItem[], room: string | undefined): string[] {
  if (room !== undefined) {
    const wanted = room.toLowerCase();
    const inRoom = items.filter((item) => text(item.where).toLowerCase() === wanted);
    return inRoom.length ? inRoom.map(LINE.things) : [`No things on the list are in ${room}.`];
  }
  if (items.length <= THINGS_IN_FULL) return items.map(LINE.things);
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.where === "inventory") continue;
    const name = text(item.where) || "outside";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const perRoom = [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
  const inventory = items.filter((item) => item.where === "inventory");
  return [
    `Things by room (ask again with room for one room's list): ${perRoom || "none"}.`,
    "In your inventory:",
    ...inventory.map(LINE.things),
  ];
}

/** The words of a list answer: one line per item, the lines the kind says, and the kind's fixed sentences. */
export function listAnswer(kind: ListKind, items: ListItem[], room: string | undefined): string {
  const lines = kind === "things" ? thingsLines(items, room) : items.map(LINE[kind]);
  const body = lines.length ? lines : [`The game's list of ${kind} is empty.`];
  if (kind === "places") return ["Travel moves your summoner's game too: ask them first.", ...body].join("\n");
  if (kind === "things") return [...body, "New clothes are made in Create-a-Sim, which is your summoner's: ask them."].join("\n");
  return body.join("\n");
}

export function gameListTool(open: () => GameContext): Tool {
  return {
    spec: {
      name: "game_list",
      description:
        "List what the game knows, with the refs to use in other tools: the people you know (p), the places you can go (h), " +
        "your things (t) or the kinds of event you can plan (e). It changes nothing in the game.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", enum: [...LIST_KINDS] },
          room: { type: "string", description: "Things only: one room's name, as the view names it." },
        },
        required: ["what"],
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameList(open, args, context);
    },
  };
}

function gameList(open: () => GameContext, args: Record<string, unknown>, _context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  for (const key of Object.keys(args)) {
    if (key !== "what" && key !== "room") return refused("bad_args", `${key} is not a field of game_list.`);
  }
  const what = args.what;
  if (typeof what !== "string" || !(LIST_KINDS as readonly string[]).includes(what)) {
    return refused("bad_args", `what must be one of ${LIST_KINDS.join(", ")}.`);
  }
  const kind = what as ListKind;
  if (args.room !== undefined && !(kind === "things" && typeof args.room === "string" && args.room.trim() !== "" && args.room.length <= ROOM_MAX)) {
    return refused("bad_args", `room is one room's name (up to ${ROOM_MAX} characters), and goes with things only.`);
  }
  const gate = gameGate(game, { probe: false });
  if (gate) return gate;
  const session = game.attachedSession(game.nowMs()) as string;
  const stored = readList(game.db, session, kind);
  if (stored === undefined) {
    return { ok: false, summary: `The game has not sent its list of ${kind} yet.`, refused: { code: "no_list", reason: `The game has not sent its list of ${kind} yet.` } };
  }
  markListed(game.db, session);
  const room = typeof args.room === "string" ? args.room.trim() : undefined;
  return {
    ok: true,
    summary: listAnswer(kind, stored.items, room),
    data: { kind, count: stored.items.length, room: room ?? null },
  };
}
