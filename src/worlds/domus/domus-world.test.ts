import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext, WorldEvent } from "../../contracts.js";
import { writeStop } from "../../entity/stop.js";
import { openShelf, shelfBody, type Shelf } from "../../media/shelf.js";
import { createDomusWorld, type DomusWorld, LIVING_IT } from "./domus-world.js";
import { MIN_TOKEN_BYTES } from "./wire.js";

const T0 = 1_800_000_000_000;
/** Fixture secrets, built from parts at runtime so no token-shaped literal sits in the repo. */
const TOKEN = ["domus", "helper", "fixture", "token", "a".repeat(MIN_TOKEN_BYTES)].join("-");
const BOT = ["bot", "fixture", "token", "b".repeat(40)].join("-");

const VIEW = [
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
let clock: number;
let events: WorldEvent[];
let world: DomusWorld | undefined;
let seq: number;
let shelf: Shelf;

function make(token = TOKEN, others: string[] = [BOT]): DomusWorld {
  return createDomusWorld({ dir, token, host: "127.0.0.1", port: 0, nowMs: () => clock, otherTokens: others });
}

async function startWorld(): Promise<DomusWorld> {
  const next = make();
  shelf = openShelf(join(dir, "media"));
  // The privacy check is empty here (the body's default holds every outward text); the privacy hold has its own tests.
  await next.start((event) => events.push(event), shelfBody(shelf, () => clock, () => undefined));
  world = next;
  return next;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "domus-world-"));
  clock = T0;
  events = [];
  seq = 0;
  await startWorld();
});

