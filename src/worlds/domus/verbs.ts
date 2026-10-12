// The W13 verbs: the travel and home acts she asks the game for. game_go, game_save and plan_event hold the turn's one-act
// slot, as a game act does; game_buy, game_place, game_move and game_sell are home edits (no cap in a turn). Each tool checks its
// arguments against the lists and the newest view of the game that is attached now, then keeps the act as a requested verb.
// The game does it, or refuses, later; the result comes back as notes on her thread. Nothing here chooses for her.

import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import type { OptionObject } from "./answers.js";
import { actRequestedMeanwhile, lastSaveAt, requestVerb, saveWaiting } from "./acts.js";
import { seenItem } from "./catalog.js";
import { findListed, listedSession, readList, REF_PATTERN } from "./lists.js";
import { findOption, optionsOf } from "./options.js";
import { gameThreadNow, newestObservation } from "./store.js";
import { type GameContext, gameGate, refused, staleRef } from "./tool-context.js";

/** Saves are at least this far apart, in real time (the game's own save lock is separate). */
export const SAVE_FLOOR_MS = 15 * 60_000;
/** A plan's guests: at most this many. */
const GUESTS_MAX = 16;
const KNOWINGLY = {
  type: "boolean",
  description: "True only to ask anyway, after a refusal that says another of your threads asked the game within the last 60 seconds.",
} as const;
const PLACE_TEXT = "Where: exactly one of on, beside or instead (a t or a ref), or wall or in (a room's name as the view names it); facing, optionally, a t or a ref, or \"room\".";

/** The relations a place may name: one of them, with a thing (on, beside, instead) or a room (wall, in). */
const RELATIONS: readonly string[] = ["on", "beside", "instead", "wall", "in"];

type Args = Record<string, unknown>;
type View = { observationId: string; options: OptionObject[] };
type Thing = { id: string; name: string };
type Place = { args: Args; words: string };
type Planned = {
  verb: string;
  label: string;
  objectId: string;
  args: Args;
  /** What the Lar's side keeps with the act and the receipt, and the helper never sees (summonerLastMessageMs for travel). */
  record?: Args;
  holdsSlot: boolean;
};

