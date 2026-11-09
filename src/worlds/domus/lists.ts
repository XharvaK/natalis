// The game's lists on demand: the people she knows, the places she can go, her things and the event types, and every act
// on one object (D3). The helper sends a list only when its content changed (POST /domus/lists), and Natalis keeps the
// newest one per helper session and kind. The game_list tool reads it and changes nothing. Refs in a list (p, h, t, e)
// resolve only against the list of the helper session her last list answer named, and only while that session is attached
// (see listedSession and findListed). Her view carries one count line from these lists (listCountLine).

import { moneyWords, dropTokens } from "./words.js";
import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { DETAIL_WORDS, wordsOfCode } from "./acts.js";
import type { OptionAct, OptionObject } from "./answers.js";
import { optionsOf } from "./options.js";
import { withoutRefused } from "./refused.js";
import { type GameContext, gameGate, refused, staleRef } from "./tool-context.js";
import { type ListKind, LIST_KINDS } from "./wire.js";
import { gameThreadNow, isAttachedView, newestObservation, type Row } from "./store.js";

/** A ref as the view and the tools name it: a letter and up to eight digits. */
export const REF_PATTERN = /^[a-z][0-9]{1,8}$/;
/** A room's name as the tools take it: 1 to 64 characters. */
const ROOM_MAX = 64;
/** Above this many things, and with no room named, the things answer is counts per room and her inventory. */
const THINGS_IN_FULL = 80;
/** The kinds game_list answers: the stored lists, and every act on one object (D3). */
export const GAME_LIST_WHATS = [...LIST_KINDS, "acts"] as const;
export type GameListWhat = (typeof GAME_LIST_WHATS)[number];
/** The longest object name the acts answer takes, in characters. */
const OBJECT_NAME_MAX = 200;

export type ListItem = Record<string, unknown>;

/** One list's newest row for a helper session: its digest, its items, the time it arrived, and the game's total when it sent one. */
export type StoredList = { digest: string; items: ListItem[]; atMs: number; total?: number };

/** Lists and catalogue items of other helper sessions are kept this long after their last write, then let go. */
export const LISTS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keeps the newest list of one kind for a helper session (one row per session and kind). The lists and catalogue items of
 * other sessions not written for LISTS_KEEP_MS are let go: their refs can no longer be used, and a things list is large.
 */
export function storeList(db: DatabaseSync, input: {
  attachment: string; kind: ListKind; digest: string; items: ListItem[]; nowMs: number; total?: number;
}): void {
  db.prepare(`INSERT INTO lists (attachment, kind, digest, items_json, at_ms, total) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (attachment, kind) DO UPDATE SET digest = excluded.digest, items_json = excluded.items_json, at_ms = excluded.at_ms,
      total = excluded.total`)
    .run(input.attachment, input.kind, input.digest, JSON.stringify(input.items), input.nowMs, input.total ?? null);
  const before = input.nowMs - LISTS_KEEP_MS;
  db.prepare("DELETE FROM lists WHERE attachment != ? AND at_ms < ?").run(input.attachment, before);
  db.prepare("DELETE FROM catalog_seen WHERE attachment != ? AND at_ms < ?").run(input.attachment, before);
  db.prepare("DELETE FROM catalog_asks WHERE status NOT IN ('owed', 'handed') AND requested_at_ms < ?").run(before);
}

/** The lists a helper session holds, by kind and digest: what the sync answer says, so the helper resends only what changed. */
export function listDigests(db: DatabaseSync, attachment: string): Record<string, string> {
  const rows = db.prepare("SELECT kind, digest FROM lists WHERE attachment = ?").all(attachment) as Row[];
  return Object.fromEntries(rows.map((row) => [String(row.kind), String(row.digest)]));
}