afterEach(async () => {
  await world?.stop();
  world = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function base(): string {
  const address = world?.listeningAddress();
  if (!address) throw new Error("the listener is not up");
  return `http://127.0.0.1:${address.port}`;
}

type Reply = { status: number; body: Record<string, unknown> };

async function call(path: string, body: unknown, options: { token?: string | null; raw?: string; contentType?: string; method?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": options.contentType ?? "application/json" };
  if (options.token !== null) headers["X-Domus-Token"] = options.token ?? TOKEN;
  const response = await fetch(`${base()}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** An invented game view the helper would send. Source time is the test's clock, a second earlier. */
function viewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    v: 1,
    observation_id: `helper-1.${seq}`,
    world: "slot3",
    branch: "branch-1",
    session: "telemetry-1",
    attachment: "helper-1",
    body: "sim-9",
    snapshot: "7",
    seq,
    source_time_ms: clock - 1000,
    expires_at_ms: clock + 30_000,
    lineage_class: "LIVE",
    percepts: [{ kind: "presence", salience: 0.8, facts: { bucket: "arrived", name: "Pim Dorrow" } }],
    options: VIEW,
    ...overrides,
  };
}

function tool(name: string): Tool {
  const found = world?.tools().find((item) => item.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function gameAct(args: Record<string, unknown>, turnId: string): Promise<Receipt> {
  return tool("game_act").run(args, { thread: "domus:slot3", turnId, nowMs: clock } as ToolContext);
}

describe("forget", () => {
  it("erases the words from the game store while the world runs, so the newest view offers no choices", async () => {
    await attach();
    await call("/domus/observation", viewBody({ observation_id: "helper-1.f1", seq: 600 }));
    expect((await gameAct({ option: "a1" }, "t-before")).ok).toBe(true);
    expect(world!.forget(["PIM", "dorrow"])).toBe(1);
    expect(world!.forget(["pim"])).toBe(0);
    expect(await gameAct({ option: "a1" }, "t-after")).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
  });

  it("erases the words from the game store file when the world is not running", async () => {
    await call("/domus/observation", viewBody({ observation_id: "helper-1.f2", seq: 601 }));
    await world!.stop();
    world = undefined;
    expect(make().forget(["dorrow"])).toBe(1);
  });
});

describe("what the world says of itself", () => {
  it("says the Sim in the game is her, and that she talks about it as her own life, verbatim", () => {
    const about = make().about?.() ?? "";
    expect(about).toContain(
      "In the game, the Sim is you: your body, your house, your life. Talk about it the way a person talks about their own life: " +
        "what you feel, what you want, what you are about to do. Clock times, refs, need words and object names are for choosing " +
        "your acts. Leave them out of what you say unless someone asks for them.",
    );
  });
});

describe("start and the token", () => {
  it("refuses a missing, short, or other-token-equal helper token, and listens for nothing", async () => {
    await world?.stop();
    world = undefined;
    const missing = make("   ");
    await expect(missing.start(() => undefined)).rejects.toThrow(/missing/);
    expect(missing.listeningAddress()).toBeNull();
    await expect(make("short-token").start(() => undefined)).rejects.toThrow(/at least 32 bytes/);
    await expect(make(TOKEN, [TOKEN]).start(() => undefined)).rejects.toThrow(/equals another token/);
    expect(make(TOKEN, [TOKEN]).listeningAddress()).toBeNull();
  });

  it("refuses a second start of the same world", async () => {
    await expect(world!.start(() => undefined)).rejects.toThrow(/already started/);
  });
});

describe("auth", () => {
  it("answers 401 unauthorized without a token, with a wrong one, and with the bot's token", async () => {
    expect(await call("/domus/feed", { v: 1, helper_session: "h" }, { token: null })).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await call("/domus/feed", { v: 1, helper_session: "h" }, { token: "x".repeat(40) })).toMatchObject({ status: 401 });
    expect(await call("/domus/feed", { v: 1, helper_session: "h" }, { token: BOT })).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("answers 404 not_found for another path or method, and 401 for any path without the token", async () => {
    expect(await call("/domus/nope", { v: 1 })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("/domus/feed", undefined, { method: "GET" })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("/domus/nope", { v: 1 }, { token: null })).toMatchObject({ status: 401 });
  });
});

describe("observations", () => {
  it("starts the view with her body now, from the portrait the helper sent with it", async () => {
    await attach();
    await call("/domus/observation", viewBody({ portrait: { zone: { room_label: "Test kitchen" }, paused: true, mood: "Flirty" } }));
    expect(events).toHaveLength(1);
    expect(events[0]?.text?.startsWith("Your body now:\nYour attention: every change.\nThe game is attached.\nThe game is paused.\nRoom: Test kitchen.\nMood: flirty.\n\nThe game (slot3) shows:\n")).toBe(true);
  });

  it("gives the full view her You section, and an older view's brief none of it", async () => {
    await attach();
    await call("/domus/observation", viewBody({ portrait: { self: { traits: ["Cheerful"] } } }));
    await call("/domus/observation", viewBody({ portrait: { self: { traits: ["Cheerful"], funds: 40 } } }));
    expect(events[0]?.text).toContain("You are Cheerful.");
    expect(events[1]?.text).toContain("Money: §40.");
    expect(events[0]?.brief).not.toContain("You are");
    expect(events[1]?.brief).not.toContain("Money:");
  });

  it("says in the first view that the game's choices are still coming, when the helper has sent none yet", async () => {
    const body = viewBody({ choices_pending: true });
    delete body.options;
    const reply = await call("/domus/observation", body);
    expect(reply.status).toBe(202);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("The game has not sent its choices yet. They come with a later view.");
    expect(events[0]?.text).not.toContain("Choices you can name");
  });

  it("admits a new view with 202, and emits one outside event on the game thread with its refs", async () => {
    const reply = await call("/domus/observation", viewBody());
    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ status: "admitted", observation_id: "helper-1.1", receipt_time_ms: T0 });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ world: "domus", place: "domus:slot3", thread: "domus:slot3", actor: "game", source: "outside", wake: true, atMs: T0 - 1000 });
    expect(event?.text).toContain("The game (slot3) shows:");
    expect(event?.text).toContain("- Pim Dorrow arrived.");
    expect(event?.text).toContain("- Test kettle (here, 2.0 m): a1 Boil water; a2 Tidy up");
    expect(event?.data).toMatchObject({ observationId: "helper-1.1", world: "slot3", options: VIEW });
  });

  it("shows the game's record of her day in the full view after her body, and says in the brief that it came", async () => {
    await attach();
    const day = { v: 1, from_minute: 0, to_minute: 1440, frames: [{ day: 3, acts: 1, slept: ["23:10:00.000 day:2 week:0"], woke: [], company: [], body_on_its_own: {} }], acts: [], also: {}, omitted: 0 };
    await call("/domus/observation", viewBody({ percepts: [{ kind: "sleep_onset", salience: 1, facts: {} }], day }));
    expect(events[0]?.text).toContain("Your body now:");
    expect(events[0]?.text).toContain("\n\nThe game's record of your day (facts only):\n- Day 3: slept 23:10.\n\nThe game (slot3) shows:\n");
    expect(events[0]?.wake).toBe(true);
    await call("/domus/observation", viewBody());
    expect(events[1]?.brief).toBe("- Pim Dorrow arrived.");
    expect(events[0]?.brief).toBe("- You fell asleep.\n- The game's record of your day came with this view.");
  });

  it("names every view one domus view, with a brief of its percept lines only, so an older view shrinks in her turn", async () => {
    await attach();
    await call("/domus/observation", viewBody({ portrait: { zone: { room_label: "Test kitchen" } } }));
    const [event] = events;
    expect(event).toMatchObject({ view: "domus", brief: "- Pim Dorrow arrived." });
    expect(event?.brief).not.toContain("Your body now");
    expect(event?.brief).not.toContain("Choices");
    expect(event?.text).toContain("Your body now:");
  });

  it("answers the same id and digest 200 duplicate with the first receipt time, and emits nothing again", async () => {
    const body = viewBody();
    await call("/domus/observation", body);
    clock = T0 + 500;
    const again = await call("/domus/observation", body);
    expect(again).toEqual({ status: 200, body: { status: "duplicate", observation_id: "helper-1.1", receipt_time_ms: T0 } });
    expect(events).toHaveLength(1);
  });

  it("answers the same id with another digest 409 observation_conflict", async () => {
    await call("/domus/observation", viewBody());
    const changed = await call("/domus/observation", viewBody({ observation_id: "helper-1.1", seq: 9, source_time_ms: clock - 900 }));
    expect(changed).toEqual({ status: 409, body: { error: "observation_conflict" } });
  });

  it("refuses an expired view 410, a view from the future 400 clock_skew, and a malformed one 400 invalid_body", async () => {
    clock = T0 + 40_000;
    expect(await call("/domus/observation", viewBody({ source_time_ms: T0 - 1000, expires_at_ms: T0 + 1000 }))).toEqual({ status: 410, body: { error: "expired" } });
    clock = T0;
    expect(await call("/domus/observation", viewBody({ source_time_ms: T0 + 200_000, expires_at_ms: T0 + 230_000 }))).toEqual({
      status: 400, body: { error: "clock_skew" },
    });
    expect(await call("/domus/observation", viewBody({ stray: true }))).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(events).toEqual([]);
  });

  it("refuses a body over 64 KiB with 413, a body not sent as JSON, and a body that does not parse", async () => {
    const huge = JSON.stringify({ ...viewBody(), pad: "x".repeat(70 * 1024) });
    expect(await call("/domus/observation", undefined, { raw: huge })).toEqual({ status: 413, body: { error: "payload_too_large" } });
    expect(await call("/domus/observation", undefined, { raw: JSON.stringify(viewBody()), contentType: "text/plain" }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await call("/domus/observation", undefined, { raw: "{ not json" })).toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("keeps dedup across a restart: the same view is still a duplicate", async () => {
    const body = viewBody();
    await call("/domus/observation", body);
    await world?.stop();
    world = undefined;
    await startWorld();
    clock = T0 + 100;
    expect(await call("/domus/observation", body)).toEqual({ status: 200, body: { status: "duplicate", observation_id: "helper-1.1", receipt_time_ms: T0 } });
  });
});

describe("heartbeats", () => {
  it("is attached while the latest heartbeat says so and is recent, and says since when it is not", async () => {
    expect(world?.now()).toBe("Domus: the game is not attached; no helper has reported yet.");
    const heartbeat = { v: 1, helper_session: "helper-1", sent_at_ms: T0, attached: true };
    expect(await call("/domus/heartbeat", heartbeat)).toEqual({ status: 200, body: { status: "ok" } });
    expect(world?.now()).toBe("Domus: the game is attached.");
    clock = T0 + 181_000;
    expect(world?.now()).toBe(`Domus: the game is not attached since ${new Date(T0).toISOString()}.`);
    await call("/domus/heartbeat", { ...heartbeat, sent_at_ms: clock, attached: false });
    expect(world?.now()).toBe(`Domus: the game is not attached since ${new Date(clock).toISOString()}.`);
  });

  it("refuses a heartbeat with an unknown key or a non-boolean attached as 400", async () => {
    expect(await call("/domus/heartbeat", { v: 1, helper_session: "h", sent_at_ms: T0, attached: "yes" })).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await call("/domus/heartbeat", { v: 1, helper_session: "h", sent_at_ms: T0, attached: true, extra: 1 })).toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});

describe("acts: the Lar asks, the helper pulls, the game reports", () => {
  beforeEach(async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events = [];
  });

  it("takes an act asked from another thread: the game gets it, and its reports come to the thread that asked", async () => {
    const receipt = await tool("game_act").run({ option: "a1" }, { thread: "discord:dm:owner", turnId: "t-discord", nowMs: clock } as ToolContext);
    expect(receipt).toMatchObject({ ok: true });
    const sync = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    const actId = (sync.body.acts as Array<{ act_id: string }>)[0]?.act_id;
    await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [{ act_id: actId, phase: "received", at_ms: T0 + 10 }] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "discord:dm:owner", thread: "discord:dm:owner", source: "body", wake: false });
    expect(events[0]?.text).toContain('Your act "Boil water (Test kettle)" (a1): your helper took it up');
  });

  it("serves a requested act to its own helper in the wire's shape, then keeps the report as a note", async () => {
    const receipt = await gameAct({ option: "a1" }, "t-1");
    expect(receipt.ok).toBe(true);
    const sync = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ status: "ok", applied: 0, planned: 0, snapshots: [] });
    const acts = sync.body.acts as Array<Record<string, unknown>>;
    expect(acts).toEqual([{ act_id: (receipt.data as { actId: string }).actId, object_id: "obj-kettle", guid64: "111", expires_at_ms: T0 + 90_000 }]);
    const actId = acts[0]?.act_id;
    expect(await call("/domus/acts/sync", { v: 1, helper_session: "helper-2", events: [] })).toMatchObject({ body: { acts: [] } });
    // Another session's sync holds the pulled act as unknown, as a guess (SESSION_ENDED): helper-1's report still settles it.
    expect(events.map((event) => event.text)).toEqual([expect.stringContaining("how it ended is not known (SESSION_ENDED)")]);
    events = [];
    const reported = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [
      { act_id: actId, phase: "received", at_ms: T0 + 10 },
    ] });
    expect(reported.body).toMatchObject({ applied: 1, acts: [] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "domus:slot3", source: "body", wake: false });
    expect(events[0]?.text).toContain('Your act "Boil water (Test kettle)" (a1): your helper took it up');
  });

  it("wakes the thread for a refusal, and says the game is cut short when it is", async () => {
    const receipt = await gameAct({ option: "a2" }, "t-2");
    const actId = (receipt.data as { actId: string }).actId;
    await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [{ act_id: actId, phase: "rejected", at_ms: T0, detail: { code: "NOT_ATTACHED", by: "game" } }] });
    expect(events[0]).toMatchObject({ wake: true });
    expect(events[0]?.text).toContain("the game refused it (NOT_ATTACHED)");
  });

  it("wakes the thread when the game finishes an act, and the note says it finished", async () => {
    const receipt = await gameAct({ option: "a2" }, "t-2b");
    const actId = (receipt.data as { actId: string }).actId;
    await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [
      { act_id: actId, phase: "finished", at_ms: T0 + 1, detail: { finishing_type: "NATURAL", started: true } },
    ] });
    expect(events.at(-1)).toMatchObject({ wake: true, source: "body" });
    expect(events.at(-1)?.text).toContain("it finished");
  });

  it("runs a plan: the next step is served only after the one before it finished", async () => {
    const receipt = await gameAct({ option: "a1", then: ["a3"] }, "t-3");
    const actId = (receipt.data as { actId: string }).actId;
    await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [
      { act_id: actId, phase: "finished", at_ms: T0 + 5, detail: { finishing_type: "NATURAL", started: true } },
    ] });
    const next = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    expect((next.body.acts as Array<Record<string, unknown>>).map((act) => act.object_id)).toEqual(["obj-bench"]);
  });

  it("expires an act nobody picked up after 90 s, with a note that wakes the thread", async () => {
    await gameAct({ option: "a1" }, "t-4");
    clock = T0 + 90_000;
    const sync = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    expect(sync.body.acts).toEqual([]);
    expect(events.at(-1)).toMatchObject({ wake: true, source: "body" });
    expect(events.at(-1)?.text).toContain("it expired before the game picked it up");
  });

  it("withdraws a waiting act and its plan when the summoner's stop goes on after the request", async () => {
    await attach();
    await gameAct({ option: "a1", then: ["a3"] }, "t-5");
    writeStop(dir, "test");
    const sync = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    expect(sync.body).toMatchObject({ acts: [], planned: 0 });
    const texts = events.map((event) => event.text);
    expect(texts.some((text) => text.includes("withdrawn before the game picked it up, because your summoner's stop is on"))).toBe(true);
    expect(texts.some((text) => text.includes("your summoner's stop is on. It was not requested"))).toBe(true);
  });

  it("refuses an unknown phase, and a report with a detail over 1024 bytes, as invalid_body", async () => {
    expect(await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [{ act_id: "a1", phase: "requested", at_ms: T0 }] }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [{ act_id: "a1", phase: "received", at_ms: T0, detail: { x: "y".repeat(1100) } }] }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});

describe("snapshot, feed and undo", () => {
  it("answers a well-formed snapshot 404 unknown_snapshot (no picture was asked for), and checks its shape first", async () => {
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: "snap-1", failed: "no_game_window" }))
      .toEqual({ status: 404, body: { error: "unknown_snapshot" } });
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: "snap-1" })).toEqual({ status: 400, body: { error: "invalid_body" } });
    const big = { v: 1, helper_session: "helper-1", snapshot_id: "snap-1", png_base64: "A".repeat(70 * 1024) };
    expect(await call("/domus/snapshot", big)).toEqual({ status: 404, body: { error: "unknown_snapshot" } });
  });

  it("answers the feed with an empty list and no marks, and refuses an extra key", async () => {
    expect(await call("/domus/feed", { v: 1, helper_session: "helper-1" })).toEqual({ status: 200, body: { status: "ok", items: [], marks: [] } });
    expect(await call("/domus/feed", { v: 1, helper_session: "helper-1", extra: 1 })).toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("undoes the views after the time, writes one body row saying the game went back, and drops the undone view from the choices", async () => {
    await attach();
    const ghost = [{ object: "Ghost", object_id: "obj-ghost", acts: [{ ref: "a8", guid64: "808", text: "Haunt" }] }];
    // The view before the undone one, which stands after the undo.
    await call("/domus/observation", viewBody({ observation_id: "helper-1.before", seq: 499, source_time_ms: clock - 1000 }));
    await call("/domus/observation", viewBody({ observation_id: "helper-1.undo", seq: 500, source_time_ms: clock - 500, options: ghost }));
    expect((await gameAct({ option: "a8" }, "t-ghost")).ok).toBe(true);
    events = [];
    const undo = await call("/domus/undo", { v: 1, world: "slot3", branch: "branch-1", session: "telemetry-1", after_source_time_ms: T0 - 800, reason: "HELPER_UNDO" });
    expect(undo).toEqual({ status: 200, body: { status: "ok", observations: 1, supports: 0, assertions: 0, episodes: 0, journal: 0 } });
    // The body row first; then the requested act chosen on the undone view is withdrawn too (see the next test).
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ place: "domus:slot3", source: "body", wake: false });
    expect(events[0]?.text).toContain(`The game went back to ${new Date(T0 - 800).toISOString()}.`);
    expect(events[0]?.text).toContain("did not happen");
    // The undone view's choices are gone; the view before it (still standing) is what the refs resolve against.
    expect(await gameAct({ option: "a8" }, "t-undo")).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
    expect(await gameAct({ option: "a1" }, "t-undo-2")).toMatchObject({ ok: true, data: { label: "Boil water (Test kettle)" } });
  });

  it("withdraws the requested act and the waiting plan steps chosen on the undone view, with notes that do not wake", async () => {
    await attach();
    const ghost = [{ object: "Ghost", object_id: "obj-ghost", acts: [
      { ref: "a8", guid64: "808", text: "Haunt" },
      { ref: "a9", guid64: "909", text: "Vanish" },
    ] }];
    await call("/domus/observation", viewBody({ observation_id: "helper-1.undo", seq: 500, source_time_ms: clock - 500, options: ghost }));
    expect((await gameAct({ option: "a8", then: ["a9"] }, "t-plan")).ok).toBe(true);
    events = [];
    const undo = await call("/domus/undo", { v: 1, world: "slot3", branch: "branch-1", session: "telemetry-1", after_source_time_ms: T0 - 800, reason: "HELPER_UNDO" });
    expect(undo.status).toBe(200);
    expect(events.map((event) => [event.source, event.wake])).toEqual([["body", false], ["body", false], ["body", false]]);
    expect(events[1]?.text).toBe('Your act "Haunt (Ghost)" (a8): it was withdrawn, because the game went back before the view you chose it from.');
    expect(events[2]?.text).toContain('Your plan stopped before "Vanish (Ghost)": the game went back before the view it was chosen from.');
    // The game takes nothing it was asked before the undo: no act and no planned step is handed to the helper.
    expect(await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] })).toMatchObject({ status: 200, body: { acts: [], planned: 0 } });
  });

  it("refuses an undo time outside the JavaScript Date range as invalid_body, and the listener stays up", async () => {
    expect(await call("/domus/undo", { v: 1, world: "slot3", branch: "b", session: "s", after_source_time_ms: 9e15, reason: "HELPER_UNDO" }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await call("/domus/feed", { v: 1, helper_session: "helper-1" })).toEqual({ status: 200, body: { status: "ok", items: [], marks: [] } });
  });

  it("refuses an undo with a bad reason or an unknown key as invalid_body", async () => {
    expect(await call("/domus/undo", { v: 1, world: "slot3", branch: "b", session: "s", after_source_time_ms: T0, reason: "lower" }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});

// A picture of the game for the snapshot tests: a PNG signature and a few more bytes.
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");

function snapshotTool(): Tool {
  const found = world?.tools().find((item) => item.spec.name === "game_snapshot");
  if (!found) throw new Error("no tool game_snapshot");
  return found;
}

function askForPicture(thread = "domus:slot3"): Promise<Receipt> {
  return snapshotTool().run({}, { thread, turnId: "t-snap", nowMs: clock } as ToolContext);
}

async function attach(session = "helper-1"): Promise<void> {
  await call("/domus/heartbeat", { v: 1, helper_session: session, sent_at_ms: clock, attached: true });
}

/** The snapshot id the helper is told to take, from its sync. */
async function pendingSnapshotId(session = "helper-1"): Promise<string> {
  const sync = await call("/domus/acts/sync", { v: 1, helper_session: session, events: [] });
  const found = sync.body.snapshots as Array<{ snapshot_id: string }>;
  return found[0]?.snapshot_id ?? "";
}

describe("game pictures: the Lar asks, the helper takes, the shelf keeps", () => {
  it("refuses a picture while the game is not attached, and lets one open request at a time", async () => {
    expect(await askForPicture()).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    await attach();
    const asked = await askForPicture();
    expect(asked).toMatchObject({ ok: true, data: { expiresAtMs: clock + 600_000 } });
    clock += 30_000;
    expect(await askForPicture()).toMatchObject({ ok: false, refused: { code: "one_open" } });
    expect((await askForPicture()).refused?.reason).toContain("30 s ago");
    expect(await askForPicture("domus:other")).toMatchObject({ ok: true });
  });

  it("takes a request from any thread, and the picture comes to the thread that asked", async () => {
    await attach();
    expect(await askForPicture("cli:summoner")).toMatchObject({ ok: true });
    const id = await pendingSnapshotId();
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: id, failed: "game_minimized" }))
      .toEqual({ status: 200, body: { status: "ok" } });
    expect(events.at(-1)).toMatchObject({ thread: "cli:summoner", wake: true });
  });

  it("lists the request in the next sync, keeps the picture the helper sends, and wakes the thread", async () => {
    await attach();
    await askForPicture();
    const snapshotId = await pendingSnapshotId();
    expect(snapshotId).not.toBe("");

    const posted = await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: snapshotId, png_base64: PNG_BASE64 });
    expect(posted).toEqual({ status: 200, body: { status: "ok" } });
    const [picture] = shelf.list();
    expect(picture).toMatchObject({ mime: "image/png", bytes: 11, name: "game.png", from: { world: "domus", place: "domus:slot3" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "domus:slot3", source: "body", wake: true });
    expect(events[0]?.text).toBe(`Your picture of the game is on your shelf as ${picture?.id}.`);

    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: snapshotId, png_base64: PNG_BASE64 }))
      .toEqual({ status: 409, body: { error: "not_requested" } });
    expect(await pendingSnapshotId()).toBe("");
    expect(await askForPicture()).toMatchObject({ ok: true });
  });

  it("refuses a picture from the wrong session without using the request, and a file that is not a PNG", async () => {
    await attach();
    await askForPicture();
    const snapshotId = await pendingSnapshotId();
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-2", snapshot_id: snapshotId, png_base64: PNG_BASE64 }))
      .toEqual({ status: 409, body: { error: "wrong_attachment" } });
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: snapshotId, png_base64: Buffer.from("<html>").toString("base64") }))
      .toEqual({ status: 400, body: { error: "not_png" } });
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: "snap-unknown", png_base64: PNG_BASE64 }))
      .toEqual({ status: 404, body: { error: "unknown_snapshot" } });
    expect(shelf.list()).toEqual([]);
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: snapshotId, png_base64: PNG_BASE64 })).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("says why a picture could not be taken, and wakes the thread", async () => {
    await attach();
    await askForPicture();
    const snapshotId = await pendingSnapshotId();
    expect(await call("/domus/snapshot", { v: 1, helper_session: "helper-1", snapshot_id: snapshotId, failed: "game_minimized" }))
      .toEqual({ status: 200, body: { status: "ok" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "domus:slot3", wake: true });
    expect(events[0]?.text).toBe("Your picture of the game could not be taken: the game window was minimized.");
    expect(shelf.list()).toEqual([]);
  });

  it("expires a request nobody took within ten minutes, without waking the thread", async () => {
    await attach();
    await askForPicture();
    clock += 600_001;
    expect(await pendingSnapshotId()).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "domus:slot3", wake: false });
    expect(events[0]?.text).toBe("Your picture of the game was not taken within ten minutes, so the request expired.");
    await attach();
    expect(await askForPicture()).toMatchObject({ ok: true });
  });

  it("hands a waiting picture to the game while the summoner's stop is on: a picture is a read (Q-j)", async () => {
    await attach();
    await askForPicture();
    writeStop(dir, "test");
    expect(await pendingSnapshotId()).not.toBe("");
    expect(events).toEqual([]);
  });

  it("marks the game's read tools, and only those, as safe while the stop is on (Q-j)", () => {
    const safe = (world?.tools() ?? []).filter((item) => item.spec.safeWhenStopped === true).map((item) => item.spec.name).sort();
    expect(safe).toEqual(["game_catalog", "game_list", "game_look", "game_memory", "game_snapshot"]);
  });
});

describe("the world's surface", () => {
  it("offers one game tool, says what it is about, and refuses words", async () => {
    expect(world?.id).toBe("domus");
    expect(world?.tools().map((item) => item.spec.name)).toEqual([
      "game_act", "game_snapshot", "game_attention", "game_look", "game_overlay_say", "game_memory", "game_list", "game_catalog",
      "game_go", "game_save", "plan_event", "game_buy", "game_place", "game_move", "game_sell",
    ]);
    expect(world?.about?.()).toBe("The Sims 4 (Domus): your household's game, at domus:<world>, while your summoner's helper is attached. " + LIVING_IT);
    expect(await world?.say("domus:slot3", "hello")).toMatchObject({ ok: false, refused: { code: "no_words" } });
  });

  it("keeps a requested act and the helper's attachment across a restart", async () => {
    await call("/domus/heartbeat", { v: 1, helper_session: "helper-1", sent_at_ms: T0, attached: true });
    await call("/domus/observation", viewBody({ observation_id: "helper-1.restart", seq: 77 }));
    await gameAct({ option: "a1" }, "t-restart");
    await world?.stop();
    world = undefined;
    await startWorld();
    expect(world?.now()).toContain("the game is attached.");
    expect(world?.now()).toContain("1 requested act(s) wait for the game.");
    const sync = await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] });
    expect(sync.body.acts).toEqual([expect.objectContaining({ object_id: "obj-kettle" })]);
  });

  it("reports that nothing runs before it starts", () => {
    const idle = make();
    expect(idle.now()).toBe("Domus: not running.");
    expect(idle.listeningAddress()).toBeNull();
  });
});

describe("the game's attachment, in the views and on the game thread", () => {
  const heartbeat = (attached: boolean, sentAt: number) => ({
    v: 1, helper_session: "helper-1", sent_at_ms: sentAt, attached, world: "slot3",
  });

  it("starts a view with 'The game is attached.' while its helper is attached", async () => {
    await call("/domus/heartbeat", heartbeat(true, T0));
    await call("/domus/observation", viewBody());
    expect(events[0]?.text?.startsWith("Your body now:\nYour attention: every change.\nThe game is attached.\n\nThe game (slot3) shows:\n")).toBe(true);
  });

  it("says the game is not attached, and when it was last seen, in a view that arrives after the helper went quiet", async () => {
    await call("/domus/heartbeat", heartbeat(true, T0));
    clock = T0 + 240_000;
    await call("/domus/observation", viewBody());
    expect(events[0]?.text?.startsWith("Your body now:\nYour attention: every change.\nThe game is not attached (last seen 4 minutes ago).\n")).toBe(true);
  });

  it("tells the game thread once when the helper says the game is no longer attached, and again only after a new attach", async () => {
    await call("/domus/heartbeat", heartbeat(true, T0));
    clock = T0 + 1_000;
    await call("/domus/heartbeat", heartbeat(false, clock));
    clock = T0 + 2_000;
    await call("/domus/heartbeat", heartbeat(false, clock));
    const notices = events.filter((event) => event.text === "The game is no longer attached.");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ thread: "domus:slot3", place: "domus:slot3", wake: false, atMs: T0 + 1_000 });
    clock = T0 + 3_000;
    await call("/domus/heartbeat", heartbeat(true, clock));
    clock = T0 + 4_000;
    await call("/domus/heartbeat", heartbeat(false, clock));
    expect(events.filter((event) => event.text === "The game is no longer attached.")).toHaveLength(2);
  });

  it("tells the game thread when the helper goes quiet, found by the timed pass", async () => {
    await call("/domus/heartbeat", heartbeat(true, T0));
    clock = T0 + 300_000;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(events.filter((event) => event.text === "The game is no longer attached.")).toHaveLength(1);
  }, 15_000);
});

describe("views of a whole lot: the choices, and what the game left out", () => {
  it("says the choices are the same as in the last view when the next view on the thread offers the same ones", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    await call("/domus/observation", viewBody());
    expect(events).toHaveLength(2);
    expect(events[0]?.text).toContain("Choices you can name with game_act, by ref:");
    expect(events[1]?.text).toContain("Choices: the same as in the last view.");
    expect(events[1]?.text).not.toContain("Choices you can name");
  });

  it("lists the choices in full again when the choices changed, and says what the game left out", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    await call("/domus/observation", viewBody({
      options: [{ object: "Test rug", object_id: "obj-rug", acts: [{ ref: "a7", guid64: "777", text: "Sit" }] }],
      options_cut: { objects: 2, rooms: ["Test garden"] },
    }));
    expect(events[1]?.text).toContain("- Test rug: a7 Sit");
    expect(events[1]?.text?.endsWith("The game left out 2 more choice object(s) on the lot, in Test garden.")).toBe(true);
    expect(events[1]?.data).toMatchObject({ optionsCut: { objects: 2, rooms: ["Test garden"] } });
  });
});

describe("her attention: which views wake her, and the setting she keeps", () => {
  const ORDINARY = [{ kind: "need", salience: 0, facts: { subject: "hunger", band: "ok" } }];
  const CALL = [{ kind: "social", salience: 0, facts: { bucket: "addressed", by: "sim-2" } }];
  const HELD = { asked: [{ title: "Pick a recipe", whose: "hers", held: true }] };

  function setAttention(args: Record<string, unknown>, thread = "domus:slot3"): Promise<Receipt> {
    return tool("game_attention").run(args, { thread, turnId: "t-attention", nowMs: clock } as ToolContext);
  }

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  async function syncBody(): Promise<Record<string, unknown>> {
    return (await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] })).body;
  }

  it("wakes her on every view by default, and says every change at the top of the block", async () => {
    await attach();
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    expect(events[0]).toMatchObject({ wake: true, view: "domus" });
    expect(events[0]?.text?.startsWith("Your body now:\nYour attention: every change.\n")).toBe(true);
  });

  it("when called, keeps an ordinary change for her turn without waking her, and wakes her for a call", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events.length = 0;
    expect(await setAttention({ mode: "when_called" })).toMatchObject({ ok: true, summary: "Your attention is now: when something calls you." });
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    await call("/domus/observation", viewBody({ percepts: CALL }));
    expect(events.map((event) => event.wake)).toEqual([false, false, true]);
    expect(events[1]?.text).toContain("Your attention: when something calls you.");
    expect(events[1]?.brief).toBe("An earlier view.");
  });

  it("when quiet, wakes her for a question with a deadline and a window held for her, and for nothing else", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events.length = 0;
    await setAttention({ mode: "quiet", until: iso(clock + 3_600_000) });
    await call("/domus/observation", viewBody({ percepts: CALL }));
    await call("/domus/observation", viewBody({ percepts: ORDINARY, portrait: { asked: [{ title: "Pick", whose: "hers", held: false }] } }));
    await call("/domus/observation", viewBody({ percepts: ORDINARY, portrait: HELD }));
    await call("/domus/observation", viewBody({ percepts: [{ kind: "env", salience: 0, facts: { bucket: "asked", title_key: "pick" } }] }));
    expect(events.map((event) => event.wake)).toEqual([false, false, true, true]);
  });

  it("sets her attention on the game's thread from another thread, and says no view when the game has shown none", async () => {
    await attach();
    expect(await setAttention({ mode: "when_called" }, "discord:dm:owner")).toMatchObject({ ok: false, refused: { code: "no_view" } });
    await call("/domus/observation", viewBody());
    expect(await setAttention({ mode: "when_called" }, "discord:dm:owner")).toMatchObject({ ok: true });
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    expect(events.at(-1)).toMatchObject({ thread: "domus:slot3", wake: false });
  });

  it("keeps her setting across a restart of the world", async () => {
    await attach();
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    await setAttention({ mode: "when_called", look_every_minutes: 30 });
    await world?.stop();
    await startWorld();
    events.length = 0;
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    expect(events[0]).toMatchObject({ wake: false });
    expect(events[0]?.text?.startsWith("Your body now:\nYour attention: when something calls you, and a look every 30 minutes.\n")).toBe(true);
  });

  it("reverts a quiet to the mode before it once its time has passed", async () => {
    await attach();
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    await setAttention({ mode: "when_called" });
    await setAttention({ mode: "quiet", until: iso(clock + 3_600_000) });
    clock += 3_600_001;
    await attach();
    events.length = 0;
    await call("/domus/observation", viewBody({ percepts: ORDINARY }));
    expect(events[0]).toMatchObject({ wake: false });
    expect(events[0]?.text).toContain("Your attention: when something calls you.");
  });

  it("asks for a look after the gap while the game is attached, once, and not while it is not", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    await setAttention({ look_every_minutes: 5 });
    clock += 4 * 60_000;
    await attach();
    expect((await syncBody()).look).toBeUndefined();
    clock += 60_000;
    await attach();
    expect((await syncBody()).look).toBe(true);
    expect((await syncBody()).look).toBeUndefined();
  });

  it("owes no look while the game is not attached, and owes one once it is attached again after the gap", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    await setAttention({ look_every_minutes: 5 });
    clock += 10 * 60_000;
    expect((await syncBody()).look).toBeUndefined();
    await attach();
    expect((await syncBody()).look).toBe(true);
  });
});

describe("a fresh look: she asks, the helper answers on its sync, and the answer wakes her", () => {
  function look(thread = "domus:slot3"): Promise<Receipt> {
    return tool("game_look").run({}, { thread, turnId: "t-look", nowMs: clock } as ToolContext);
  }

  async function syncBody(): Promise<Record<string, unknown>> {
    return (await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [] })).body;
  }

  it("is refused with not_attached while the game is not attached, and nothing is owed", async () => {
    expect(await look()).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect((await syncBody()).look).toBeUndefined();
  });

  it("is handed to the helper once, on its next sync, as look: true", async () => {
    await attach();
    expect(await look()).toMatchObject({ ok: true });
    expect((await syncBody()).look).toBe(true);
    expect((await syncBody()).look).toBeUndefined();
  });

  it("is answered by a look view, which wakes her even when she is quiet", async () => {
    await attach();
    await tool("game_attention").run({ mode: "quiet", until: new Date(clock + 3_600_000).toISOString() }, {
      thread: "domus:slot3", turnId: "t-attention", nowMs: clock,
    } as ToolContext);
    await call("/domus/observation", viewBody({ percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }] }));
    expect(events[0]).toMatchObject({ wake: true, view: "domus" });
  });

  it("asked from another thread: the look view goes to the game's thread and to the thread that asked, and both wake", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events = [];
    expect(await look("discord:dm:owner")).toMatchObject({ ok: true });
    await call("/domus/observation", viewBody({ percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }] }));
    const onGame = events.filter((event) => event.thread === "domus:slot3");
    const onAsker = events.filter((event) => event.thread === "discord:dm:owner");
    expect(onGame).toHaveLength(1);
    expect(onAsker).toEqual([expect.objectContaining({ wake: true, view: "domus", actor: "game", source: "outside" })]);
    expect(onAsker[0]?.text).toContain("This is the look you asked for.");
    expect(onAsker[0]?.text).toContain("Choices you can name with game_act, by ref:");
  });

  it("asked from the game's own thread: the look view is heard once, on that thread", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events = [];
    await look("domus:slot3");
    await call("/domus/observation", viewBody({ percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }] }));
    expect(events.map((event) => event.thread)).toEqual(["domus:slot3"]);
  });

  it("a look that changed nothing answers in one line on her thread, and the choices she named still stand (D2)", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events = [];
    await look("domus:slot3");
    await call("/domus/observation", viewBody({ percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ wake: true, thread: "domus:slot3", source: "body" });
    expect(events[0]?.text).toMatch(/^Your look: no change in the game since your last view, and the choices are the same\./);
    expect(events[0]?.text).not.toContain("Choices you can name");
    expect((await gameAct({ option: "a1" }, "t-after-look")).ok).toBe(true);
  });

  it("a look that comes with a change in the game's feed is still the whole view", async () => {
    await attach();
    await call("/domus/observation", viewBody());
    events = [];
    await look("domus:slot3");
    await call("/domus/observation", viewBody({
      percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }, { kind: "presence", salience: 0.8, facts: { bucket: "arrived", name: "Pim Dorrow" } }],
    }));
    // The choices are the same as the last view's, so the whole view says so instead of listing them again; the look is named.
    expect(events[0]?.text).toContain("Your body now:");
    expect(events[0]?.text).toContain("This is the look you asked for.");
    expect(events[0]?.text).not.toMatch(/^Your look: no change/m);
  });
});

describe("the game overlay: her line reaches the helper's feed", () => {
  const sayOnOverlay = (args: Record<string, unknown>): Promise<Receipt> =>
    tool("game_overlay_say").run(args, { thread: "domus:slot3", turnId: "t-overlay", nowMs: clock } as ToolContext);

  it("answers the feed with her line, stamped chosen, and nothing after she clears it", async () => {
    expect(await call("/domus/feed", { v: 1, helper_session: "helper-1" })).toEqual({ status: 200, body: { status: "ok", items: [], marks: [] } });
    expect(await sayOnOverlay({ text: "Test line for the viewers." })).toMatchObject({ ok: true });
    const feed = await call("/domus/feed", { v: 1, helper_session: "helper-1" });
    expect(feed.body.items).toEqual([expect.objectContaining({ inputs: "chosen", at_ms: clock, line: "Test line for the viewers.", regime: {} })]);
    await sayOnOverlay({ clear: true });
    expect((await call("/domus/feed", { v: 1, helper_session: "helper-1" })).body.items).toEqual([]);
  });

  it("answers the feed with nothing while the summoner's stop is on, and refuses her new lines", async () => {
    await sayOnOverlay({ text: "Shown before the stop." });
    writeStop(dir, "test");
    expect((await call("/domus/feed", { v: 1, helper_session: "helper-1" })).body.items).toEqual([]);
    expect(await sayOnOverlay({ text: "Refused while stopped." })).toMatchObject({ ok: false, refused: { code: "stopped" } });
  });

  it("refuses the feed's body that is not a feed, as before", async () => {
    expect(await call("/domus/feed", { v: 1 })).toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});

describe("game memory: she asks the game, the helper answers from its record", () => {
  const askMemory = (about: string, thread = "domus:slot3"): Promise<Receipt> =>
    tool("game_memory").run({ about }, { thread, turnId: "t-memory", nowMs: clock } as ToolContext);
  const sync = (session = "helper-1") => call("/domus/acts/sync", { v: 1, helper_session: session, events: [] });
  const answer = (askId: string, facts: Record<string, unknown>, session = "helper-1") =>
    call("/domus/memory", { v: 1, helper_session: session, ask_id: askId, facts });
  const askIdOf = (body: Record<string, unknown>): string => ((body.memory as Array<{ ask_id: string }>)[0]?.ask_id) ?? "";
  const MEMORY_ACT = { act_id: "a-1", at: "14:20:00.000 day:3 week:0", minutes: 45, what: "Brew Glimmer", by: "user_intent", needs: { Gloop: 30 }, day: 3, at_ms: T0 };

  it("hands her question to the helper's sync once, with its id and its words", async () => {
    await attach();
    expect(await askMemory("Brew Glimmer")).toMatchObject({ ok: true });
    const first = await sync();
    expect(first.body.memory).toEqual([{ ask_id: expect.any(String), about: "Brew Glimmer" }]);
    expect((await sync()).body.memory).toEqual([]);
  });

  it("applies the helper's answer once, as one event on her thread that wakes her, and says what matched", async () => {
    await attach();
    await askMemory("Brew Glimmer");
    const askId = askIdOf((await sync()).body);
    const before = events.length;
    const reply = await answer(askId, { matched: 1, acts: [MEMORY_ACT], people: [{ who: "Mara Quill", acts: 1, last_at_ms: T0 }] });
    expect(reply).toEqual({ status: 200, body: { status: "ok", applied: true } });
    expect(events).toHaveLength(before + 1);
    expect(events[before]).toMatchObject({ world: "domus", thread: "domus:slot3", actor: "game", source: "outside", wake: true });
    expect(events[before]?.text).toContain("What the game remembers about \"Brew Glimmer\" (1 matched, newest first):");
    expect(events[before]?.text).toContain("- Day 3, 14:20, 45 min: brew glimmer (your act); gloop +30.");
    expect(events[before]?.text).toContain("- Mara Quill: 1 act together, last at ");
    expect(await answer(askId, { matched: 0, acts: [], people: [] })).toEqual({ status: 200, body: { status: "ok", applied: false } });
    expect(events).toHaveLength(before + 1);
  });

  it("says the game remembers nothing when nothing matched", async () => {
    await attach();
    await askMemory("Lark");
    const askId = askIdOf((await sync()).body);
    await answer(askId, { matched: 0, acts: [], people: [] });
    expect(events.at(-1)?.text).toBe("The game remembers nothing about \"Lark\".");
  });

  it("answers an unknown or a settled question with applied false, and refuses a wrong body as invalid", async () => {
    await attach();
    expect(await answer("never-asked", { matched: 0, acts: [], people: [] })).toEqual({ status: 200, body: { status: "ok", applied: false } });
    expect(await call("/domus/memory", { v: 1, helper_session: "helper-1", ask_id: "x-1", facts: { matched: 0, acts: [], people: [], score: 1 } }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("refuses a body over sixteen kilobytes as too large", async () => {
    await attach();
    const huge = "m".repeat(17 * 1024);
    expect(await answer("x-2", { matched: 0, acts: [], people: [{ who: huge, acts: 1, last_at_ms: T0 }] }))
      .toEqual({ status: 413, body: { error: "payload_too_large" } });
  });

  it("expires a question two minutes after she asked, with a note and no wake, and no longer hands it over", async () => {
    await attach();
    await askMemory("Brew Glimmer");
    clock += 119_000;
    expect((await sync()).body.memory).toEqual([{ ask_id: expect.any(String), about: "Brew Glimmer" }]);
    expect(events.some((event) => event.text?.includes("did not answer"))).toBe(false);
    clock += 1_000;
    const reply = await sync();
    expect(reply.body.memory).toEqual([]);
    expect(events.at(-1)).toMatchObject({ text: "The game did not answer about \"Brew Glimmer\".", source: "body", wake: false });
  });

  it("keeps her open question and hands it over while the summoner's stop is on: the stop refuses acts only (Q-j)", async () => {
    await attach();
    await askMemory("Brew Glimmer");
    writeStop(dir, "test");
    const reply = await sync();
    expect(reply.body.memory).toEqual([expect.objectContaining({ about: "Brew Glimmer" })]);
    expect(events.some((event) => String(event.text).includes("was withdrawn: your summoner's emergency stop is on"))).toBe(false);
  });

  it("refuses a second question on the same thread while one is open", async () => {
    await attach();
    expect(await askMemory("Brew Glimmer")).toMatchObject({ ok: true });
    expect(await askMemory("Pim")).toMatchObject({ ok: false, refused: { code: "already_asked" } });
  });
});