function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isRecord(value: unknown): value is Args {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The newest view of the game, when it is the attached session's; undefined when none is (a ref to a choice then cannot be used). */
function viewOf(db: DatabaseSync, attached: string): View | undefined {
  const thread = gameThreadNow(db, attached);
  const newest = thread === undefined ? undefined : newestObservation(db, thread);
  if (!newest || newest.attachment !== attached) return undefined;
  return { observationId: newest.observationId, options: optionsOf(newest.payload.options) };
}

const NO_VIEW = "The newest view of the game does not show this choice, so an a ref cannot be used now. Name a thing by its t ref, or wait for the game's view.";

/** A thing by its ref: a t ref (from the things list) or an a ref (the choice's object in the newest view). */
function thingOf(db: DatabaseSync, listed: string | undefined, view: View | undefined, ref: string): Thing | Receipt {
  if (!REF_PATTERN.test(ref)) return refused("bad_args", `${ref} is not a ref: use a t ref from game_list things, or an a ref from the view.`);
  if (ref.startsWith("t")) {
    const item = findListed(db, listed, "things", ref);
    return item ? { id: String(item.id), name: String(item.name) } : staleRef(ref, "game_list things");
  }
  if (ref.startsWith("a")) {
    if (view === undefined) return refused("no_view", NO_VIEW);
    const found = findOption(view.options, ref);
    return found ? { id: found.object.object_id, name: found.object.object } : refused("unknown_option", `${ref} is not a choice in the newest view of this game.`);
  }
  return refused("bad_args", `${ref} is not a thing: use a t ref from game_list things, or an a ref from the view.`);
}

/** The rooms she can name: the rooms of the newest view and of the things list, as the words they have (exact, ignoring case). */
function roomNamed(db: DatabaseSync, listed: string | undefined, view: View | undefined, name: string): string | Receipt {
  const rooms = new Set<string>();
  for (const object of view?.options ?? []) if (typeof object.room === "string" && object.room !== "") rooms.add(object.room);
  for (const item of readList(db, listed, "things")?.items ?? []) {
    if (typeof item.where === "string" && item.where !== "inventory" && item.where !== "outside") rooms.add(item.where);
  }
  const wanted = name.trim().toLowerCase();
  const found = [...rooms].find((room) => room.toLowerCase() === wanted);
  if (found !== undefined) return found;
  const names = [...rooms];
  return refused("unknown_room", `There is no room called ${name.trim()}. The rooms are: ${names.length ? names.join(", ") : "none the game has shown yet"}.`);
}

/** A place: one relation to a thing or a room, and optionally a facing. The probe's words and the label's words both come from it. */
function placeOf(db: DatabaseSync, listed: string | undefined, view: View | undefined, raw: unknown): Place | Receipt {
  const bad = refused("bad_args", `place is malformed. ${PLACE_TEXT}`);
  if (!isRecord(raw)) return bad;
  const relations = Object.keys(raw).filter((key) => (RELATIONS as readonly string[]).includes(key));
  if (relations.length !== 1 || Object.keys(raw).some((key) => key !== "facing" && !relations.includes(key))) return bad;
  const relation = relations[0] as string;
  const value = raw[relation];
  if (typeof value !== "string") return bad;
  const args: Args = {};
  let words: string;
  if (relation === "wall" || relation === "in") {
    const room = roomNamed(db, listed, view, value);
    if (typeof room !== "string") return room;
    args.rel = relation;
    args.room = room;
    words = relation === "wall" ? `against a wall of ${room}` : `in ${room}`;
  } else {
    const thing = thingOf(db, listed, view, value);
    if (isReceipt(thing)) return thing;
    args.rel = relation;
    args.target_id = thing.id;
    const named = `${thing.name} (${value})`;
    words = relation === "on" ? `on ${named}` : relation === "beside" ? `beside ${named}` : `in place of ${named}`;
  }
  if ("facing" in raw) {
    if (raw.facing === "room") {
      args.facing = "room";
      words += ", facing the room";
    } else if (typeof raw.facing === "string") {
      const facing = thingOf(db, listed, view, raw.facing);
      if (isReceipt(facing)) return facing;
      args.facing = facing.id;
      words += `, facing ${facing.name} (${raw.facing})`;
    } else {
      return bad;
    }
  }
  return { args, words };
}

/** A ref of a list kind, checked by its first letter and found in the list of the session her refs name (listedSession). */
function listedRef(db: DatabaseSync, listed: string | undefined, ref: unknown, letter: string, kind: "people" | "places" | "events" | "things", tool: string): { id: string; name: string } | Receipt {
  if (typeof ref !== "string" || !REF_PATTERN.test(ref) || !ref.startsWith(letter)) {
    return refused("bad_args", `${String(ref)} must be a ${letter} ref from ${tool}.`);
  }
  const item = findListed(db, listed, kind, ref);
  return item ? { id: String(item.id), name: String(item.name) } : staleRef(ref, tool);
}

type VerbDef = {
  tool: string;
  description: string;
  properties: Args;
  required: string[];
  /** The arguments this verb takes (knowingly is always taken). */
  keys: string[];
  plan(ctx: { db: DatabaseSync; listed: string | undefined; view: View | undefined; args: Args; nowMs: number; ownerMs: number | undefined }): Planned | Receipt;
};

const VERBS: VerbDef[] = [
  {
    tool: "game_go",
    description: "Travel to a place from game_list places (an h ref). Travel moves your summoner's game too. Ask them on Discord first, and go only after their yes. It is your one act for the turn.",
    properties: { place: { type: "string", description: "The h ref of the place, from game_list places." } },
    required: ["place"],
    keys: ["place"],
    plan({ db, listed, args, ownerMs }) {
      const place = listedRef(db, listed, args.place, "h", "places", "game_list places");
      if (isReceipt(place)) return place;
      return {
        verb: "go", label: `go to ${place.name} (${String(args.place)})`, objectId: "0", args: { zone_id: place.id },
        record: { summonerLastMessageMs: ownerMs ?? null }, holdsSlot: true,
      };
    },
  },
  {
    tool: "game_save",
    description: "Save the game now. It is your one act for the turn. Refused within 15 minutes of your last save that was not refused.",
    properties: {},
    required: [],
    keys: [],
    plan({ db, args: _args, nowMs }) {
      if (saveWaiting(db)) return refused("save_pending", "You already asked the game to save, and it has not been done yet.");
      const last = lastSaveAt(db);
      if (last !== undefined && nowMs - last < SAVE_FLOOR_MS) {
        const left = Math.ceil((last + SAVE_FLOOR_MS - nowMs) / 60_000);
        return refused("save_too_soon", `You saved less than 15 minutes ago. You can save again in ${left} minute(s).`);
      }
      return { verb: "save", label: "save the game", objectId: "0", args: {}, holdsSlot: true };
    },
  },
  {
    tool: "plan_event",
    description: "Plan a game event of a type from game_list events (an e ref), with guests from game_list people (p refs). It is your one act for the turn. start is now, or a day and a time on the game clock.",
    properties: {
      type: { type: "string", description: "The e ref of the event type." },
      guests: { type: "array", items: { type: "string" }, maxItems: GUESTS_MAX, description: "Optional: up to 16 p refs." },
      start: {
        type: ["string", "object"],
        description: "Optional: \"now\" (the default), or {day: \"today\" or \"tomorrow\", time: \"HH:MM\"}.",
        properties: { day: { type: "string", enum: ["today", "tomorrow"] }, time: { type: "string" } },
      },
    },
    required: ["type"],
    keys: ["type", "guests", "start"],
    plan({ db, listed, args }) {
      const type = listedRef(db, listed, args.type, "e", "events", "game_list events");
      if (isReceipt(type)) return type;
      const guestRefs = args.guests ?? [];
      if (!Array.isArray(guestRefs) || guestRefs.length > GUESTS_MAX) return refused("bad_args", `guests is up to ${GUESTS_MAX} p refs from game_list people.`);
      const guests: Array<{ id: string; name: string; ref: string }> = [];
      for (const ref of guestRefs) {
        const guest = listedRef(db, listed, ref, "p", "people", "game_list people");
        if (isReceipt(guest)) return guest;
        guests.push({ ...guest, ref: String(ref) });
      }
      const start = args.start ?? "now";
      let startArg: "now" | { day_offset: number; hour: number; minute: number };
      let startWords = "";
      if (start === "now") {
        startArg = "now";
      } else if (isRecord(start) && (start.day === "today" || start.day === "tomorrow") && typeof start.time === "string"
        && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(start.time)) {
        const [hour, minute] = start.time.split(":").map(Number) as [number, number];
        startArg = { day_offset: start.day === "tomorrow" ? 1 : 0, hour, minute };
        startWords = ` at ${start.time} ${start.day}`;
      } else {
        return refused("bad_args", "start is \"now\", or {day: \"today\" or \"tomorrow\", time: \"HH:MM\"} on the game clock.");
      }
      const withWords = guests.length ? ` with ${guests.map((guest) => `${guest.name} (${guest.ref})`).join(", ")}` : "";
      return {
        verb: "event", label: `plan ${type.name} (${String(args.type)})${withWords}${startWords}`, objectId: "0",
        args: { situation_id: type.id, guests: guests.map((guest) => guest.id), start: startArg }, holdsSlot: true,
      };
    },
  },
  {
    tool: "game_buy",
    description: "Buy a c item from your latest game_catalog answer and place it. A home edit: six a turn. A purchase that cuts off a route stays where you put it, and the result says which routes are cut.",
    properties: {
      item: { type: "string", description: "The c ref of the item, from the catalogue answer." },
      place: { description: PLACE_TEXT, type: "object" },
      max_price: { type: "integer", minimum: 0, description: "Optional: the most it may cost; the purchase is refused above it." },
    },
    required: ["item", "place"],
    keys: ["item", "place", "max_price"],
    plan({ db, listed, view, args }) {
      const ref = args.item;
      if (typeof ref !== "string" || !REF_PATTERN.test(ref) || !ref.startsWith("c")) return refused("bad_args", "item must be a c ref from a catalogue answer.");
      const item = listed === undefined ? undefined : seenItem(db, listed, ref);
      if (!item) return staleRef(ref, "game_catalog");
      const place = placeOf(db, listed, view, args.place);
      if (isReceipt(place)) return place;
      if (args.max_price !== undefined && !(typeof args.max_price === "number" && Number.isSafeInteger(args.max_price) && args.max_price >= 0)) {
        return refused("bad_args", "max_price must be a whole number of simoleons, 0 or more.");
      }
      return {
        verb: "buy", label: `buy ${item.name} (${ref}) ${place.words}`, objectId: "0",
        args: { definition_id: item.definitionId, place: place.args, ...(args.max_price === undefined ? {} : { max_price: args.max_price }) },
        holdsSlot: false,
      };
    },
  },
  {
    tool: "game_place",
    description: "Place an item from your inventory (a t ref) on your lot. A home edit.",
    properties: { thing: { type: "string", description: "The t ref of an inventory item, from game_list things." }, place: { description: PLACE_TEXT, type: "object" } },
    required: ["thing", "place"],
    keys: ["thing", "place"],
    plan({ db, listed, view, args }) {
      const ref = args.thing;
      if (typeof ref !== "string" || !REF_PATTERN.test(ref) || !ref.startsWith("t")) return refused("bad_args", "thing must be a t ref of an inventory item.");
      const item = findListed(db, listed, "things", ref);
      if (!item) return staleRef(ref, "game_list things");
      if (item.where !== "inventory") return refused("not_in_inventory", `${ref} is not in your inventory, so it is not placed. It is ${String(item.where)}.`);
      const place = placeOf(db, listed, view, args.place);
      if (isReceipt(place)) return place;
      return {
        verb: "place", label: `place ${String(item.name)} (${ref}) ${place.words}`, objectId: String(item.id),
        args: { object_id: String(item.id), place: place.args }, holdsSlot: false,
      };
    },
  },
  {
    tool: "game_move",
    description: "Move a thing on your lot (a t or a ref) to another place. A home edit. A move that cuts off a route stays where you put it, and the result says which routes are cut.",
    properties: { thing: { type: "string", description: "A t ref from game_list things, or an a ref from the view." }, place: { description: PLACE_TEXT, type: "object" } },
    required: ["thing", "place"],
    keys: ["thing", "place"],
    plan({ db, listed, view, args }) {
      const thing = thingOf(db, listed, view, String(args.thing));
      if (isReceipt(thing)) return thing;
      const place = placeOf(db, listed, view, args.place);
      if (isReceipt(place)) return place;
      return {
        verb: "move", label: `move ${thing.name} (${String(args.thing)}) ${place.words}`, objectId: thing.id,
        args: { object_id: thing.id, place: place.args }, holdsSlot: false,
      };
    },
  },
  {
    tool: "game_sell",
    description: "Sell a thing (a t or a ref) from your lot or your inventory. It is removed. A home edit.",
    properties: { thing: { type: "string", description: "A t ref from game_list things, or an a ref from the view." } },
    required: ["thing"],
    keys: ["thing"],
    plan({ db, listed, view, args }) {
      const thing = thingOf(db, listed, view, String(args.thing));
      if (isReceipt(thing)) return thing;
      return {
        verb: "sell", label: `sell ${thing.name} (${String(args.thing)})`, objectId: thing.id,
        args: { object_id: thing.id }, holdsSlot: false,
      };
    },
  },
];

/** The verb tools, for the world's tool list. Each keeps its act with requestVerb, after the gate and the checks. */
export function verbTools(open: () => GameContext): Tool[] {
  return VERBS.map((def): Tool => ({
    spec: {
      name: def.tool,
      description: def.description,
      parameters: {
        type: "object",
        properties: { ...def.properties, knowingly: KNOWINGLY },
        required: def.required,
      },
    },
    async run(args: Args, context: ToolContext): Promise<Receipt> {
      return runVerb(open, def, args, context);
    },
  }));
}

function runVerb(open: () => GameContext, def: VerbDef, args: Args, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  for (const key of Object.keys(args)) {
    if (key !== "knowingly" && !def.keys.includes(key)) return refused("bad_args", `${key} is not a field of ${def.tool}.`);
  }
  if (args.knowingly !== undefined && typeof args.knowingly !== "boolean") return refused("bad_args", "knowingly must be true or false.");
  const gate = gameGate(game, { probe: true });
  if (gate) return gate;
  const attached = game.attachedSession(game.nowMs()) as string;
  const nowMs = game.nowMs();
  const view = viewOf(game.db, attached);
  const planned = def.plan({ db: game.db, listed: listedSession(game.db, attached), view, args, nowMs, ownerMs: game.ownerMs() });
  if (isReceipt(planned)) return planned;
  if (args.knowingly !== true) {
    const other = actRequestedMeanwhile(game.db, { thread: context.thread, nowMs });
    if (other) {
      const seconds = Math.max(0, Math.round((nowMs - other.requestedAtMs) / 1000));
      return refused(
        "acted_meanwhile",
        `Nothing was requested. Your ${other.thread} thread asked the game for "${other.label}" ${seconds} s ago. Ask again with knowingly: true if you want this too.`,
      );
    }
  }
  const kept = requestVerb(game.db, {
    thread: context.thread,
    turnId: context.turnId,
    attachment: attached,
    observationId: view?.observationId ?? null,
    verb: planned.verb,
    label: planned.label,
    objectId: planned.objectId,
    args: planned.args,
    ...(planned.record ? { record: planned.record } : {}),
    nowMs,
  });
  if (!kept.ok) {
    return refused(kept.code, "You already asked the game for one act in this turn. Ask for the next one in your next turn.");
  }
  return {
    ok: true,
    summary: `Requested: ${planned.label}. The game has not done it yet; what it does comes back here as notes.`,
    data: { actId: kept.actId, verb: planned.verb, label: planned.label, expiresAtMs: kept.expiresAtMs, ...(planned.record ?? {}) },
  };
}
