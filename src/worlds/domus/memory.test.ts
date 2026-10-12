import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, ToolContext } from "../../contracts.js";
import { forgetText, openDomusDb } from "./store.js";
import {
  ABOUT_MAX, expireMemory, gameMemoryTool, handMemory, MEMORY_TTL_MS, type MemoryContext, memoryEventText, type MemoryFacts,
  settleMemory,
} from "./memory.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
const HELPER = "helper-1";
const stamp = (ms: number) => `stamp ${ms}`;

let dir: string;
let db: DatabaseSync;
let clock: number;
let stopped: boolean;
let attached: boolean;

function context(overrides: Partial<NonNullable<MemoryContext>> = {}): MemoryContext {
  return {
    db,
    nowMs: () => clock,
    attachedSession: () => (attached ? HELPER : undefined),
    lastAttachedMs: () => clock - 1000,
    ...overrides,
  };
}

function ask(args: Record<string, unknown>, open: () => MemoryContext = () => context(), thread = THREAD): Promise<Receipt> {
  return gameMemoryTool(open).run(args, { thread, turnId: "t-memory", nowMs: clock } as ToolContext);
}

function askedRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT ask_id, thread, about, status, requested_at_ms, handed_session, settled_at_ms FROM memory_asks ORDER BY requested_at_ms").all() as Array<Record<string, unknown>>;
}

const ACT = {
  act_id: "a-1", at: "14:20:00.000 day:3 week:0", minutes: 45, what: "Brew Glimmer", by: "user_intent",
  needs: { Gloop: 30 }, moodlets: ["Zingy"], people: [{ who: "Mara Quill", role: "target" }], day: 3, at_ms: T0 - 90_000,
};
const FACTS: MemoryFacts = {
  matched: 2,
  acts: [ACT, { act_id: "a-2", at: "09:05:00.000 day:2 week:0", minutes: 5, what: "Fizz Watch", by: "body", day: 2, at_ms: T0 - 200_000 }],
  people: [{ who: "Mara Quill", acts: 12, last_at_ms: T0 - 90_000 }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-memory-"));
  db = openDomusDb(dir);
  clock = T0;
  stopped = false;
  attached = true;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("game_memory: she asks the game what it remembers", () => {
  it("records one owed ask for her thread and says the answer comes on the next sync", async () => {
    const receipt = await ask({ about: "Brew Glimmer" });
    expect(receipt).toMatchObject({ ok: true, summary: "Asked the game what it remembers about Brew Glimmer. The answer comes on its next sync and wakes you." });
    expect(askedRows()).toEqual([expect.objectContaining({ thread: THREAD, about: "Brew Glimmer", status: "owed", requested_at_ms: T0, handed_session: null })]);
  });

  it("trims what she asks about, and refuses an empty, long, or unknown field", async () => {
    await ask({ about: "  Mara Quill  " });
    expect(askedRows()[0]?.about).toBe("Mara Quill");
    expect(await ask({ about: "   " })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ about: "x".repeat(ABOUT_MAX + 1) })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ about: 4 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({})).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ about: "Mara", who: "x" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(askedRows()).toHaveLength(1);
  });

  it("asks from any thread, and the answer is kept for the thread that asked", async () => {
    expect(await ask({ about: "Mara" }, undefined, "cli:summoner")).toMatchObject({ ok: true });
    expect(askedRows()).toEqual([expect.objectContaining({ thread: "cli:summoner", about: "Mara", status: "owed" })]);
  });

  it("is refused while the world is not running and while the game is not attached, and is still asked while the summoner's stop is on (Q-j: a read, not an act)", async () => {
    expect(await ask({ about: "Mara" }, () => null)).toMatchObject({ ok: false, refused: { code: "not_running" } });
    stopped = true;
    // The question asked while the stop is on is kept (a read); the detached ask below adds none.
    expect(await ask({ about: "Mara" })).toMatchObject({ ok: true });
    stopped = false;
    attached = false;
    const detached = await ask({ about: "Mara" });
    expect(detached).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect(detached.refused?.reason).toContain("It was last attached at");
    expect(askedRows()).toHaveLength(1);
  });

  it("keeps one open question per thread, and a question on another thread is not blocked by it", async () => {
    await ask({ about: "Mara" });
    expect(await ask({ about: "Pim" })).toMatchObject({ ok: false, refused: { code: "already_asked" } });
    expect(await ask({ about: "Pim" }, undefined, "domus:slot4")).toMatchObject({ ok: true });
  });

  it("lets her ask again once the open question has been answered or has expired", async () => {
    await ask({ about: "Mara" });
    const [first] = handMemory(db, { helperSession: HELPER, nowMs: clock });
    settleMemory(db, { askId: first!.ask_id, helperSession: HELPER, facts: FACTS, nowMs: clock });
    expect(await ask({ about: "Pim" })).toMatchObject({ ok: true });
    clock += MEMORY_TTL_MS + 1;
    expect(await ask({ about: "Lark" })).toMatchObject({ ok: true });
  });
});

