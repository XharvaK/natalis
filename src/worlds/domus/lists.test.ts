import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../contracts.js";
import { catalogText, expireCatalog, gameCatalogTool, handCatalog, openCatalogAsk, settleCatalog, CATALOG_TTL_MS } from "./catalog.js";
import { verbTools } from "./verbs.js";
import { findListed, gameListTool, listCountLine, listDigests, LISTS_KEEP_MS, readList, storeList } from "./lists.js";
import { renderView } from "./options.js";
import { admitObservation, openDomusDb } from "./store.js";
import { parseActSync, parseCatalog, parseLists, RESULT_MAX } from "./wire.js";
import type { GameContext } from "./tool-context.js";

const T0 = 1_800_000_000_000;
const HELPER = "helper-1";
const DIGEST = "a".repeat(64);

let dir: string;
let db: DatabaseSync;
let clock: number;
let attached: boolean;
let session: string;

function game(): GameContext {
  return {
    db, nowMs: () => clock, stopped: () => false, attachedSession: () => (attached ? session : undefined),
    lastAttachedMs: () => clock - 1000, probeOf: () => "2.40.0", ownerMs: () => undefined,
  };
}

function list(args: Record<string, unknown>) {
  return gameListTool(game).run(args, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-lists-"));
  db = openDomusDb(dir);
  clock = T0;
  attached = true;
  session = HELPER;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the lists the helper sends", () => {
  it("lets go of another session's lists and catalogue items a week after their last write, and keeps younger ones", () => {
    storeList(db, { attachment: "old", kind: "people", digest: DIGEST, items: [], nowMs: clock });
    db.prepare("INSERT INTO catalog_seen (attachment, ref, definition_id, name, price, at_ms) VALUES ('old', 'c1', '9', 'Test Chair', 5, ?)").run(clock);
    storeList(db, { attachment: "young", kind: "people", digest: DIGEST, items: [], nowMs: clock + LISTS_KEEP_MS });
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, items: [], nowMs: clock + LISTS_KEEP_MS + 1 });
    expect(readList(db, "old", "people")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_seen WHERE attachment = 'old'").get()).toEqual({ n: 0 });
    expect(readList(db, "young", "people")).toBeDefined();
    expect(readList(db, HELPER, "people")).toBeDefined();
  });

  it("lets go of a settled catalogue ask a week after it was asked, and keeps one still open", () => {
    db.prepare("INSERT INTO catalog_asks (ask_id, thread, about, status, requested_at_ms) VALUES ('old-ask', 'domus:slot3', 'Test Shelf', 'answered', ?)").run(clock);
    db.prepare("INSERT INTO catalog_asks (ask_id, thread, about, status, requested_at_ms) VALUES ('open-ask', 'domus:slot3', 'Test Lamp', 'owed', ?)").run(clock);
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, items: [], nowMs: clock + LISTS_KEEP_MS + 1 });
    expect(db.prepare("SELECT ask_id FROM catalog_asks ORDER BY ask_id").all()).toEqual([{ ask_id: "open-ask" }]);
  });

  it("keeps the newest list per session and kind, and reports its digest in the sync answer", () => {
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, items: [{ ref: "p1", id: "1", name: "Ana Example" }], nowMs: clock });
    storeList(db, { attachment: HELPER, kind: "people", digest: "b".repeat(64), items: [{ ref: "p2", id: "2", name: "Ben Example" }], nowMs: clock + 1 });
    expect(readList(db, HELPER, "people")?.items).toEqual([{ ref: "p2", id: "2", name: "Ben Example" }]);
    expect(listDigests(db, HELPER)).toEqual({ people: "b".repeat(64) });
    expect(listDigests(db, "helper-2")).toEqual({});
    expect(findListed(db, HELPER, "people", "p1")).toBeUndefined();
  });

  it("is checked on the wire: a kind, a digest, item keys and the item count", () => {
    const body = (overrides: Record<string, unknown>) => ({ v: 1, helper_session: HELPER, kind: "places", digest: DIGEST,
      items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "venue", what: "Park" }], ...overrides });
    expect(parseLists(body({})).items).toHaveLength(1);
    expect(() => parseLists(body({ kind: "cars" }))).toThrow();
    expect(() => parseLists(body({ digest: "xyz" }))).toThrow();
    expect(() => parseLists(body({ items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "castle" }] }))).toThrow();
    expect(() => parseLists(body({ items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "venue", secret: 1 }] }))).toThrow();
    // NATALIS-16: a ref repeated in one list is refused, since only the first of two items with it could ever be named.
    expect(() => parseLists(body({ items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "venue" }, { ref: "h1", id: "9002", name: "Test Flat", kind: "home" }] }))).toThrow();
    expect(() => parseLists(body({ items: Array.from({ length: 121 }, (_, i) => ({ ref: "h1", id: String(i), name: "x", kind: "venue" })) }))).toThrow();
  });
});

