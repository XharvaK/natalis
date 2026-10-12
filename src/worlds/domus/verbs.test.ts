import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, ToolContext } from "../../contracts.js";
import { actRequestedMeanwhile, syncActs } from "./acts.js";
import { gameActTool, type GameActContext } from "./game-act.js";
import { markListed, storeList } from "./lists.js";
import { admitObservation, openDomusDb, type Row } from "./store.js";
import type { GameContext } from "./tool-context.js";
import { SAVE_FLOOR_MS, verbTools } from "./verbs.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
const HELPER = "helper-1";
const OWNER = T0 - 5 * 60_000;

let dir: string;
let db: DatabaseSync;
let clock: number;
let attached: boolean;
let probe: string | undefined;

function game(): GameContext {
  return {
    db,
    nowMs: () => clock,
    stopped: () => false,
    attachedSession: () => (attached ? HELPER : undefined),
    lastAttachedMs: () => clock - 1000,
    probeOf: () => probe,
    ownerMs: () => OWNER,
  };
}

function tool(name: string) {
  const found = verbTools(game).find((item) => item.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function call(name: string, args: Record<string, unknown>, turnId = "t-1", thread = THREAD): Promise<Receipt> {
  return tool(name).run(args, { thread, turnId, nowMs: clock } as ToolContext);
}

/** One admitted view of the attached session: its option table (and portrait, when given). */
function seedView(options: unknown[], portrait?: unknown): void {
  admitObservation(db, {
    observationId: `${HELPER}.${clock}`, digest: `d${clock}`, thread: THREAD, world: "slot3", branch: "b", session: "s",
    attachment: HELPER, body: "body", snapshot: "snap", seq: clock, sourceTimeMs: clock, expiresAtMs: clock + 60_000,
    receiptTimeMs: clock, lineageClass: "LIVE", payloadJson: JSON.stringify({ options, ...(portrait === undefined ? {} : { portrait }) }),
  });
}

/** The lists as she has listed them: the game sent them, and her last game_list answer named this session. */
function seedLists(): void {
  markListed(db, HELPER);
  storeList(db, {
    attachment: HELPER, kind: "places", digest: "p", nowMs: clock,
    items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "venue", what: "Park" }],
  });
  storeList(db, {
    attachment: HELPER, kind: "people", digest: "p", nowMs: clock,
    items: [{ ref: "p1", id: "4001", name: "Ana Example", how: "friend", home: false, here: true, waiting: false }],
  });
  storeList(db, {
    attachment: HELPER, kind: "events", digest: "e", nowMs: clock,
    items: [{ ref: "e1", id: "guid-party", name: "Test Party", cost: 50 }],
  });
  storeList(db, {
    attachment: HELPER, kind: "things", digest: "t", nowMs: clock,
    items: [
      { ref: "t1", id: "555", name: "Test Chair", where: "inventory", count: 1 },
      { ref: "t2", id: "556", name: "Test Lamp", where: "inventory", count: 3 },
      { ref: "t9", id: "777", name: "Test Table", where: "Kitchen", value: 120, in_use: false },
    ],
  });
  for (let index = 0; index < 8; index++) {
    db.prepare("INSERT INTO catalog_seen (attachment, ref, definition_id, name, price, at_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(HELPER, `c${index + 1}`, `def-${index + 1}`, `Test Shelf ${index + 1}`, 100, clock);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-verbs-"));
  db = openDomusDb(dir);
  clock = T0;
  attached = true;
  probe = "2.40.0";
  seedLists();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function actRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT act_id, turn_id, verb, label, state, object_id, guid64, args_json FROM acts ORDER BY requested_at_ms, rowid")
    .all() as Array<Record<string, unknown>>;
}

