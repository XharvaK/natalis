import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext, WorldEvent } from "../../contracts.js";
import { writeStop } from "../../entity/stop.js";
import { createDomusWorld, type DomusWorld } from "./domus-world.js";
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

function make(token = TOKEN, others: string[] = [BOT]): DomusWorld {
  return createDomusWorld({ dir, token, host: "127.0.0.1", port: 0, nowMs: () => clock, otherTokens: others });
}

async function startWorld(): Promise<DomusWorld> {
  const next = make();
  await next.start((event) => events.push(event));
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
    percepts: [{ kind: "sim_arrives", salience: 0.8, facts: { subject: "Pim Dorrow" } }],
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
  it("admits a new view with 202, and emits one outside event on the game thread with its refs", async () => {
    const reply = await call("/domus/observation", viewBody());
    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ status: "admitted", observation_id: "helper-1.1", receipt_time_ms: T0 });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ world: "domus", place: "domus:slot3", thread: "domus:slot3", actor: "game", source: "outside", wake: true, atMs: T0 - 1000 });
    expect(event?.text).toContain("The game (slot3) shows:");
    expect(event?.text).toContain("- sim arrives: subject Pim Dorrow");
    expect(event?.text).toContain("- Test kettle (here, 2.0 m): a1 Boil water; a2 Tidy up");
    expect(event?.data).toMatchObject({ observationId: "helper-1.1", world: "slot3", options: VIEW });
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
    await call("/domus/observation", viewBody());
    events = [];
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
    await call("/domus/acts/sync", { v: 1, helper_session: "helper-1", events: [{ act_id: actId, phase: "rejected", at_ms: T0, detail: { code: "NOT_ATTACHED" } }] });
    expect(events[0]).toMatchObject({ wake: true });
    expect(events[0]?.text).toContain("the game refused it (NOT_ATTACHED)");
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
    const ghost = [{ object: "Ghost", object_id: "obj-ghost", acts: [{ ref: "a8", guid64: "808", text: "Haunt" }] }];
    // The view before the undone one, which stands after the undo.
    await call("/domus/observation", viewBody({ observation_id: "helper-1.before", seq: 499, source_time_ms: clock - 1000 }));
    await call("/domus/observation", viewBody({ observation_id: "helper-1.undo", seq: 500, source_time_ms: clock - 500, options: ghost }));
    expect((await gameAct({ option: "a8" }, "t-ghost")).ok).toBe(true);
    events = [];
    const undo = await call("/domus/undo", { v: 1, world: "slot3", branch: "branch-1", session: "telemetry-1", after_source_time_ms: T0 - 800, reason: "HELPER_UNDO" });
    expect(undo).toEqual({ status: 200, body: { status: "ok", observations: 1, supports: 0, assertions: 0, episodes: 0, journal: 0 } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ place: "domus:slot3", source: "body", wake: false });
    expect(events[0]?.text).toContain(`The game went back to ${new Date(T0 - 800).toISOString()}.`);
    expect(events[0]?.text).toContain("did not happen");
    // The undone view's choices are gone; the view before it (still standing) is what the refs resolve against.
    expect(await gameAct({ option: "a8" }, "t-undo")).toMatchObject({ ok: false, refused: { code: "unknown_option" } });
    expect(await gameAct({ option: "a1" }, "t-undo-2")).toMatchObject({ ok: true, data: { label: "Boil water (Test kettle)" } });
  });

  it("refuses an undo with a bad reason or an unknown key as invalid_body", async () => {
    expect(await call("/domus/undo", { v: 1, world: "slot3", branch: "b", session: "s", after_source_time_ms: T0, reason: "lower" }))
      .toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});

describe("the world's surface", () => {
  it("offers one game tool, says what it is about, and refuses words", async () => {
    expect(world?.id).toBe("domus");
    expect(world?.tools().map((item) => item.spec.name)).toEqual(["game_act"]);
    expect(world?.tools()[0]?.spec.safeWhenStopped).toBeUndefined();
    expect(world?.about?.()).toBe("The Sims 4 (Domus): your household's game, at domus:<world>, while your summoner's helper is attached.");
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