describe("game_list", () => {
  beforeEach(() => {
    storeList(db, { attachment: HELPER, kind: "places", digest: DIGEST, nowMs: clock, items: [
      { ref: "h1", id: "9001", name: "Test Park", kind: "venue", what: "Park" },
      { ref: "h2", id: "9002", name: "Test House", kind: "household", what: "Ana Example" },
      { ref: "h3", id: "9003", name: "Test Flat", kind: "home", what: "" },
    ] });
  });

  it("answers from the stored list, one line per item", async () => {
    const receipt = await list({ what: "places" });
    expect(receipt).toMatchObject({ ok: true, data: { kind: "places", count: 3 } });
    expect(receipt.summary.split("\n")).toEqual([
      "- h1 Test Park (Park)",
      "- h2 Test House (home of Ana Example)",
      "- h3 Test Flat (your home)",
    ]);
  });

  it("refuses an unknown kind and a room on a kind that has none, and says when the list has not come", async () => {
    expect(await list({ what: "cars" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await list({ what: "places", room: "Kitchen" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await list({ what: "events" })).toMatchObject({ ok: false, refused: { code: "no_list" } });
  });

  it("refuses a ref from a session she did not list under, after the game attaches to another one, and names the tool", async () => {
    storeList(db, { attachment: HELPER, kind: "things", digest: DIGEST, nowMs: clock, items: [{ ref: "t1", id: "11", name: "Test Bed", where: "inventory" }] });
    storeList(db, { attachment: "helper-2", kind: "things", digest: DIGEST, nowMs: clock, items: [{ ref: "t1", id: "22", name: "Test Lamp", where: "inventory" }] });
    expect(await list({ what: "things" })).toMatchObject({ ok: true });
    session = "helper-2";
    const sell = (args: Record<string, unknown>) => verbTools(game).find((item) => item.spec.name === "game_sell")!
      .run(args, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
    const stale = await sell({ thing: "t1" });
    expect(stale).toMatchObject({ ok: false, refused: { code: "stale_list" } });
    expect(stale.summary).toContain("game_list things");
    expect(db.prepare("SELECT COUNT(*) AS n FROM acts").get()).toEqual({ n: 0 });
    // Once she lists under the session attached now, its refs are the ones she can use.
    expect(await list({ what: "things" })).toMatchObject({ ok: true });
    expect(await sell({ thing: "t1" })).not.toMatchObject({ refused: { code: "stale_list" } });
  });

  it("refuses while the game is not attached, and changes nothing", async () => {
    attached = false;
    expect(await list({ what: "places" })).toMatchObject({ ok: false, refused: { code: "not_attached" } });
  });

  it("answers things with counts per room and the inventory in full past eighty, and ends with its sentence", async () => {
    const items = Array.from({ length: 81 }, (_, index) => ({
      ref: `t${index + 1}`, id: String(1000 + index), name: `Test Item ${index + 1}`, where: index % 2 === 0 ? "Kitchen" : "Bedroom", value: 10,
    }));
    items.push({ ref: "t900", id: "5000", name: "Test Bag", where: "inventory", value: 5 } as never);
    storeList(db, { attachment: HELPER, kind: "things", digest: DIGEST, nowMs: clock, items: items as never });
    const receipt = await list({ what: "things" });
    expect(receipt.summary).toContain("Things by room (ask again with room for one room's list): Kitchen: 41 things; Bedroom: 40 things.");
    expect(receipt.summary).toContain("In your inventory:\n- t900 Test Bag (in your inventory; value 5)");
    expect(receipt.summary).not.toContain("Create-a-Sim"); // Q-k: the things answer carries no clothes line
    const room = await list({ what: "things", room: "kitchen" });
    expect(room.summary.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(41);
  });
});

describe("game_list acts on one object (D3)", () => {
  // The long text stands in for a whole lot of ordinary objects, so the view's own cap cuts the toilet off the end.
  const LONG_ACT = "Look at it very closely and turn it over in your hands, again and again. ".repeat(20);
  const FILLERS = Array.from({ length: 15 }, (_, index) => ({
    object: `Test thing ${index + 1}`,
    object_id: `thing-${index + 1}`,
    room: "Test hall",
    where: `elsewhere, ${index + 1}.0 m`,
    acts: [{ ref: `a${index + 3}`, guid64: `${index + 3}`, text: LONG_ACT }],
  }));
  const TOILET = {
    object: "Test toilet upstairs",
    object_id: "toilet-up",
    room: "Test bathroom",
    where: "elsewhere, 999.0 m",
    acts: [
      { ref: "a50", guid64: "50", text: "Use the toilet" },
      { ref: "a51", guid64: "51", text: "Clean the toilet" },
    ],
  };
  let viewSeq: number;

  beforeEach(() => {
    viewSeq = 0;
  });

  function observe(options: unknown[]): void {
    viewSeq += 1;
    admitObservation(db, {
      observationId: `helper-1.${viewSeq}`, digest: "b".repeat(64), thread: "domus:slot3", world: "slot3", branch: "branch-1",
      session: "telemetry-1", attachment: HELPER, body: "sim-9", snapshot: "7", seq: viewSeq, sourceTimeMs: clock - 1000,
      expiresAtMs: clock + 30_000, receiptTimeMs: clock, lineageClass: "LIVE", payloadJson: JSON.stringify({ options }),
    });
  }

  it("returns every act on an object the view cap left out, with its refs", async () => {
    expect(renderView({ world: "slot3", percepts: [], options: [...FILLERS, TOILET] })).not.toContain("a50 Use the toilet");
    storeList(db, { attachment: HELPER, kind: "things", digest: DIGEST, nowMs: clock, items: [
      { ref: "t263", id: "toilet-up", name: "Test toilet upstairs", where: "Test bathroom" },
    ] });
    observe([...FILLERS, TOILET]);
    expect(await list({ what: "things" })).toMatchObject({ ok: true });
    const receipt = await list({ what: "acts", object: "t263" });
    expect(receipt).toMatchObject({ ok: true, data: { kind: "acts", object: "Test toilet upstairs", count: 2 } });
    expect(receipt.summary).toContain("- a50 Use the toilet");
    expect(receipt.summary).toContain("- a51 Clean the toilet");
  });

  it("takes the object's name too, and says it plainly when no object has that name", async () => {
    observe([TOILET]);
    const byName = await list({ what: "acts", object: "test toilet upstairs" });
    expect(byName).toMatchObject({ ok: true, data: { count: 2 } });
    const missing = await list({ what: "acts", object: "Test missing thing" });
    expect(missing).toMatchObject({ ok: false, refused: { code: "unknown_object" } });
    expect(missing.summary).toContain("game_look");
  });

  it("lists every object with that name, with its room, rather than silently choosing one", async () => {
    const down = {
      object: "Test toilet upstairs", object_id: "toilet-down", room: "Test washroom", where: "elsewhere, 60.0 m",
      acts: [{ ref: "a52", guid64: "52", text: "Use the toilet" }],
    };
    observe([TOILET, down]);
    const receipt = await list({ what: "acts", object: "Test toilet upstairs" });
    expect(receipt).toMatchObject({ ok: true, data: { count: 3 } });
    expect(receipt.summary).toContain("Test bathroom");
    expect(receipt.summary).toContain("Test washroom");
    expect(receipt.summary).toContain("- a50 Use the toilet");
    expect(receipt.summary).toContain("- a52 Use the toilet");
  });

  it("includes the object's excluded acts with plain reasons, and the acts it refused or left out", async () => {
    observe([{
      ...TOILET,
      refused: ["Use the toilet: refused: the toilet is broken"],
      left_out: ["Call Test Friend: left out: it is not on your phone list"],
      excluded: [{ text: "Test cheat act", reason: "deny_name", ref: "a333" }, { text: "Test hidden act" }],
    }]);
    const receipt = await list({ what: "acts", object: "Test toilet upstairs" });
    expect(receipt).toMatchObject({ ok: true });
    expect(receipt.summary).toContain("- a333 Test cheat act: left out: a debug, cheat or test act");
    expect(receipt.summary).toContain("- Test hidden act: left out: the game's side did not give a reason");
    expect(receipt.summary).toContain("- Use the toilet: refused: the toilet is broken");
    expect(receipt.summary).toContain("- Call Test Friend: left out: it is not on your phone list");
  });

  it("names an act the view hides after a refusal as left out now, not as offered", async () => {
    const refuse = (objectId: string, guid64: string, ref: string, n: number) => {
      const actId = `act-${objectId}-${guid64}-${n}`;
      db.prepare(`INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state,
        requested_at_ms, expires_at_ms, updated_at_ms, for_summoner) VALUES (?, 't', 'domus:slot3', ?, NULL, ?, ?, ?, 'label', 'rejected', ?, ?, ?, 0)`)
        .run(actId, HELPER, ref, objectId, guid64, clock - 1000, clock + 60_000, clock - 1000);
      db.prepare("INSERT INTO act_events (act_id, phase, at_ms, received_at_ms, detail_json) VALUES (?, 'rejected', ?, ?, '{\"code\":\"GAME_REFUSED\"}')")
        .run(actId, clock - 1000, clock - 1000);
    };
    observe([TOILET]);
    refuse("toilet-up", "50", "a50", 1);
    refuse("toilet-up", "50", "a50", 2);
    const receipt = await list({ what: "acts", object: "Test toilet upstairs" });
    expect(receipt.summary).toContain("- a50 Use the toilet: left out now, because the game refused it lately");
    expect(receipt.summary).toContain("- a51 Clean the toilet");
  });

  it("needs an object with acts, and takes no room", async () => {
    expect(await list({ what: "acts" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await list({ what: "acts", object: "Test toilet upstairs", room: "Test bathroom" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await list({ what: "things", object: "Test toilet upstairs" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
  });

  it("points a capped view to this request", () => {
    expect(renderView({ world: "slot3", percepts: [], options: FILLERS }))
      .toContain("game_list acts with one thing's ref or name shows every act on it.");
  });
});

describe("the count line of her view", () => {
  it("says the game's total with the number listed, when the game counted more things than it sent (T1)", () => {
    const things = Array.from({ length: 30 }, (_, index) => ({ ref: `t${index + 1}`, id: String(index + 1), name: `Test Thing ${index + 1}`, where: "inventory" }));
    storeList(db, { attachment: HELPER, kind: "things", digest: DIGEST, nowMs: clock, items: things, total: 41 });
    expect(listCountLine(db, HELPER)).toBe("41 things (30 listed): game_list shows them.");
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, nowMs: clock, items: [{ ref: "p1", id: "1", name: "A" }], total: 3 });
    storeList(db, { attachment: HELPER, kind: "things", digest: DIGEST, nowMs: clock, items: things, total: 30 });
    expect(listCountLine(db, HELPER)).toBe("You know 3 people (1 listed); 30 things: game_list shows them.");
  });

  it("says what she knows from the stored lists, and leaves out a list that is not there", () => {
    expect(listCountLine(db, HELPER)).toBeUndefined();
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, nowMs: clock, items: [{ ref: "p1", id: "1", name: "A" }, { ref: "p2", id: "2", name: "B" }] });
    storeList(db, { attachment: HELPER, kind: "places", digest: DIGEST, nowMs: clock, items: [{ ref: "h1", id: "9", name: "C", kind: "venue" }] });
    expect(listCountLine(db, HELPER)).toBe("You know 2 people; 1 places: game_list shows them.");
    storeList(db, { attachment: HELPER, kind: "events", digest: DIGEST, nowMs: clock, items: [{ ref: "e1", id: "g", name: "D" }] });
    expect(listCountLine(db, HELPER)).toBe("You know 2 people; 1 places, 1 kinds of event: game_list shows them.");
  });
});

describe("the catalogue ask", () => {
  const TEXT = "Test Shelf";

  function ask(words: string, thread = "domus:slot3") {
    return gameCatalogTool(game).run({ words }, { thread, turnId: "t", nowMs: clock } as ToolContext);
  }

  it("is one open question per thread, handed once, answered into the items for buy, and expires", async () => {
    expect(await ask(TEXT)).toMatchObject({ ok: true });
    expect(await ask("Test Lamp")).toMatchObject({ ok: false, refused: { code: "already_asked" } });
    expect(await ask("")).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    const handed = handCatalog(db, { helperSession: HELPER, nowMs: clock });
    expect(handed).toEqual([{ ask_id: expect.any(String), words: TEXT }]);
    expect(handCatalog(db, { helperSession: HELPER, nowMs: clock })).toEqual([]);
    const askId = String(handed[0]?.ask_id);
    const settled = settleCatalog(db, {
      askId, helperSession: HELPER, matched: 2, funds: 500, nowMs: clock + 1000,
      items: [
        { ref: "c1", id: "def-1", name: "Test Shelf One", price: 80, placement: "wall", category: "decor" },
        { ref: "c2", id: "def-2", name: "Test Shelf Two", price: 120, placement: null },
      ],
    });
    expect(settled).toMatchObject({ applied: true, note: { thread: "domus:slot3", wake: true } });
    if (settled.applied) {
      expect(settled.note.text).toBe([
        `What the game's catalogue has for "${TEXT}" (2 matched):`,
        "- c1 Test Shelf One, §80, wall",
        "- c2 Test Shelf Two, §120",
        "Your money: §500.",
      ].join("\n"));
    }
    expect(settleCatalog(db, { askId, helperSession: HELPER, matched: 0, items: [], nowMs: clock + 2000 })).toEqual({ applied: false });
    expect(findListed(db, HELPER, "people", "c1")).toBeUndefined();
    expect(db.prepare("SELECT definition_id, name, price FROM catalog_seen WHERE ref = 'c1'").get()).toEqual({ definition_id: "def-1", name: "Test Shelf One", price: 80 });
  });

  it("takes no room: the tool refuses one, and the ask the helper gets names none", async () => {
    const withRoom = await gameCatalogTool(game).run({ words: TEXT, room: "Test Kitchen" }, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
    expect(withRoom).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask(TEXT)).toMatchObject({ ok: true });
    expect(handCatalog(db, { helperSession: HELPER, nowMs: clock })).toEqual([{ ask_id: expect.any(String), words: TEXT }]);
  });

  it("expires after two minutes", async () => {
    await ask(TEXT);
    clock += CATALOG_TTL_MS + 1000;
    expect(openCatalogAsk(db, "domus:slot3", clock)).toBeUndefined();
    expect(expireCatalog(db, clock)).toEqual([expect.objectContaining({ thread: "domus:slot3", wake: false })]);
    expect(await ask("Test Lamp")).toMatchObject({ ok: true });
  });

  it("says that nothing matched in one line", () => {
    expect(catalogText("Test Lamp", 0, [], undefined)).toBe("The game's catalogue has nothing for \"Test Lamp\".");
  });
});

describe("the sync and wire limits for the new keys", () => {
  it("takes a verb result up to its limit, cuts a longer one, and refuses a result that is not words", () => {
    const event = (result: string) => ({ v: 1, helper_session: HELPER, events: [{ act_id: "a1", phase: "finished", at_ms: 1, detail: { result } }] });
    expect(parseActSync(event("x".repeat(RESULT_MAX))).events[0]?.detail).toEqual({ result: "x".repeat(RESULT_MAX) });
    // A longer report is cut, not refused: one long report must not refuse every event in the body.
    expect(parseActSync(event("x".repeat(RESULT_MAX + 1))).events[0]?.detail).toEqual({ result: "x".repeat(RESULT_MAX) });
    expect(() => parseActSync({ v: 1, helper_session: HELPER, events: [{ act_id: "a1", phase: "finished", at_ms: 1, detail: { result: 5 } }] })).toThrow();
  });

  it("checks a catalogue answer: at most twelve items, a price as a whole number", () => {
    const item = { ref: "c1", id: "def-1", name: "Test Shelf", price: 80, placement: "wall", category: "decor" };
    expect(parseCatalog({ v: 1, helper_session: HELPER, ask_id: "ask-1", matched: 1, items: [item] }).items).toHaveLength(1);
    expect(() => parseCatalog({ v: 1, helper_session: HELPER, ask_id: "ask-1", matched: 1, items: [{ ...item, price: 1.5 }] })).toThrow();
    expect(() => parseCatalog({ v: 1, helper_session: HELPER, ask_id: "ask-1", matched: 13, items: Array(13).fill(item) })).toThrow();
  });
});

describe("forgetting words reaches the new tables", () => {
  it("erases a list's names and a catalogue item's name", async () => {
    const { forgetText } = await import("./store.js");
    const { FORGOTTEN_LINE } = await import("../../notebook/forget.js");
    storeList(db, { attachment: HELPER, kind: "places", digest: DIGEST, nowMs: clock, items: [{ ref: "h1", id: "9001", name: "Test Park", kind: "venue" }] });
    db.prepare("INSERT INTO catalog_seen (attachment, ref, definition_id, name, price, at_ms) VALUES (?, 'c1', 'def-1', 'Test Lamp Shade', 80, ?)").run(HELPER, clock);
    expect(forgetText(db, ["test park"])).toBe(1);
    // The list row goes, so the sync answer no longer holds its digest and the helper sends the game's list again.
    expect(readList(db, HELPER, "places")).toBeUndefined();
    expect(listDigests(db, HELPER)).toEqual({});
    expect(forgetText(db, ["lamp shade"])).toBe(1);
    expect(db.prepare("SELECT name FROM catalog_seen WHERE ref = 'c1'").get()).toEqual({ name: FORGOTTEN_LINE });
  });

  it("erases the room a catalogue ask named, for asks written before the room was dropped", async () => {
    const { forgetText } = await import("./store.js");
    const { FORGOTTEN_LINE } = await import("../../notebook/forget.js");
    db.prepare("INSERT INTO catalog_asks (ask_id, thread, about, status, requested_at_ms, room) VALUES ('ask-f', 'domus:slot3', 'Test Shelf', 'answered', ?, 'Test Kitchen')").run(clock);
    expect(forgetText(db, ["test kitchen"])).toBe(1);
    expect(db.prepare("SELECT room FROM catalog_asks WHERE ask_id = 'ask-f'").get()).toEqual({ room: FORGOTTEN_LINE });
  });
});

describe("the summoner's stop refuses acts only: the lists and the catalogue are still read (Q-j)", () => {
  it("game_list answers while the stop is on, from the stored list", async () => {
    storeList(db, { attachment: HELPER, kind: "people", digest: DIGEST, items: [{ ref: "p1", id: "1", name: "Test Friend" }], nowMs: clock });
    const stoppedGame = () => ({ ...game(), stopped: () => true });
    const receipt = await gameListTool(stoppedGame).run({ what: "people" }, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
    expect(receipt).toMatchObject({ ok: true });
  });
});

describe("the game's lists and catalogue need the probe that answers them (NATALIS2-8)", () => {
  it("game_list refuses a probe older than 2.40.0 with the same words the verbs use, and asks nothing", async () => {
    const old = () => ({ ...game(), probeOf: () => "2.30.0" });
    const receipt = await gameListTool(old).run({ what: "people" }, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
    expect(receipt).toMatchObject({ ok: false, refused: { code: "probe_too_old" } });
  });

  it("game_catalog refuses a probe older than 2.40.0 before it asks the game", async () => {
    const { gameCatalogTool } = await import("./catalog.js");
    const old = () => ({ ...game(), probeOf: () => "2.30.0" });
    const receipt = await gameCatalogTool(old).run({ words: "test lamp" }, { thread: "domus:slot3", turnId: "t", nowMs: clock } as ToolContext);
    expect(receipt).toMatchObject({ ok: false, refused: { code: "probe_too_old" } });
  });
});