describe("game_go", () => {
  it("keeps a travel act with the zone and the summoner's last message, and no guid", async () => {
    seedView([]);
    const receipt = await call("game_go", { place: "h1" });
    expect(receipt).toMatchObject({ ok: true, data: { verb: "go", summonerLastMessageMs: OWNER } });
    const [row] = actRows();
    expect(row).toMatchObject({ verb: "go", label: "go to Test Park (h1)", guid64: "", object_id: "0" });
    expect(JSON.parse(String(row?.args_json))).toEqual({ args: { zone_id: "9001" }, record: { summonerLastMessageMs: OWNER } });
  });

  it("refuses a probe older than 2.40.0, and a place that is not in the list", async () => {
    seedView([]);
    probe = "2.39.0";
    expect(await call("game_go", { place: "h1" })).toMatchObject({ ok: false, refused: { code: "probe_too_old" } });
    probe = "2.40.0";
    expect(await call("game_go", { place: "h9" })).toMatchObject({ ok: false, refused: { code: "stale_list" } });
    expect(actRows()).toHaveLength(0);
  });

  it("holds the turn's one-act slot: a save in the same turn is refused", async () => {
    seedView([]);
    expect(await call("game_go", { place: "h1" }, "t-same")).toMatchObject({ ok: true });
    expect(await call("game_save", {}, "t-same")).toMatchObject({ ok: false, refused: { code: "one_act_per_turn" } });
  });

  it("is held for another thread's request within a minute, unless knowingly", async () => {
    seedView([]);
    await call("game_save", {}, "t-a", "domus:other");
    expect(actRequestedMeanwhile(db, { thread: THREAD, nowMs: clock })).toBeDefined();
    expect(await call("game_go", { place: "h1" }, "t-b")).toMatchObject({ ok: false, refused: { code: "acted_meanwhile" } });
    expect(await call("game_go", { place: "h1", knowingly: true }, "t-b")).toMatchObject({ ok: true });
  });
});

describe("game_save", () => {
  it("is refused within the fifteen-minute floor, and allowed after it", async () => {
    seedView([]);
    expect(await call("game_save", {}, "t-1")).toMatchObject({ ok: true, data: { verb: "save" } });
    clock += 5 * 60_000;
    const soon = await call("game_save", {}, "t-2");
    expect(soon).toMatchObject({ ok: false, refused: { code: "save_too_soon" } });
    expect(soon.refused?.reason).toContain("10 minute");
    clock += SAVE_FLOOR_MS;
    expect(await call("game_save", {}, "t-3")).toMatchObject({ ok: true });
  });
});

describe("plan_event", () => {
  it("maps a day and a time on the game clock, and the guests to sim ids", async () => {
    seedView([]);
    const receipt = await call("plan_event", { type: "e1", guests: ["p1"], start: { day: "tomorrow", time: "19:30" } });
    expect(receipt).toMatchObject({ ok: true, data: { verb: "event" } });
    const args = JSON.parse(String((actRows()[0] as Row).args_json)).args;
    expect(args).toEqual({ situation_id: "guid-party", guests: ["4001"], start: { day_offset: 1, hour: 19, minute: 30 } });
    expect(String((actRows()[0] as Row).label)).toBe("plan Test Party (e1) with Ana Example (p1) at 19:30 tomorrow");
  });

  it("refuses a time that is not HH:MM, and an unknown guest", async () => {
    seedView([]);
    expect(await call("plan_event", { type: "e1", start: { day: "today", time: "7pm" } })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await call("plan_event", { type: "e1", guests: ["p7"] })).toMatchObject({ ok: false, refused: { code: "stale_list" } });
  });
});

describe("home edits", () => {
  const shelfPlace = { on: "t9" };

  it("lets a turn make six home edits, not held by the one-act rule, and refuses the seventh", async () => {
    seedView([]);
    await call("game_go", { place: "h1" }, "t-home");
    for (let index = 1; index <= 6; index++) {
      expect(await call("game_buy", { item: `c${index}`, place: shelfPlace }, "t-home")).toMatchObject({ ok: true, data: { verb: "buy" } });
    }
    expect(await call("game_buy", { item: "c7", place: shelfPlace }, "t-home")).toMatchObject({ ok: false, refused: { code: "home_edits_full" } });
  });

  it("buys a catalogue item beside a thing, with its label in the game's words", async () => {
    seedView([]);
    const receipt = await call("game_buy", { item: "c2", place: { beside: "t9" }, max_price: 200 });
    expect(receipt).toMatchObject({ ok: true });
    const row = actRows()[0] as Row;
    expect(row.label).toBe("buy Test Shelf 2 (c2) beside Test Table (t9)");
    expect(JSON.parse(String(row.args_json)).args).toEqual({
      definition_id: "def-2", place: { rel: "beside", target_id: "777" }, max_price: 200,
    });
  });

  it("places an inventory item in a named room, and refuses a room that is not on the game's lists", async () => {
    seedView([{ object: "Bed", object_id: "77", room: "Bedroom", near: true, acts: [{ ref: "a1", guid64: "901", text: "Sleep" }] }]);
    expect(await call("game_place", { thing: "t1", place: { in: "kitchen" } }, "t-p1")).toMatchObject({ ok: true });
    expect(JSON.parse(String((actRows()[0] as Row).args_json)).args.place).toEqual({ rel: "in", room: "Kitchen" });
    const unknown = await call("game_place", { thing: "t2", place: { wall: "Garage" } }, "t-p2");
    expect(unknown).toMatchObject({ ok: false, refused: { code: "unknown_room" } });
    expect(unknown.refused?.reason).toContain("Bedroom");
  });

  it("refuses to place a thing that is not in the inventory, and takes a facing as the room or a thing", async () => {
    seedView([{ object: "Bed", object_id: "77", room: "Bedroom", near: true, acts: [{ ref: "a1", guid64: "901", text: "Sleep" }] }]);
    expect(await call("game_place", { thing: "t9", place: { in: "Kitchen" } })).toMatchObject({ ok: false, refused: { code: "not_in_inventory" } });
    expect(await call("game_place", { thing: "t2", place: { on: "a1", facing: "room" } }, "t-f")).toMatchObject({ ok: true });
    const args = JSON.parse(String((actRows()[0] as Row).args_json)).args;
    expect(args).toEqual({ object_id: "556", place: { rel: "on", target_id: "77", facing: "room" } });
  });

  it("moves or sells a thing by its a ref (its object), and marks the object as the act's", async () => {
    seedView([{ object: "Bed", object_id: "77", room: "Bedroom", near: true, acts: [{ ref: "a1", guid64: "901", text: "Sleep" }] }]);
    expect(await call("game_move", { thing: "a1", place: { in: "Bedroom" } }, "t-m")).toMatchObject({ ok: true });
    expect(actRows()[0]).toMatchObject({ object_id: "77", label: "move Bed (a1) in Bedroom" });
    expect(await call("game_sell", { thing: "t9" }, "t-s")).toMatchObject({ ok: true, data: { verb: "sell" } });
  });

  it("refuses a thing ref in the place that is not in the list, and a bad place", async () => {
    seedView([]);
    expect(await call("game_buy", { item: "c2", place: { on: "t99" } })).toMatchObject({ ok: false, refused: { code: "stale_list" } });
    expect(await call("game_buy", { item: "c2", place: { on: "t9", in: "Kitchen" } })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await call("game_buy", { item: "c99", place: { on: "t9" } })).toMatchObject({ ok: false, refused: { code: "stale_list" } });
  });
});

