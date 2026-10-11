import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import type { OptionObject } from "./answers.js";
import { gameActTool, type GameActContext } from "./game-act.js";
import { admitObservation, markSpanUndone, openDomusDb } from "./store.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
const HELPER = "helper-1";

const VIEW: OptionObject[] = [
  { object: "Test kettle", object_id: "obj-kettle", where: "here, 2.0 m", acts: [
    { ref: "a1", guid64: "111", text: "Boil water" },
    { ref: "a2", guid64: "112", text: "Tidy up" },
  ] },
  { object: "Test bench", object_id: "obj-bench", acts: [
    { ref: "a3", guid64: "211", text: "Sit down" },
    { ref: "a4", guid64: "212", text: "Stand up" },
  ] },
];

let dir: string;
let db: DatabaseSync;
let open: GameActContext;
let tool: Tool;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-tool-"));
  db = openDomusDb(dir);
  seq = 0;
  open = { db, nowMs: () => T0, attachedSession: () => HELPER, lastAttachedMs: () => T0 };
  tool = gameActTool(() => open);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Admits a view of the test thread with the given options (an invented view). */
function view(options: OptionObject[] | undefined, sourceTimeMs = T0 - 1000): string {
  seq += 1;
  const observationId = `helper-1.${seq}`;
  admitObservation(db, {
    observationId,
    digest: `digest-${observationId}`,
    thread: THREAD,
    world: "slot3",
    branch: "branch-1",
    session: "telemetry-1",
    attachment: HELPER,
    body: "sim-9",
    snapshot: "7",
    seq,
    sourceTimeMs,
    expiresAtMs: sourceTimeMs + 30_000,
    receiptTimeMs: T0,
    lineageClass: "LIVE",
    payloadJson: JSON.stringify({ percepts: [], ...(options ? { options } : {}) }),
  });
  return observationId;
}

let turn = 0;
function run(args: Record<string, unknown>, thread = THREAD, turnId?: string): Promise<Receipt> {
  turn += 1;
  return tool.run(args, { thread, turnId: turnId ?? `turn-${turn}`, nowMs: T0 } as ToolContext);
}

function acts(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM acts").all() as Array<Record<string, unknown>>;
}

describe("game_act: where it works", () => {
  it("works from any thread: it chooses from the game's newest view, and the act is kept for the thread that asked", async () => {
    view(VIEW);
    expect(await run({ option: "a1" }, "discord:dm:owner")).toMatchObject({ ok: true });
    expect(acts()).toEqual([expect.objectContaining({ thread: "discord:dm:owner", observation_id: "helper-1.1", option_ref: "a1" })]);
  });

  it("finds the game's thread from the attached session, and from the newest view when that session has sent none", async () => {
    view(VIEW);
    open = { db, nowMs: () => T0, attachedSession: () => "helper-2", lastAttachedMs: () => T0 };
    expect(await run({ option: "a1" }, "cli:summoner")).toMatchObject({ ok: false, refused: { code: "view_from_earlier_session" } });
  });

  it("is refused while the world is not running", async () => {
    view(VIEW);
    open = null;
    expect(await run({ option: "a1" })).toMatchObject({ ok: false, refused: { code: "not_running" } });
  });

  it("is refused while the game has shown no view of its thread", async () => {
    expect(await run({ option: "a1" })).toMatchObject({ ok: false, refused: { code: "no_view" } });
  });
});

describe("game_act: a view from an earlier helper session", () => {
  it("refuses a choice from a view the game sent before it restarted, and requests nothing", async () => {
    view(VIEW);
    open = { db, nowMs: () => T0, attachedSession: () => "helper-2", lastAttachedMs: () => T0 };
    const receipt = await run({ option: "a1" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "view_from_earlier_session" } });
    expect(receipt.refused?.reason).toContain("The game restarted since that view, and its new view has not arrived yet.");
    expect(acts()).toEqual([]);
  });

  it("requests the choice when the attached session is the one that sent the view", async () => {
    view(VIEW);
    expect(await run({ option: "a1" })).toMatchObject({ ok: true });
    expect(acts()).toHaveLength(1);
  });
});

