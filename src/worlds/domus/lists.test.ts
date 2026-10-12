import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../contracts.js";
import { catalogText, expireCatalog, gameCatalogTool, handCatalog, openCatalogAsk, settleCatalog, withdrawCatalog, CATALOG_TTL_MS } from "./catalog.js";
import { verbTools } from "./verbs.js";
import { findListed, gameListTool, listCountLine, listDigests, LISTS_KEEP_MS, readList, storeList } from "./lists.js";
import { openDomusDb } from "./store.js";
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

  it("answers from the stored list, one line per item, with the places sentence first", async () => {
    const receipt = await list({ what: "places" });
    expect(receipt).toMatchObject({ ok: true, data: { kind: "places", count: 3 } });
    expect(receipt.summary.split("\n")).toEqual([
      "Travel moves your summoner's game too: ask them first.",
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
    expect(receipt.summary).toContain("Things by room (ask again with room for one room's list): Kitchen 41, Bedroom 40.");
    expect(receipt.summary).toContain("In your inventory:\n- t900 Test Bag (in your inventory; value 5)");
    expect(receipt.summary.endsWith("New clothes are made in Create-a-Sim, which is your summoner's: ask them.")).toBe(true);
    const room = await list({ what: "things", room: "kitchen" });
    expect(room.summary.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(41);
  });
});

describe("the count line of her view", () => {
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

  it("expires after two minutes and withdraws on the stop", async () => {
    await ask(TEXT);
    clock += CATALOG_TTL_MS + 1000;
    expect(openCatalogAsk(db, "domus:slot3", clock)).toBeUndefined();
    expect(expireCatalog(db, clock)).toEqual([expect.objectContaining({ thread: "domus:slot3", wake: false })]);
    expect(await ask("Test Lamp")).toMatchObject({ ok: true });
    expect(withdrawCatalog(db, clock)).toEqual([expect.objectContaining({ wake: false })]);
    expect(handCatalog(db, { helperSession: HELPER, nowMs: clock })).toEqual([]);
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
});