describe("the hand-over on a sync", () => {
  it("hands each owed ask to the helper that syncs, once", async () => {
    await ask({ about: "Brew Glimmer" });
    expect(handMemory(db, { helperSession: HELPER, nowMs: clock })).toEqual([{ ask_id: askedRows()[0]!.ask_id, about: "Brew Glimmer" }]);
    expect(askedRows()[0]).toMatchObject({ status: "handed", handed_session: HELPER });
    expect(handMemory(db, { helperSession: HELPER, nowMs: clock })).toEqual([]);
  });
});

describe("the helper's answer", () => {
  it("is applied once, to the session it was handed to, and says what the answer was", async () => {
    await ask({ about: "Brew Glimmer" });
    const [handed] = handMemory(db, { helperSession: HELPER, nowMs: clock });
    expect(settleMemory(db, { askId: handed!.ask_id, helperSession: "helper-2", facts: FACTS, nowMs: clock })).toEqual({ applied: false });
    const settled = settleMemory(db, { askId: handed!.ask_id, helperSession: HELPER, facts: FACTS, nowMs: clock + 5 });
    expect(settled).toMatchObject({ applied: true, note: { thread: THREAD, wake: true, data: { status: "answered", matched: 2 } } });
    expect(askedRows()[0]).toMatchObject({ status: "answered", settled_at_ms: clock + 5 });
    expect(settleMemory(db, { askId: handed!.ask_id, helperSession: HELPER, facts: FACTS, nowMs: clock + 6 })).toEqual({ applied: false });
  });

  it("is not applied for an ask it does not know, or one that was never handed over", async () => {
    expect(settleMemory(db, { askId: "unknown-1", helperSession: HELPER, facts: FACTS, nowMs: clock })).toEqual({ applied: false });
    await ask({ about: "Brew Glimmer" });
    expect(settleMemory(db, { askId: String(askedRows()[0]!.ask_id), helperSession: HELPER, facts: FACTS, nowMs: clock })).toEqual({ applied: false });
    expect(askedRows()[0]?.status).toBe("owed");
  });

  it("is not applied after its two minutes; the ask has expired by then", async () => {
    await ask({ about: "Brew Glimmer" });
    const [handed] = handMemory(db, { helperSession: HELPER, nowMs: clock });
    clock += MEMORY_TTL_MS;
    expect(settleMemory(db, { askId: handed!.ask_id, helperSession: HELPER, facts: FACTS, nowMs: clock })).toEqual({ applied: false });
  });
});

describe("the event that answers her", () => {
  it("lists what matched, newest first, with the day on each act and each person's count and last time", () => {
    expect(memoryEventText("Brew Glimmer", FACTS, stamp)).toBe([
      "What the game remembers about \"Brew Glimmer\" (2 matched, newest first):",
      "- Day 3, 14:20, 45 min: brew glimmer (your act); gloop +30; you felt: zingy; with Mara Quill (the one it was for).",
      "- Day 2, 09:05, 5 min: fizz watch (the game, on its own).",
      "- Mara Quill: 12 acts together, last at stamp " + (T0 - 90_000) + ".",
    ].join("\n"));
  });

  it("says the game remembers nothing when nothing matched", () => {
    expect(memoryEventText("Lark", { matched: 0, acts: [], people: [] }, stamp)).toBe("The game remembers nothing about \"Lark\".");
  });

  it("gives the expiry note without a wake, and only once the two minutes have passed", async () => {
    await ask({ about: "Brew Glimmer" });
    expect(expireMemory(db, clock + MEMORY_TTL_MS - 1)).toEqual([]);
    const notes = expireMemory(db, clock + MEMORY_TTL_MS);
    expect(notes).toEqual([{ thread: THREAD, text: "The game did not answer about \"Brew Glimmer\".", data: { askId: askedRows()[0]!.ask_id, status: "expired" }, wake: false }]);
    expect(askedRows()[0]?.status).toBe("expired");
  });

});

describe("forgetting the words of a question", () => {
  it("erases what she asked about, and an owed question is withdrawn so the helper never receives the erased words", async () => {
    await ask({ about: "Brew Glimmer" });
    expect(forgetText(db, ["brew glimmer"])).toBe(1);
    expect(askedRows()[0]).toMatchObject({ about: "[forgotten by the summoner]", status: "withdrawn" });
    expect(handMemory(db, { helperSession: HELPER, nowMs: clock })).toEqual([]);
  });
});