describe("the sync hands a verb act to the helper, and its result comes back as a note", () => {
  it("hands the verb with its args and no guid, and words a finished act by its result", async () => {
    seedView([]);
    await call("game_go", { place: "h1" });
    const first = syncActs(db, { attachment: HELPER, events: [], nowMs: clock });
    expect(first.acts).toEqual([
      expect.objectContaining({ verb: "go", args: { zone_id: "9001" }, object_id: "0" }),
    ]);
    expect(first.acts[0]).not.toHaveProperty("guid64");
    const actId = first.acts[0]?.act_id as string;
    const done = syncActs(db, {
      attachment: HELPER, nowMs: clock + 1000,
      events: [{ actId, phase: "finished", atMs: clock, detail: { result: "You are at Test Park." } }],
    });
    expect(done.notes).toEqual([
      expect.objectContaining({ thread: THREAD, text: 'Your act "go to Test Park (h1)": You are at Test Park.', wake: true }),
    ]);
  });

  it("gives a sim choice to a game act that needs one, and refuses sim where none is needed", async () => {
    seedView([{ object: "Phone", object_id: "88", room: "Living", near: true, acts: [{ ref: "a2", guid64: "902", text: "Call", needs_sim: true }] },
      { object: "Bed", object_id: "77", room: "Bedroom", near: true, acts: [{ ref: "a1", guid64: "901", text: "Sleep" }] }]);
    const acting = (args: Record<string, unknown>, turnId: string) => gameActTool(() => ({
      db, nowMs: () => clock, attachedSession: () => (attached ? HELPER : undefined), lastAttachedMs: () => clock,
      probeOf: () => probe,
    } as GameActContext)).run(args, { thread: THREAD, turnId, nowMs: clock } as ToolContext);
    expect(await acting({ option: "a2" }, "t-x")).toMatchObject({ ok: false, refused: { code: "sim_needed" } });
    expect(await acting({ option: "a1", sim: "p1" }, "t-y")).toMatchObject({ ok: false, refused: { code: "not_a_sim_act" } });
    expect(await acting({ option: "a2", sim: "p9" }, "t-z")).toMatchObject({ ok: false, refused: { code: "stale_list" } });
    probe = "2.39.9";
    expect(await acting({ option: "a2", sim: "p1" }, "t-w")).toMatchObject({ ok: false, refused: { code: "probe_too_old" } });
    probe = "2.40.0";
    expect(await acting({ option: "a2", sim: "p1" }, "t-v")).toMatchObject({ ok: true });
    const sync = syncActs(db, { attachment: HELPER, events: [], nowMs: clock });
    expect(sync.acts).toEqual([expect.objectContaining({ guid64: "902", sim_id: "4001" })]);
  });
});