describe("game_act: refs", () => {
  it("resolves a ref against the newest view only, and refuses an unknown one with the refs that exist", async () => {
    view(VIEW);
    const receipt = await run({ option: "a9" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
    expect(receipt.refused?.reason).toContain("The refs you can name now are: a1, a2, a3, a4.");
    expect(acts()).toEqual([]);
  });

  it("does not look at an older view that offered a ref the newest one does not", async () => {
    view([{ object: "Old thing", object_id: "obj-old", acts: [{ ref: "a7", guid64: "700", text: "Old act" }] }]);
    view(VIEW);
    expect(await run({ option: "a7" })).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
  });

  it("skips a view that was undone, and resolves against the view before it", async () => {
    view([{ object: "Old thing", object_id: "obj-old", acts: [{ ref: "a7", guid64: "700", text: "Old act" }] }], T0 - 5000);
    view(VIEW, T0 - 1000);
    markSpanUndone(db, { thread: THREAD, world: "slot3", branch: "branch-1", session: "telemetry-1", afterSourceTimeMs: T0 - 2000, reason: "HELPER_UNDO" }, T0);
    const receipt = await run({ option: "a7" });
    expect(receipt).toMatchObject({ ok: true, data: { option: "a7", label: "Old act (Old thing)" } });
  });

  it("says the newest view offers no choices when it has none", async () => {
    view(undefined);
    const receipt = await run({ option: "a1" });
    expect(receipt.refused?.reason).toContain("The newest view of this game offers no choices.");
  });
});

describe("game_act: requests", () => {
  it("requests the chosen act, says requested rather than done, and keeps the plan's steps in order", async () => {
    view(VIEW);
    const receipt = await run({ option: "a1", then: ["a3"] });
    expect(receipt.ok).toBe(true);
    expect(receipt.summary.startsWith("Requested: Boil water (Test kettle) (a1).")).toBe(true);
    expect(receipt.summary).toContain("Then, each after the one before completes: a3 (Sit down (Test bench)).");
    expect(receipt.summary).not.toMatch(/^Done/);
    expect(receipt.data).toMatchObject({ option: "a1", label: "Boil water (Test kettle)", forSummoner: false, then: ["a3"] });
    const rows = acts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ thread: THREAD, attachment: HELPER, option_ref: "a1", object_id: "obj-kettle", guid64: "111", state: "requested" });
    expect(db.prepare("SELECT step, option_ref, state FROM plan_steps").all()).toEqual([{ step: 1, option_ref: "a3", state: "planned" }]);
  });

  it("marks the act for the summoner when asked to", async () => {
    view(VIEW);
    const receipt = await run({ option: "a2", for_summoner: true });
    expect(receipt.data).toMatchObject({ forSummoner: true });
    expect(acts()[0]).toMatchObject({ for_summoner: 1 });
  });

  it("refuses at once with not_attached when the game is not attached, queues nothing, and says when it was last attached", async () => {
    view(VIEW);
    open = { db, nowMs: () => T0, attachedSession: () => undefined, lastAttachedMs: () => T0 - 120_000 };
    const receipt = await run({ option: "a1" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect(receipt.refused?.reason).toContain(`It was last attached at ${new Date(T0 - 120_000).toISOString()}.`);
    expect(acts()).toEqual([]);
  });

  it("says it has never been attached when no attachment was ever seen", async () => {
    view(VIEW);
    open = { db, nowMs: () => T0, attachedSession: () => undefined, lastAttachedMs: () => undefined };
    const receipt = await run({ option: "a1" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect(receipt.refused?.reason).toContain("It has not been attached since this world started.");
    expect(acts()).toEqual([]);
  });

  it("refuses a plan with an unknown step, and requests nothing", async () => {
    view(VIEW);
    const receipt = await run({ option: "a1", then: ["a9"] });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
    expect(acts()).toEqual([]);
  });

  it("allows at most two steps after the first", async () => {
    view(VIEW);
    expect(await run({ option: "a1", then: ["a2", "a3", "a4"] })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(acts()).toEqual([]);
  });

  it("refuses a second choice in the same turn", async () => {
    view(VIEW);
    expect((await run({ option: "a1" }, THREAD, "one-turn")).ok).toBe(true);
    expect(await run({ option: "a2" }, THREAD, "one-turn")).toMatchObject({ ok: false, refused: { code: "one_act_per_turn" } });
    expect(acts()).toHaveLength(1);
  });

  it("refuses arguments it does not know, and malformed ones, before anything is requested", async () => {
    view(VIEW);
    expect(await run({ option: "a1", extra: true })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a 1" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({})).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", for_summoner: "yes" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", answer: {} })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(acts()).toEqual([]);
  });

  it("refuses an answer given to something that is not a game question, and says why", async () => {
    view(VIEW);
    const receipt = await run({ option: "a1", answer: { rows: [{ option: "a1" }] } });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "not_a_dialog" } });
    expect(acts()).toEqual([]);
  });
});

describe("game_act: the words she read still name the ref", () => {
  it("requests the act when the ref names the words she read, in any case and with spaces around them", async () => {
    view(VIEW);
    expect(await run({ option: "a1", expect: "  boil WATER " })).toMatchObject({ ok: true });
    expect(acts()).toHaveLength(1);
  });

  it("refuses with ref_changed when the ref now names something else, says what it names, and requests nothing", async () => {
    view(VIEW);
    const receipt = await run({ option: "a1", expect: "Tidy up" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "ref_changed" } });
    expect(receipt.refused?.reason).toContain("a1 now names: Boil water (Test kettle).");
    expect(receipt.refused?.reason).toContain('You expected "Tidy up".');
    expect(acts()).toEqual([]);
  });

  it("checks each then ref against expect_then, by its place in the list, and names the then ref that changed", async () => {
    view(VIEW);
    const receipt = await run({ option: "a1", then: ["a3", "a4"], expect_then: ["sit down", "Sit"] });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "ref_changed" } });
    expect(receipt.refused?.reason).toContain("a4 (in then) now names: Stand up (Test bench).");
    expect(acts()).toEqual([]);
  });

  it("checks only the then refs that expect_then names when it is shorter", async () => {
    view(VIEW);
    expect(await run({ option: "a1", then: ["a3", "a4"], expect_then: ["sit down"] })).toMatchObject({ ok: true });
  });

  it("refuses a malformed expect or expect_then as bad_args", async () => {
    view(VIEW);
    expect(await run({ option: "a1", expect: 5 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", expect: "x".repeat(201) })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", then: ["a3"], expect_then: "Sit" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", then: ["a3"], expect_then: ["x".repeat(201)] })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await run({ option: "a1", then: ["a3"], expect_then: ["a", "b", "c"] })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(acts()).toEqual([]);
  });

  it("describes expect and expect_then in the tool's parameters", () => {
    const properties = tool.spec.parameters.properties as Record<string, { description?: string }>;
    expect(properties["expect"]?.description).toContain("as you read them");
    expect(properties["expect_then"]?.description).toContain("then");
  });
});