/** The stored list of one kind for a helper session, or undefined when it has none. */
export function readList(db: DatabaseSync, attachment: string | undefined, kind: string): StoredList | undefined {
  if (attachment === undefined) return undefined;
  const row = db.prepare("SELECT digest, items_json, at_ms, total FROM lists WHERE attachment = ? AND kind = ?").get(attachment, kind) as Row | undefined;
  if (!row) return undefined;
  let items: unknown;
  try { items = JSON.parse(String(row.items_json)); } catch { items = []; }
  return {
    digest: String(row.digest),
    items: Array.isArray(items) ? items.filter((item): item is ListItem => typeof item === "object" && item !== null) : [],
    atMs: Number(row.at_ms),
    ...(row.total === null ? {} : { total: Number(row.total) }),
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
 * shows them." A list Natalis lacks is left out. When the game counted more than it sent, the count says so: "41 things (30
 * listed)". Undefined when it holds none.
 */
export function listCountLine(db: DatabaseSync, attachment: string): string | undefined {
  const count = (kind: string, label: string): string | undefined => {
    const list = readList(db, attachment, kind);
    if (list === undefined) return undefined;
    const listed = list.items.length;
    const total = list.total ?? listed;
    return total === listed ? `${total} ${label}` : `${total} ${label} (${listed} listed)`;
  };
  const people = count("people", "people");
  const rest = [
    count("places", "places"),
    count("things", "things"),
    count("events", "kinds of event"),
  ].filter((part): part is string => part !== undefined);
  const head = people === undefined ? undefined : `You know ${people}`;
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
  const cost = typeof item.cost === "number" ? ` (cost §${moneyWords(item.cost)})` : "";
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
  const perRoom = [...counts].map(([name, count]) => `${name}: ${count} ${count === 1 ? "thing" : "things"}`).join("; ");
  const inventory = items.filter((item) => item.where === "inventory");
  return [
    `Things by room (ask again with room for one room's list): ${perRoom || "none"}.`,
    ...(inventory.length ? ["In your inventory:", ...inventory.map(LINE.things)] : []),
  ];
}

/** The words of a list answer: one line per item, the lines the kind says, and the kind's fixed sentences. */
export function listAnswer(kind: ListKind, items: ListItem[], room: string | undefined): string {
  const lines = kind === "things" ? thingsLines(items, room) : items.map(LINE[kind]);
  const body = lines.length ? lines : [`The game's list of ${kind} is empty.`];
  return body.join("\n");
}

/** The acts of an object the view can show, read defensively: an act missing its ref or words is left out. */
function actsOf(object: OptionObject): OptionAct[] {
  return object.acts.filter((act): act is OptionAct =>
    !!act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string");
}

/** The act refs the view hides on each object, from the same recent-refusal rule the view uses (refused.ts). */
function hiddenRefsOf(raw: readonly OptionObject[], shown: readonly OptionObject[]): ReadonlySet<string>[] {
  const shownRefs = new Map<string, Set<string>>();
  for (const object of shown) {
    const refs = shownRefs.get(object.object_id) ?? new Set<string>();
    for (const act of actsOf(object)) refs.add(act.ref);
    shownRefs.set(object.object_id, refs);
  }
  return raw.map((object) => {
    const kept = shownRefs.get(object.object_id) ?? new Set<string>();
    return new Set(actsOf(object).filter((act) => !kept.has(act.ref)).map((act) => act.ref));
  });
}

/** One act's line: its ref and words, with the marks the view uses, and why it is not offered when the view hides it. */
function actLine(act: OptionAct, hidden: boolean): string {
  const marks = `${act.needs_sim === true ? " (needs a Sim: name one with sim)" : ""}${typeof act.opens === "string" ? ` [${act.opens}]` : ""}`;
  return hidden
    ? `- ${act.ref} ${dropTokens(act.text)}${marks}: left out now, because the game refused it lately`
    : `- ${act.ref} ${dropTokens(act.text)}${marks}`;
}

/** The place of an object in the acts answer: its room when the view names one, and where it is. */
function actPlace(object: OptionObject): string {
  const room = typeof object.room === "string" && object.room !== "" ? dropTokens(object.room) : undefined;
  const where = typeof object.where === "string" && object.where !== "" ? dropTokens(object.where) : undefined;
  const parts = room !== undefined && where !== undefined && where.includes(room) ? [where] : [room, where];
  const kept = parts.filter((part): part is string => part !== undefined);
  return kept.length ? ` (${kept.join("; ")})` : "";
}

/** The plain words of an excluded act's reason code; a code it does not know is never shown as a bare code. */
function excludedReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim() === "") return "the game's side did not give a reason";
  const code = reason.trim();
  if (Object.hasOwn(DETAIL_WORDS, code)) return DETAIL_WORDS[code] ?? "the game's side did not give a reason";
  return wordsOfCode(code) ?? "the game's side did not give a reason in words";
}

/**
 * The acts answer (D3): every act of each matching object with its ref, then the acts the game's side excluded, the
 * view hides after refusals, or the game left out, each with its reason. No act is both offered and left out.
 */
export function actsOnAnswer(objects: readonly OptionObject[], hidden: readonly ReadonlySet<string>[]): string {
  const blocks: string[] = [];
  for (const [index, object] of objects.entries()) {
    const hiddenHere = hidden[index] ?? new Set<string>();
    const lines = [`Acts on ${dropTokens(object.object)}${actPlace(object)}:`];
    for (const act of actsOf(object)) lines.push(actLine(act, hiddenHere.has(act.ref)));
    if (lines.length === 1) lines.push("- The newest view shows no act on it.");
    for (const line of object.refused ?? []) if (typeof line === "string" && line !== "") lines.push(`- ${dropTokens(line)}`);
    for (const line of object.left_out ?? []) if (typeof line === "string" && line !== "") lines.push(`- ${dropTokens(line)}`);
    for (const entry of object.excluded ?? []) {
      const text = typeof entry?.text === "string" ? dropTokens(entry.text) : "";
      if (text === "") continue;
      const ref = typeof entry.ref === "string" && entry.ref !== "" ? `${entry.ref} ` : "";
      lines.push(`- ${ref}${text}: left out: ${excludedReason(entry.reason)}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** How many objects the game's own cut left out of the newest view, when its payload says. */
function optionsCutObjects(cut: unknown): number {
  if (cut === null || typeof cut !== "object") return 0;
  const objects = (cut as Record<string, unknown>).objects;
  return typeof objects === "number" && Number.isSafeInteger(objects) && objects > 0 ? objects : 0;
}

/**
 * Every act on one object of the newest view, whatever the view's own cap: by a t ref from game_list things, or by the
 * object's name (every object with that name, so none is silently chosen over another). A refusal names game_look.
 */
function actsOn(game: NonNullable<GameContext>, session: string, asked: string): Receipt {
  const nameOrRef = asked.trim();
  let wantedId: string | undefined;
  let wantedName = nameOrRef;
  if (REF_PATTERN.test(nameOrRef)) {
    if (!nameOrRef.startsWith("t")) {
      return refused("bad_args", `${nameOrRef} is not a thing ref: use a t ref from game_list things, or the object's name.`);
    }
    const item = findListed(game.db, listedSession(game.db, session), "things", nameOrRef);
    if (!item) return staleRef(nameOrRef, "game_list things");
    wantedId = String(item.id);
    wantedName = String(item.name);
  }
  const thread = gameThreadNow(game.db, session);
  const newest = thread === undefined ? undefined : newestObservation(game.db, thread);
  if (!newest || !isAttachedView(newest.attachment, session)) {
    return refused("no_view", "The newest view of the game is not here, so its acts are not known. game_look asks for a fresh view.");
  }
  const raw = optionsOf(newest.payload.options);
  const objects = wantedId === undefined
    ? raw.filter((object) => dropTokens(object.object).toLowerCase() === wantedName.toLowerCase())
    : raw.filter((object) => object.object_id === wantedId);
  if (objects.length === 0) {
    const cut = optionsCutObjects(newest.payload.options_cut);
    const left = cut > 0 ? ` The game left ${cut} ${cut === 1 ? "thing" : "things"} out of that view.` : "";
    const what = wantedId === undefined ? `an object named ${wantedName}` : `${wantedName} (${nameOrRef})`;
    return refused(
      "unknown_object",
      `The newest view does not show ${what}, so it lists no acts on it.${left} game_look asks for a fresh view; game_list things shows your things by name.`,
    );
  }
  const shown = withoutRefused(game.db, newest.attachment, raw, game.nowMs());
  const count = objects.reduce((total, object) => total + actsOf(object).length, 0);
  return {
    ok: true,
    summary: actsOnAnswer(objects, hiddenRefsOf(objects, shown)),
    data: { kind: "acts", object: dropTokens(objects[0]!.object), count, objects: objects.length },
  };
}

export function gameListTool(open: () => GameContext): Tool {
  return {
    spec: {
      name: "game_list",
      // Q-j (the User, 2026-10-12): the summoner's stop refuses acts, not reads; this one only reads the game.
      safeWhenStopped: true,
      description:
        "List what the game knows, with the refs to use in other tools: the people you know (p), the places you can go (h), " +
        "your things (t), the kinds of event you can plan (e), or every act on one object (acts), with the refs game_act takes. " +
        "It changes nothing in the game.",
      parameters: {
        type: "object",
        properties: {
          what: { type: "string", enum: [...GAME_LIST_WHATS] },
          room: { type: "string", description: "Things only: one room's name, as the view names it." },
          object: { type: "string", description: "Acts only: the object's t ref from game_list things, or its name as the view shows it." },
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
    if (key !== "what" && key !== "room" && key !== "object") return refused("bad_args", `${key} is not a field of game_list.`);
  }
  const what = args.what;
  if (typeof what !== "string" || !(GAME_LIST_WHATS as readonly string[]).includes(what)) {
    return refused("bad_args", `what must be one of ${GAME_LIST_WHATS.join(", ")}.`);
  }
  const kind = what as GameListWhat;
  if (kind === "acts") {
    if (args.room !== undefined) return refused("bad_args", "room goes with things only.");
    if (typeof args.object !== "string" || args.object.trim() === "" || args.object.length > OBJECT_NAME_MAX) {
      return refused("bad_args", `object is the thing whose acts you want: its t ref from game_list things, or its name (up to ${OBJECT_NAME_MAX} characters).`);
    }
  } else {
    if (args.object !== undefined) return refused("bad_args", "object goes with acts only.");
    if (args.room !== undefined && !(kind === "things" && typeof args.room === "string" && args.room.trim() !== "" && args.room.length <= ROOM_MAX)) {
      return refused("bad_args", `room is one room's name (up to ${ROOM_MAX} characters), and goes with things only.`);
    }
  }
  const gate = gameGate(game, { probe: true, reads: true });
  if (gate) return gate;
  const session = game.attachedSession(game.nowMs()) as string;
  if (kind === "acts") return actsOn(game, session, args.object as string);
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
