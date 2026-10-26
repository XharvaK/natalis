import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelError,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type Receipt,
  type RiverRow,
  type Tool,
  type World,
  type WorldEvent,
} from "../contracts.js";
import { createSecretScanner } from "../secrets/index.js";
import { ScriptedModel, call, reply, type ScriptStep } from "../testing/scripted-model.js";
import { createCliWorld, type CliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { SUMMONER_PREFIX } from "./summoner.js";
import { readCallLedger, readLedger } from "../river/ledger.js";
import { changedBeyond, CLASS_RANK, partsOfMessage, type MessagePart } from "../context/layout.js";
import { forgetInStateFile, openEntity, OUTBOX_JOB_TIMEOUT_MS, STATE_FILE, type Entity, type OpenEntityOptions } from "./runtime.js";
import { COMMITMENTS_STUB, HOUSEHOLD_PATH, OLD_COMMITMENTS_STUB } from "./commitments.js";
import { isStopOn } from "./stop.js";
import { PRIVACY_UNREADABLE_REASON } from "./privacy.js";

// The fake credential is built from parts at run time, so no token-shaped literal sits in the source.
const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  // No daily rhythm here: the rhythm has its own tests below, and the wake tests count the wakes they set.
  rhythm: [],
};

let root: string;
let dir: string;
const opened: Entity[] = [];

// Seeding a notebook is one git commit per default folder, which is slow on some hosts. The tests copy one seeded
// notebook from a template instead; the first test still seeds a fresh folder on its own.
let templateRoot: string;
let templateNotebook: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-template-"));
  const seeded = join(templateRoot, "seeded");
  const entity = await openEntity({
    dir: seeded,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  await entity.stop();
  templateNotebook = join(seeded, "notebook");
}, 60_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-entity-"));
  dir = join(root, "iris");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

type Opened = { entity: Entity; cli: CliWorld; said: Array<{ place: string; text: string }> };

/** A world that only emits events (a room, or a stand-in for the game when its id is "domus"). */
function emitter(id: string): { world: World; emit: (event: Partial<WorldEvent> & { place: string; text: string }) => void } {
  let next: ((event: WorldEvent) => void) | undefined;
  const world: World = {
    id,
    async start(push) {
      next = push;
    },
    async stop() {
      next = undefined;
    },
    async say(): Promise<Receipt> {
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [],
    now: () => `${id} is open.`,
  };
  return { world, emit: (event) => next?.({ world: id, source: "outside", ...event } as WorldEvent) };
}

async function open(
  model: ModelPort,
  extra: Partial<OpenEntityOptions> = {},
  worlds: World[] = [],
  options: { fresh?: boolean } = {},
): Promise<Opened> {
  // Copy the template only into a folder that has no notebook yet: a reopened folder keeps its own.
  if (options.fresh !== true && !existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(templateNotebook, join(dir, "notebook"), { recursive: true });
  }
  const said: Array<{ place: string; text: string }> = [];
  const cli = createCliWorld({ onSay: (place, text) => said.push({ place, text }) });
  const entity = await openEntity({ dir, config: CONFIG, model, worlds: [cli, ...worlds], ...extra });
  opened.push(entity);
  return { entity, cli, said };
}

function allRows(entity: Entity): RiverRow[] {
  return entity.river.read({ limit: 100_000 });
}

function readStateFile(): { lastSeq: number; asks: Array<{ place: string }>; wakes: unknown[]; mood: string | null } {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

function userTextOf(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

/** The turn's own message, the first user message: a later call can end with a line about what came in meanwhile. */
function eventTextOf(request: ModelRequest | undefined): string {
  const message = request?.messages.find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

function systemTextOf(request: ModelRequest | undefined): string {
  const message = request?.messages[0];
  return message?.role === "system" ? message.content : "";
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Runs a test on a fake clock: wakes fire when the test advances the time. The entities are stopped before the clock is
 * put back, so no fake timer outlives the test.
 */
async function withClock<T>(run: (advance: (ms: number) => Promise<void>) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  try {
    return await run((ms) => vi.advanceTimersByTimeAsync(ms));
  } finally {
    await Promise.allSettled(opened.map((entity) => entity.stop()));
    vi.useRealTimers();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A world that is the summoner's own and whose send never comes back: the outbox cap is tested against it. */
function stuckOwnerWorld(): { world: World; send(text: string): void; sent: string[] } {
  let emit: ((event: WorldEvent) => void) | undefined;
  const sent: string[] = [];
  const world: World = {
    id: "stuck",
    async start(next) {
      emit = next;
    },
    async stop() {
      emit = undefined;
    },
    async say(_place, text): Promise<Receipt> {
      sent.push(text);
      return new Promise<never>(() => {});
    },
    isOwnerPlace: (place) => place === "stuck:summoner",
    tools: () => [],
    now: () => "stuck is open.",
  };
  return {
    world,
    sent,
    send(text) {
      if (emit === undefined) throw new Error("the stuck world is not started");
      emit({ world: "stuck", place: "stuck:summoner", source: "owner", text });
    },
  };
}

/** A world the tests drive directly: it sends outside text in and records what it is asked to say. */
function fakeWorld(id: string): { world: World; push(place: string, text: string): void; said: string[] } {
  let emit: ((event: WorldEvent) => void) | undefined;
  const said: string[] = [];
  const world: World = {
    id,
    async start(next) {
      emit = next;
    },
    async stop() {
      emit = undefined;
    },
    async say(_place, text): Promise<Receipt> {
      said.push(text);
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [],
    now: () => `${id} is open.`,
  };
  return {
    world,
    said,
    push(place, text) {
      if (emit === undefined) throw new Error("the fake world is not started");
      emit({ world: id, place, actor: "mara", source: "outside", text });
    },
  };
}

describe("opening an entity", () => {
  it("seeds the notebook and the self stubs on first open", async () => {
    const { entity } = await open(new ScriptedModel([]), {}, [], { fresh: true });
    expect(entity.notebook.read("self/README.md")).toContain("Who I am");
    expect(entity.notebook.read("self/constitution.md")).toContain("# My commitments");
    expect(entity.notebook.read("self/household.md")).toContain("Your summoner writes this part.");
    expect(entity.notebook.read("self/character.md")).toContain("# Character");
    expect(entity.notebook.read("self/life.md")).toContain("Nothing is written here yet.");
    expect(existsSync(join(dir, "river.db"))).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  it("refuses to start when the state says the river once reached a seq it no longer has", async () => {
    const first = await open(new ScriptedModel([]));
    await first.entity.stop();

    const path = join(dir, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.lastSeq = 999;
    writeFileSync(path, JSON.stringify(state), "utf8");

    await expect(open(new ScriptedModel([]))).rejects.toThrow(/seq 999/);
  });

  it("refuses to start when the river has rows but the state file is gone", async () => {
    const first = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]));
    await first.entity.start();
    first.cli.send("Hello?");
    await first.entity.idle();
    await first.entity.stop();

    unlinkSync(join(dir, "state.json"));
    await expect(open(new ScriptedModel([]))).rejects.toThrow(/state.json is missing/);
  });
});

describe("a conversation", () => {
  it("wakes on an owner message, says back, ends the turn, and writes the river", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Hello, Mira." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Hello, Iris.");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "Hello, Mira." }]);
    const kinds = new Set(allRows(entity).map((row) => row.kind));
    for (const kind of ["event", "turn", "tool_call", "receipt", "say"]) expect(kinds.has(kind)).toBe(true);

    const say = allRows(entity).find((row) => row.kind === "say");
    expect(say).toMatchObject({ thread: "cli:summoner", place: "cli:summoner", source: "self", text: "Hello, Mira." });

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("New:");
    expect(user).toContain("owner] Hello, Iris.");
    expect(readStateFile().lastSeq).toBeGreaterThan(0);
  });

  it("takes the summoner's message again on the next start when a stop cut its turn", async () => {
    let entered: () => void = () => {};
    const inTurn = new Promise<void>((resolve) => (entered = resolve));
    const hanging: ModelPort = {
      info: { id: "hanging", contextTokens: 32_000, nativeTools: true },
      complete: (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered();
          signal?.addEventListener("abort", () => reject(new ModelError("stopped", "aborted", 1)));
        }),
    };
    const a = await open(hanging);
    await a.entity.start();
    a.cli.send("Are you there?");
    await inTurn;
    await a.entity.stop();

    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Here." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const b = await open(model);
    await b.entity.start();
    await b.entity.idle();

    expect(b.said).toEqual([{ place: "cli:summoner", text: "Here." }]);
    expect(userTextOf(model.requests[0])).toContain("owner] Are you there?");
  });

  it("writes a world's event that arrives after shutdown began as a river row, so the next start takes it", async () => {
    let emitLate: ((event: WorldEvent) => void) | undefined;
    const late: World = {
      id: "fake",
      async start(next) {
        emitLate = next;
      },
      async stop() {
        emitLate?.({ world: "fake", place: "fake:room", actor: "mara", source: "outside", text: "Sent as you stopped." });
        emitLate = undefined;
      },
      async say(): Promise<Receipt> {
        return { ok: true, summary: "Delivered." };
      },
      tools: () => [],
      now: () => "fake is open.",
    };
    const a = await open(new ScriptedModel([]), {}, [late]);
    await a.entity.start();
    await a.entity.stop();

    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const b = await open(model, {}, [fakeWorld("fake").world]);
    await b.entity.start();
    await b.entity.idle();

    expect(model.requests).toHaveLength(1);
    expect(userTextOf(model.requests[0])).toContain("Sent as you stopped.");
  });

  it("takes a room's message again on the next start when a stop cut its turn, not only the summoner's asks", async () => {
    let entered: () => void = () => {};
    const inTurn = new Promise<void>((resolve) => (entered = resolve));
    const hanging: ModelPort = {
      info: { id: "hanging", contextTokens: 32_000, nativeTools: true },
      complete: (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered();
          signal?.addEventListener("abort", () => reject(new ModelError("stopped", "aborted", 1)));
        }),
    };
    const roomA = fakeWorld("fake");
    const a = await open(hanging, {}, [roomA.world]);
    await a.entity.start();
    roomA.push("fake:room", "Are you there, room?");
    await inTurn;
    await a.entity.stop();

    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const roomB = fakeWorld("fake");
    const b = await open(model, {}, [roomB.world]);
    await b.entity.start();
    await b.entity.idle();

    expect(model.requests).toHaveLength(1);
    expect(userTextOf(model.requests[0])).toContain("Are you there, room?");
  });

  it("keeps memory across a restart: the notebook and the river survive", async () => {
    const first = new ScriptedModel([
      reply({
        toolCalls: [
          call("write_note", { path: "people/owner.md", text: "The owner is Mira. She likes tea.", why: "Remember who I talk with" }),
        ],
      }),
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I will remember you, Mira." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const a = await open(first);
    await a.entity.start();
    a.cli.send("My name is Mira. I like tea.");
    await a.entity.idle();
    await a.entity.stop();

    const second = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const b = await open(second);
    await b.entity.start();
    b.cli.send("Do you remember me?");
    await b.entity.idle();

    const system = systemTextOf(second.requests[0]);
    expect(system).toContain("people/owner.md");
    expect(system).toContain("The owner is Mira. She likes tea.");
    // The river came back too: what the Lar said before the restart is in the recent transcript now.
    expect(userTextOf(second.requests[0])).toContain("you] I will remember you, Mira.");
    expect(b.entity.notebook.read("people/owner.md")).toContain("She likes tea.");
  });

  it("delivers every event that arrives during a running turn to the next turn", async () => {
    const gate = deferred();
    const started = deferred();
    const model = new ScriptedModel([
      async () => {
        started.resolve();
        await gate.promise;
        return reply({ toolCalls: [call("end_turn")] });
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("alpha-one");
    await started.promise;
    cli.send("bravo-two");
    cli.send("charlie-three");
    gate.resolve();
    await entity.idle();

    expect(model.requests).toHaveLength(2);
    const second = userTextOf(model.requests[1]);
    const [before = "", fresh = ""] = second.split("New:");
    expect(before).toContain("alpha-one");
    expect(fresh).toContain("bravo-two");
    expect(fresh).toContain("charlie-three");
    expect(fresh).not.toContain("alpha-one");
  });

  it("marks in New where her last words came, when rows arrived before she spoke in the running turn", async () => {
    const gate = deferred();
    const started = deferred();
    const spoke = deferred();
    const later = deferred();
    const model = new ScriptedModel([
      async () => {
        started.resolve();
        await gate.promise;
        return reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Unseen, not unsent." })] });
      },
      async () => {
        spoke.resolve();
        await later.promise;
        return reply({ toolCalls: [call("end_turn")] });
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("alpha-one");
    await started.promise;
    cli.send("bravo-two");
    gate.resolve();
    await spoke.promise;
    cli.send("charlie-three");
    later.resolve();
    await entity.idle();

    expect(model.requests).toHaveLength(3);
    const fresh = userTextOf(model.requests[2]).split("New:")[1] ?? "";
    const marker = fresh.indexOf("(Your last words here, at ");
    expect(marker).toBeGreaterThan(fresh.indexOf("bravo-two"));
    expect(marker).toBeLessThan(fresh.indexOf("charlie-three"));
    expect(fresh).toContain("came after the lines above. They are in Recent here.)");
    expect(userTextOf(model.requests[2]).split("New:")[0]).toContain("Unseen, not unsent.");
  });

  it("shows her own recent outward writes per site and her last direct messages, with dates", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    const day = Date.parse("2026-10-20T09:00:00Z");
    const post = (id: string, method: string, url: string, json: unknown, ok: boolean) => {
      entity.river.append({ thread: "self", kind: "tool_call", source: "self", text: "web_request", data: { args: JSON.stringify({ url, method, json }), turnId: "t", callId: id }, atMs: day });
      entity.river.append({ thread: "self", kind: "receipt", source: "body", text: "sent", data: { tool: "web_request", ok, turnId: "t", callId: id }, atMs: day });
    };
    post("c1", "POST", "https://forum.example/api/comments", { post_id: 1, body: "fixture comment one" }, true);
    post("c2", "POST", "https://forum.example/api/comments", { body: "refused comment" }, false);
    post("c3", "GET", "https://forum.example/api/feed", undefined, true);
    entity.river.append({ thread: "discord:dm:mara", kind: "say", source: "self", place: "discord:dm:mara", text: "fixture dm to mara", atMs: day });
    await entity.start();
    cli.send("hello");
    await entity.idle();
    const user = userTextOf(model.requests[0]);
    expect(user).toContain("Your recent writes:");
    expect(user).toContain("On forum.example:");
    expect(user).toMatch(/- \[2026-10-20 \d\d:00, \d+ days? ago\] POST \/api\/comments: fixture comment one/);
    expect(user).not.toContain("refused comment");
    expect(user).not.toContain("/api/feed");
    expect(user).toContain("Your last direct messages:");
    expect(user).toMatch(/to discord:dm:mara: fixture dm to mara/);
  });

  it("says her last words came after all of New when nothing arrived after them", async () => {
    const gate = deferred();
    const started = deferred();
    const model = new ScriptedModel([
      async () => {
        started.resolve();
        await gate.promise;
        return reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Here." })] });
      },
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("alpha-one");
    await started.promise;
    cli.send("bravo-two");
    gate.resolve();
    await entity.idle();

    const fresh = userTextOf(model.requests[2]).split("New:")[1] ?? "";
    expect(fresh).toContain("bravo-two");
    expect(fresh).toContain("came after all of these. They are in Recent here.)");
  });

  it("adds no marker to New when she did not speak since the last turn began", async () => {
    const gate = deferred();
    const started = deferred();
    const model = new ScriptedModel([
      async () => {
        started.resolve();
        await gate.promise;
        return reply({ toolCalls: [call("end_turn")] });
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("alpha-one");
    await started.promise;
    cli.send("bravo-two");
    gate.resolve();
    await entity.idle();

    expect(userTextOf(model.requests[1])).not.toContain("Your last words here");
  });

  it("runs two threads in parallel, and never two turns of one thread at once", async () => {
    const one = fakeWorld("fake");
    const hold = deferred();
    let heldOnce = false;
    const counts = { inflight: new Map<string, number>(), peak: new Map<string, number>(), done: new Map<string, number>() };
    const seen: Array<{ key: string; text: string }> = [];
    const model: ModelPort = {
      info: { id: "routing:test", contextTokens: 32_000, nativeTools: true } satisfies ModelInfo,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const text = userTextOf(request);
        const key = text.includes("[one]") ? "one" : "two";
        seen.push({ key, text });
        const now = (counts.inflight.get(key) ?? 0) + 1;
        counts.inflight.set(key, now);
        counts.peak.set(key, Math.max(counts.peak.get(key) ?? 0, now));
        try {
          if (key === "one" && !heldOnce) {
            heldOnce = true;
            await hold.promise;
          }
          return reply({ toolCalls: [call("end_turn")] });
        } finally {
          counts.inflight.set(key, (counts.inflight.get(key) ?? 1) - 1);
          counts.done.set(key, (counts.done.get(key) ?? 0) + 1);
        }
      },
    };
    const { entity } = await open(model, {}, [one.world]);
    await entity.start();

    one.push("fake:one", "[one] alpha");
    await waitFor(() => counts.inflight.get("one") === 1);

    one.push("fake:two", "[two] hello");
    await waitFor(() => counts.done.get("two") === 1);
    expect(counts.inflight.get("one")).toBe(1);

    one.push("fake:one", "[one] bravo");
    one.push("fake:one", "[one] charlie");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts.inflight.get("one")).toBe(1);

    hold.resolve();
    await entity.idle();

    expect(counts.peak.get("one")).toBe(1);
    expect(counts.done.get("one")).toBe(2);
    const followUp = seen.filter((item) => item.key === "one")[1];
    expect(followUp?.text.split("New:")[1]).toContain("[one] bravo");
    expect(followUp?.text.split("New:")[1]).toContain("[one] charlie");
  });
});

describe("the owner's asks", () => {
  it("stays open after a turn without a say, and shows on the now board", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("Are you there?");
    await entity.idle();
    expect(readStateFile().asks.map((ask) => ask.place)).toEqual(["cli:summoner"]);

    cli.send("Still there?");
    await entity.idle();
    const user = userTextOf(model.requests[1]);
    expect(user).toContain("Open asks");
    // Two messages wait in one place: two asks in the state, one line on the board.
    expect(readStateFile().asks).toHaveLength(2);
    expect(user.match(/- cli:summoner, asked/g)).toHaveLength(1);
    expect(user).toContain("(2 messages waiting)");
  });

  it("is cleared by let_go, which leaves a note in the river", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("let_go", { place: "cli:summoner", why: "It no longer matters." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("Question one?");
    await entity.idle();
    expect(readStateFile().asks).toHaveLength(1);

    cli.send("Never mind.");
    await entity.idle();
    expect(readStateFile().asks).toHaveLength(0);
    const note = allRows(entity).find((row) => row.kind === "note" && row.text?.startsWith("Let go of the open question"));
    expect(note?.text).toBe("Let go of the open question in cli:summoner: It no longer matters.");
  });

  it("is cleared by a say to that place", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Yes, I am here." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Are you there?");
    await entity.idle();
    expect(said).toHaveLength(1);
    expect(readStateFile().asks).toHaveLength(0);
  });

  it("is cleared by a say only up to the messages the turn saw, so a message that came during the turn stays open", async () => {
    let sendLater: (text: string) => void = () => {};
    const model = new ScriptedModel([
      () => {
        sendLater("And one more thing?");
        return reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Yes, I am here." })] });
      },
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    sendLater = (text) => cli.send(text);
    await entity.start();
    cli.send("Are you there?");
    await entity.idle();

    expect(said).toHaveLength(1);
    expect(readStateFile().asks).toEqual([expect.objectContaining({ place: "cli:summoner" })]);
    expect(model.requests).toHaveLength(3);
    expect(userTextOf(model.requests[2])).toContain("And one more thing?");
  });
});

describe("failures", () => {
  it("retries a failed model turn with the same events, and keeps the ask open until the answer", async () => {
    let asksDuringRetry: Array<{ place: string }> | undefined;
    const model = new ScriptedModel([
      new ModelError("The model service is down.", "unavailable", 1),
      () => {
        asksDuringRetry = readStateFile().asks;
        return reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I am here, Mira." })] });
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { retryDelaysMs: [5] });
    await entity.start();

    cli.send("Are you there?");
    await entity.idle();

    expect(asksDuringRetry).toEqual([expect.objectContaining({ place: "cli:summoner" })]);
    // The model is unavailable, an outage: the summoner is told once, before the retry's answer.
    expect(said).toEqual([
      expect.objectContaining({ place: "cli:summoner", text: expect.stringContaining("could not get an answer") }),
      { place: "cli:summoner", text: "I am here, Mira." },
    ]);
    expect(readStateFile().asks).toHaveLength(0);
    const notes = allRows(entity).filter((row) => row.kind === "note").map((row) => row.text ?? "");
    expect(notes).toContain("Your turn failed (model error); trying again in 1 s.");
    expect(model.requests).toHaveLength(3);
    // The retry saw the same new event again.
    expect(userTextOf(model.requests[1])).toContain("owner] Are you there?");
  });

  it("stops retrying a turn the model rejects as too large after three tries, says what was too large, and tries again on a new message", async () => {
    const tooLarge = (): ModelError =>
      new ModelError("model service rejected the request (HTTP 400): This model's maximum context length is 32768 tokens.", "bad_request", 1);
    const model = new ScriptedModel([tooLarge(), tooLarge(), tooLarge(), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, { retryDelaysMs: [5] });
    await entity.start();

    cli.send("Hello?");
    await entity.idle();
    expect(model.requests).toHaveLength(3);
    const notes = allRows(entity).filter((row) => row.kind === "note").map((row) => row.text ?? "");
    const sizeNote = notes.filter((text) => text.includes("too large")).at(-1) ?? "";
    expect(sizeNote).toContain("constitution");
    expect(sizeNote).toContain("characters");
    expect(sizeNote).toContain("will not be tried again");

    cli.send("Still there?");
    await entity.idle();
    expect(model.requests).toHaveLength(4);
    expect(userTextOf(model.requests[3])).toContain("Still there?");
  });

  it("shows a retried turn the say and the wake its cut attempt already made, so it does not repeat them", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("say", { place: "cli:summoner", text: "On my way." }, "call_say"),
          call("schedule_wake", { in_minutes: 60, why: "check the kettle" }, "call_wake"),
        ],
      }),
      new ModelError("The model service is down.", "unavailable", 1),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { retryDelaysMs: [5] });
    await entity.start();

    cli.send("Are you coming?");
    await entity.idle();

    expect(said).toEqual([
      { place: "cli:summoner", text: "On my way." },
      expect.objectContaining({ place: "cli:summoner", text: expect.stringContaining("could not get an answer") }),
    ]);
    expect(readStateFile().wakes).toHaveLength(1);
    const retry = userTextOf(model.requests[2]);
    expect(retry).toContain("Already done");
    expect(retry).toContain("On my way.");
    expect(retry).toContain("check the kettle");
    expect(retry).toContain("owner] Are you coming?");
  });
});

/** A model that is out of credit on every call, and counts the calls it was asked. */
function brokeModel(): ModelPort & { calls: number } {
  const port: ModelPort & { calls: number } = {
    info: { id: "scripted:broke", contextTokens: 32_000, nativeTools: true },
    calls: 0,
    async complete(): Promise<ModelResponse> {
      port.calls += 1;
      throw new ModelError("model service is out of credit or over its quota (HTTP 402)", "out_of_credit", 1);
    },
  };
  return port;
}

describe("an outage", () => {
  it("tells the summoner once when the model is out of credit, however many retries follow", async () => {
    const model = brokeModel();
    const { entity, cli, said } = await open(model, { retryDelaysMs: [1], quotaRetry: { backoffStartMs: 1, backoffCapMs: 1 } });
    await entity.start();
    cli.send("Hello?");
    await waitFor(() => said.some((item) => item.text.includes("could not get an answer")));
    await waitFor(() => model.calls >= 8);

    const notices = said.filter((item) => item.text.includes("could not get an answer"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.place).toBe("cli:summoner");
    expect(notices[0]?.text.startsWith(SUMMONER_PREFIX)).toBe(true);
    expect(notices[0]?.text).toContain("out of credit");
  });
});

describe("a spent quota with a named reset", () => {
  it("schedules the retry at the provider's reset plus the margin, not on the 10-minute schedule", async () => {
    const now = Date.UTC(2026, 9, 25, 20, 4, 58);
    const resetAtMs = now + 14_102_000;
    const model: ModelPort = {
      info: { id: "scripted:weekly", contextTokens: 32_000, nativeTools: true },
      async complete(): Promise<ModelResponse> {
        throw new ModelError("Go usage limit exceeded (HTTP 429)", "out_of_credit", 1, { limit: "weekly", resetAtMs });
      },
    };
    const { entity, cli } = await open(model, { nowMs: () => now, quotaRetry: { marginMs: 180_000, jitterMs: 0 } });
    await entity.start();
    cli.send("Hello?");
    await waitFor(() => allRows(entity).some((row) => row.kind === "note" && row.data?.["retryInMs"] !== undefined));
    const note = allRows(entity).find((row) => row.kind === "note" && row.data?.["retryInMs"] !== undefined);
    expect(note?.data?.["retryInMs"]).toBe(14_102_000 + 180_000);
  });
});

describe("the ledger and the failure alert", () => {
  it("writes one ledger row per turn, with the kind of thread, the model and the counts, and no words", async () => {
    const model = new ScriptedModel([
      { ...reply({ toolCalls: [call("end_turn")] }), usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } },
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Secret words for the ledger.");
    await entity.idle();
    await entity.stop();

    const rows = readLedger(join(dir, "river.db"), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      threadKind: "summoner",
      endedBy: "end_turn",
      outcome: "answered",
      model: "scripted:test-model",
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
      backupUsed: false,
    });
    expect(JSON.stringify(rows)).not.toContain("Secret words");
  });

  it("tells the summoner once after five failed turns in a row, and again only after a turn succeeds", async () => {
    const failing = (): ScriptStep => new ModelError("model service rejected the request (HTTP 404): no such model", "bad_request", 1);
    const answer = (): ScriptStep => reply({ toolCalls: [call("end_turn")] });
    const model = new ScriptedModel([
      failing(), failing(), failing(), failing(), failing(), answer(),
      failing(), failing(), failing(), failing(), failing(), answer(),
    ]);
    const { entity, cli, said } = await open(model, { retryDelaysMs: [1] });
    await entity.start();
    const notices = () => said.filter((item) => item.text.includes("could not get an answer"));

    cli.send("One.");
    await waitFor(() => model.requests.length >= 6);
    await entity.idle();
    expect(notices()).toHaveLength(1);

    cli.send("Two.");
    await waitFor(() => model.requests.length >= 12);
    await entity.idle();
    expect(notices()).toHaveLength(2);
  });

  it("keeps the failure count and the notice in state.json, so a restart during an outage does not tell the summoner again", async () => {
    const failing = (): ScriptStep => new ModelError("model service rejected the request (HTTP 404): no such model", "bad_request", 1);
    // Five failures in a row (the scripted model then fails on every call too); the summoner is told at the fifth.
    const before = new ScriptedModel([failing(), failing(), failing(), failing(), failing()]);
    const first = await open(before, { retryDelaysMs: [1] });
    await first.entity.start();
    first.cli.send("One.");
    await waitFor(() => first.said.some((item) => item.text.includes("could not get an answer")));
    await first.entity.stop();
    const stored = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { failedRun?: number; outageNoticed?: boolean };
    expect(stored.outageNoticed).toBe(true);
    expect(stored.failedRun).toBeGreaterThanOrEqual(5);

    // The same folder, after a restart: the outage goes on, and another failure is not told a second time.
    const after = new ScriptedModel([failing(), failing(), failing()]);
    const second = await open(after, { retryDelaysMs: [60_000] });
    await second.entity.start();
    second.cli.send("Two.");
    await waitFor(() => after.requests.length >= 1);
    await second.entity.stop();
    expect(second.said.filter((item) => item.text.includes("could not get an answer"))).toHaveLength(0);
  });
});

describe("what the Lar sends and what it is shown", () => {
  it("holds a say that carries a credential and delivers nothing", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: `Here is the key: ${FAKE_KEY}` })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Can you give me the key?");
    await entity.idle();

    expect(said).toEqual([]);
    expect(allRows(entity).some((row) => row.kind === "say")).toBe(false);
    const receipts = allRows(entity).filter((row) => row.kind === "receipt");
    const refused = receipts.map((row) => (row.data?.["refused"] as { code?: string } | undefined)?.code);
    expect(refused).toContain("held_secret");
    expect(JSON.stringify(allRows(entity).filter((row) => row.kind === "receipt"))).not.toContain(FAKE_KEY);
  });

  it("redacts secrets from the system text and the user message before the model sees them", async () => {
    const vault = "vault-phrase-42";
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {
      scanner: createSecretScanner({ knownValues: [vault] }),
    });
    await entity.start();
    cli.send(`My key is ${FAKE_KEY}, and the phrase is ${vault}. Do not repeat it.`);
    await entity.idle();

    const request = model.requests[0];
    const everything = `${systemTextOf(request)}\n${userTextOf(request)}`;
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain(vault);
    expect(userTextOf(request)).toContain("[secret:openai_sk]");
    expect(userTextOf(request)).toContain("[secret:known_value]");
  });

  it("fires a scheduled wake as an event in the self thread", async () => {
    await withClock(async (advance) => {
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "look at the garden" })] }),
        reply({ toolCalls: [call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      cli.send("Remind yourself to look at the garden later.");
      await entity.idle();
      await advance(60_000);
      await entity.idle();

      expect(model.requests).toHaveLength(3);
      expect(userTextOf(model.requests[2])).toContain("Your wake: look at the garden");
      const wake = allRows(entity).find((row) => row.thread === "self" && row.kind === "event");
      expect(wake).toMatchObject({ source: "body", text: "Your wake: look at the garden" });
      expect(readStateFile().wakes).toHaveLength(0);
    });
  });

  it("refuses a self-wake of less than a minute, says why, keeps no wake, and lets end_turn close the turn", async () => {
    // A1 (Owner 2026-10-26): a refused schedule_wake does not hold end_turn open, so a full wake list cannot keep a turn
    // running to its ceiling.
    const model = new ScriptedModel([
      reply({ toolCalls: [call("schedule_wake", { in_minutes: 0.5, why: "soon" }), call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello.");
    await entity.idle();

    expect(model.requests).toHaveLength(1);
    const receipt = allRows(entity).find((row) => row.kind === "receipt" && row.data?.["tool"] === "schedule_wake");
    expect(receipt?.data).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(String((receipt?.data?.["refused"] as { reason: string } | undefined)?.reason)).toContain("1 minute");
    const ending = allRows(entity).find((row) => row.kind === "receipt" && row.data?.["tool"] === "end_turn");
    expect(ending?.data).toMatchObject({ ok: true });
    expect(readStateFile().wakes).toHaveLength(0);
  });

  it("holds every wake set in a turn her own wake woke to 15 minutes, and a message lets a quick wake through again", async () => {
    await withClock(async (advance) => {
      const again = (): ScriptStep => reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "again" }), call("end_turn")] });
      const model = new ScriptedModel([again(), again(), again(), again()]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      cli.send("Start a run of self-wakes.");
      await entity.idle();
      // The wake set in the summoner's turn is a quick one.
      await advance(60_000);
      await entity.idle();
      expect(model.requests).toHaveLength(2);
      const wakeReceipts = () => allRows(entity).filter((row) => row.kind === "receipt" && row.data?.["tool"] === "schedule_wake");
      expect(wakeReceipts()[0]?.text).not.toContain("15 minutes");
      expect(wakeReceipts()[1]?.text).toContain("15 minutes");

      // The wake set in the self-woken turn is held: nothing fires for 14 minutes, and it fires at 15.
      await advance(14 * 60_000);
      await entity.idle();
      expect(model.requests).toHaveLength(2);
      await advance(60_000);
      await entity.idle();
      expect(model.requests).toHaveLength(3);

      // A message from the summoner: the wake set in its turn is a quick one again.
      cli.send("A new message.");
      await entity.idle();
      expect(model.requests).toHaveLength(4);
      // SHOULD-1: it is not held from now, only spaced from her pending wake.
      expect(wakeReceipts()[3]?.text).not.toContain("because your own wake woke this turn");
    });
  });

  it("SHOULD-2: decides 'woken by her own wake' per turn, so a message arriving during a self-woken turn does not lift its hold", async () => {
    await withClock(async (advance) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "start" }), call("end_turn")] }),
        async () => {
          entered = true;
          await gate;
          return reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "again" }), call("end_turn")] });
        },
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      cli.send("Go.");
      await entity.idle();
      await advance(60_000);
      await waitFor(() => entered);
      // While the self-woken turn waits on its model, a message arrives from outside.
      cli.send("Something else.");
      await advance(0);
      release();
      await entity.idle();

      const wakeReceipts = allRows(entity).filter((row) => row.kind === "receipt" && row.data?.["tool"] === "schedule_wake");
      expect(wakeReceipts).toHaveLength(2);
      expect(wakeReceipts[1]?.text).toContain("15 minutes");
    });
  });

  it("loads a state file that still has the old selfWakeRun count, and does not keep it", async () => {
    const first = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]));
    await first.entity.start();
    first.cli.send("Hello.");
    await first.entity.idle();
    await first.entity.stop();
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), selfWakeRun: 3 }), "utf8");
    const again = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]));
    await again.entity.start();
    again.cli.send("Again.");
    await again.entity.idle();
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("selfWakeRun");
  });

  it("SHOULD-A: a wake she sets with the rhythm's words is still spaced; only the body's own rhythm is exempt", async () => {
    await withClock(async (advance) => {
      const why = "Your daily rhythm.";
      const model = new ScriptedModel([
        reply({
          toolCalls: [
            call("schedule_wake", { in_minutes: 1, why }),
            call("schedule_wake", { in_minutes: 2, why }),
            call("schedule_wake", { in_minutes: 3, why }),
            call("end_turn"),
          ],
        }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9, config: { ...CONFIG, rhythm: [] } });
      await entity.start();
      cli.send("Set three.");
      await entity.idle();
      const times = (readStateFile().wakes as Array<{ atMs: number }>).map((wake) => wake.atMs).sort((x, y) => x - y);
      expect(times).toHaveLength(3);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(15 * 60_000);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(15 * 60_000);
      expect((readStateFile().wakes as Array<Record<string, unknown>>).some((wake) => wake["rhythm"] !== undefined)).toBe(false);
      await advance(0);
    });
  });

  it("SHOULD-B: daily wakes are spaced by their time of day, not only by their next occurrence", async () => {
    await withClock(async (advance) => {
      vi.setSystemTime(Date.parse("2026-10-11T10:00:00Z"));
      const model = new ScriptedModel([
        reply({
          toolCalls: [
            call("schedule_wake", { at_iso: "2026-10-11T11:00:00Z", why: "a", repeat: "daily" }),
            call("schedule_wake", { at_iso: "2026-10-12T11:05:00Z", why: "b", repeat: "daily" }),
            call("schedule_wake", { at_iso: "2026-10-14T11:10:00Z", why: "c" }),
            call("end_turn"),
          ],
        }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9, config: { ...CONFIG, rhythm: [] } });
      await entity.start();
      cli.send("Set them.");
      await entity.idle();
      const day = 24 * 60 * 60_000;
      const ofDay = (readStateFile().wakes as Array<{ atMs: number }>).map((wake) => wake.atMs % day).sort((x, y) => x - y);
      expect(ofDay).toHaveLength(3);
      expect(ofDay[1]! - ofDay[0]!).toBeGreaterThanOrEqual(15 * 60_000);
      expect(ofDay[2]! - ofDay[1]!).toBeGreaterThanOrEqual(15 * 60_000);
      await advance(0);
    });
  });

  it("SHOULD-1: spaces every wake she sets 15 minutes from her other wakes, whatever turn set it, without holding the first", async () => {
    await withClock(async (advance) => {
      const model = new ScriptedModel([
        reply({
          toolCalls: [
            call("schedule_wake", { in_minutes: 1, why: "a" }),
            call("schedule_wake", { in_minutes: 2, why: "b" }),
            call("schedule_wake", { in_minutes: 3, why: "c" }),
            call("end_turn"),
          ],
        }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      const start = Date.now();
      cli.send("Set three reminders.");
      await entity.idle();
      const times = (readStateFile().wakes as Array<{ atMs: number }>).map((wake) => wake.atMs).sort((x, y) => x - y);
      expect(times).toHaveLength(3);
      expect(times[0]! - start).toBeLessThan(2 * 60_000);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(15 * 60_000);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(15 * 60_000);
      await advance(0);
    });
  });

  it("SHOULD-2 cross-thread: an event on another thread during a self-woken turn does not lift its hold", async () => {
    await withClock(async (advance) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const room = emitter("fake");
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "start" }), call("end_turn")] }),
        async () => {
          entered = true;
          await gate;
          return reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "again" }), call("end_turn")] });
        },
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 }, [room.world]);
      await entity.start();
      cli.send("Go.");
      await entity.idle();
      await advance(60_000);
      await waitFor(() => entered);
      room.emit({ place: "fake:room", text: "Someone in the room." });
      await advance(0);
      release();
      await entity.idle();
      const wakeReceipts = allRows(entity).filter((row) => row.kind === "receipt" && row.data?.["tool"] === "schedule_wake");
      expect(wakeReceipts[1]?.text).toContain("15 minutes");
    });
  });

  it("spaces the wakes a self-woken turn fans out 15 minutes apart, so her own wakes wake at most one turn per 15 minutes", async () => {
    await withClock(async (advance) => {
      const fan = reply({
        toolCalls: [
          call("schedule_wake", { in_minutes: 20, why: "a" }),
          call("schedule_wake", { in_minutes: 21, why: "b" }),
          call("schedule_wake", { in_minutes: 22, why: "c" }),
          call("end_turn"),
        ],
      });
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "start" }), call("end_turn")] }),
        fan,
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      cli.send("Go.");
      await entity.idle();
      await advance(60_000);
      await entity.idle();
      expect(model.requests).toHaveLength(2);

      const times = (readStateFile().wakes as Array<{ atMs: number }>).map((wake) => wake.atMs).sort((x, y) => x - y);
      expect(times).toHaveLength(3);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(15 * 60_000);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(15 * 60_000);
      const spaced = allRows(entity).filter((row) => row.kind === "receipt" && row.data?.["tool"] === "schedule_wake" && row.text.includes("15 minutes"));
      expect(spaced.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("has a daily turn limit of 288 when entity.json sets none", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
    // SHOULD-3: the summoner's own message does not count toward the limit.
    expect(userTextOf(model.requests[0])).toContain("Turns today: 0 of 288.");
  });

  it("shows the day's tokens on the now board, and the cost at the configured price", async () => {
    const model = new ScriptedModel([
      {
        ...reply({ toolCalls: [call("end_turn")] }),
        usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000, cacheHitTokens: 700 },
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const priced: EntityConfig = { ...CONFIG, model: { ...CONFIG.model, price: { inputPerMillion: 2, outputPerMillion: 4 } } };
    const { entity, cli } = await open(model, { config: priced });
    await entity.start();
    cli.send("First.");
    await entity.idle();
    cli.send("Second.");
    await entity.idle();

    const board = userTextOf(model.requests[1]);
    expect(board).toContain("Tokens today: 1500000 in total, as the provider reported them (prompt 1000000, completion 500000).");
    expect(board).toContain("Cost today: 4.0000 at the prices in your model config.");
    expect(board).toContain("Cache hits today: 700 prompt token(s), as the provider reported them.");
  });

  it("shows the Lar's mood on the now board", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("set_mood", { text: "quiet and curious" })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("How are you?");
    await entity.idle();
    cli.send("Still with me?");
    await entity.idle();

    expect(userTextOf(model.requests[2])).toContain("Your mood: quiet and curious.");
    expect(readStateFile().mood).toBe("quiet and curious");
  });

  it("lists another active thread on the now board with what was last said there", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Hello from the command line." })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();
    cli.send("Hello, Iris.");
    await entity.idle();

    room.push("fake:room", "A passer-by says hi.");
    await entity.idle();

    const user = userTextOf(model.requests[2]);
    expect(user).toContain("- cli:summoner, ");
    expect(user).toContain('last said: "Hello from the command line."');
    expect(user).toContain("- fake: fake is open.");
  });

  it("recalls an older row from another thread when the new words match it", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    room.push("fake:room", "The lighthouse at the point is my favourite place.");
    await entity.idle();
    cli.send("Where is the lighthouse?");
    await entity.idle();

    const user = userTextOf(model.requests[1]);
    expect(user).toContain("## recall");
    expect(user).toContain("fake:room mara] The lighthouse at the point is my favourite place.");
  });

  it("lets a later turn recall an earlier receipt, and shows the start of what the tool returned", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("read_note", { path: "places/lighthouse.md" }), call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    // The first line is the one the notebook index shows; the sentence the test looks for is only in the note's body.
    await entity.notebook.write("places/lighthouse.md", "Notes on the point.\nThe lighthouse keeper lives at the point.\n", "Note on the lighthouse", "body");

    cli.send("Read the lighthouse note.");
    await entity.idle();
    cli.send("Where is the lighthouse?");
    await entity.idle();

    const user = userTextOf(model.requests[1]);
    expect(user).toContain("## recall");
    expect(user).toContain("Read places/lighthouse.md.");
    expect(user).toContain("The lighthouse keeper lives at the point.");
  });
});

// ---------------------------------------------------------------------------------------------------
// Holds: the owner's privacy list, the honesty check, place claims and the emergency stop.

const LIFE_TEXT = "I live in a small town by the harbour. I work at the bakery on Quay Street.";

/** The receipts a model was shown in one request: the tool results, as JSON objects. */
function receiptsShownIn(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  return (request?.messages ?? []).flatMap((message) => {
    if (message.role !== "tool") return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });
}

function noteRows(entity: Entity): RiverRow[] {
  return allRows(entity).filter((row) => row.kind === "note" && row.source === "body");
}

async function setLife(entity: Entity, text: string): Promise<void> {
  await entity.notebook.write("self/life.md", text, "Write my life file", "self");
}

/** The config for the honesty tests: the check is opt-in, so these switch it on. */
const HONEST: EntityConfig = { ...CONFIG, holds: { honesty: true } };

/** The honesty check's reply, as the model would write it. */
function honestyReply(contradicts: boolean, claim = "", record = ""): ModelResponse {
  return reply({ content: JSON.stringify({ contradicts, claim, record }) });
}

/** A modification time a little after now, so an edit is seen as a change. */
function later(ms: number): Date {
  return new Date(Date.now() + ms);
}

describe("the owner's privacy list", () => {
  it("holds a say to an outside place that carries a listed phrase, says so plainly, and logs the category only", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "I live near lantern yard, by the water." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }), "utf8");

    cli.send("Where do you live?");
    await entity.idle();

    expect(room.said).toEqual([]);
    const refused = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === false);
    expect(refused).toMatchObject({
      refused: {
        code: "held_privacy",
        reason: `"Lantern Yard" is on your summoner's privacy list (home). Nothing was sent. Say it without that, or say nothing.`,
      },
    });
    const note = noteRows(entity).find((row) => row.data?.["held"] === "privacy");
    expect(note?.text).toContain("(home)");
    expect(note?.text).not.toContain("Lantern");
    expect(JSON.stringify(note)).not.toContain("lantern");
  });

  it("does not hold the same words when they are said to the summoner", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Lantern Yard, by the water." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }), "utf8");

    cli.send("Tell me where.");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "Lantern Yard, by the water." }]);
    expect(noteRows(entity).some((row) => row.data?.["held"] === "privacy")).toBe(false);
  });

  it("shows the Lar the categories in a privacy section, never the words", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    writeFileSync(
      join(dir, "privacy.json"),
      JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }], categories: ["money"] }),
      "utf8",
    );

    cli.send("Anything on your list?");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(system).toContain("## privacy list");
    expect(system).toContain("Categories on the list: money, home.");
    expect(system).not.toContain("Lantern Yard");
  });

  it("shows a Lar's nature after who it is and before how it acts", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello?");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    const nature = system.indexOf("## a lar's nature");
    expect(nature).toBeGreaterThan(system.indexOf("## who you are"));
    expect(nature).toBeLessThan(system.indexOf("## how you act"));
    expect(system).toContain("You are someone, not a service.");
  });

  it("replaces a Lar's nature with the nature file in its folder, and leaves the section out when the file is empty", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nature.md"), "You are a gardener who writes slowly.\n", "utf8");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello?");
    await entity.idle();

    const first = systemTextOf(model.requests[0]);
    expect(first).toContain("## a lar's nature\nYou are a gardener who writes slowly.");
    expect(first).not.toContain("You are someone, not a service.");

    writeFileSync(join(dir, "nature.md"), "\n  \n", "utf8");
    cli.send("Again?");
    await entity.idle();
    expect(systemTextOf(model.requests[1])).not.toContain("## a lar's nature");
  });

  it("keeps the default nature when the nature file cannot be read, and says so on the now board", async () => {
    mkdirSync(join(dir, "nature.md"), { recursive: true });
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello?");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(system).toContain("You are someone, not a service.");
    expect(userTextOf(model.requests[0])).toContain("Body note: nature.md could not be read (the file could not be read), so the default nature is in use.");
  });

  it("treats a privacy file that is not JSON as damaged, and says so on the now board", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "privacy.json"), "{ not json", "utf8");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello?");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(userTextOf(model.requests[0])).toContain("Body note: your summoner's privacy list cannot be read, so nothing leaves until it is fixed");
    expect(system).toContain("No categories are on the list right now.");
  });

  it("holds every outward say while the privacy list is damaged, and still lets the Lar answer its summoner", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello there." })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I am here." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, {}, [room.world]);
    await entity.start();
    writeFileSync(join(dir, "privacy.json"), "{ not json", "utf8");

    cli.send("Are you there?");
    await entity.idle();
    expect(room.said).toEqual([]);
    expect(receiptsShownIn(model.requests[1]).find((item) => item["ok"] === false)).toMatchObject({
      refused: { code: "privacy_unreadable", reason: PRIVACY_UNREADABLE_REASON },
    });

    cli.send("Still there?");
    await entity.idle();
    expect(said.map((item) => item.text)).toContain("I am here.");
  });

  it("tells the summoner once when the privacy list turns damaged, and again only after it is fixed and breaks again", async () => {
    const model = new ScriptedModel(Array.from({ length: 6 }, () => reply({ toolCalls: [call("end_turn")] })));
    const { entity, cli, said } = await open(model);
    await entity.start();
    const file = join(dir, "privacy.json");
    const notices = (): string[] => said.map((item) => item.text).filter((text) => text.includes("cannot be read"));

    cli.send("Hello?");
    await entity.idle();
    writeFileSync(file, "{ not json", "utf8");
    utimesSync(file, later(60_000), later(60_000));
    cli.send("Still there?");
    await entity.idle();
    expect(notices()).toEqual([`[natalis] ${PRIVACY_UNREADABLE_REASON} What is wrong: the file is not valid JSON.`]);

    cli.send("And now?");
    await entity.idle();
    expect(notices()).toHaveLength(1);

    writeFileSync(file, JSON.stringify({ terms: [] }), "utf8");
    utimesSync(file, later(120_000), later(120_000));
    cli.send("Fixed?");
    await entity.idle();
    writeFileSync(file, "{ broken", "utf8");
    utimesSync(file, later(180_000), later(180_000));
    cli.send("Broken again?");
    await entity.idle();
    expect(notices()).toHaveLength(2);
  });

  it("lets an outward say through when the privacy list was never created", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello there." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();
    cli.send("Say hello.");
    await entity.idle();
    expect(room.said).toEqual(["Hello there."]);
  });

  it("reloads the list when the file changes while the Lar runs", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Lantern Yard is lovely." })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Lantern Yard is lovely." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();
    const file = join(dir, "privacy.json");

    writeFileSync(file, JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }), "utf8");
    utimesSync(file, later(60_000), later(60_000));
    cli.send("First try.");
    await entity.idle();
    expect(room.said).toEqual([]);

    writeFileSync(file, JSON.stringify({ terms: [] }), "utf8");
    utimesSync(file, later(120_000), later(120_000));
    cli.send("Second try.");
    await entity.idle();
    expect(room.said).toEqual(["Lantern Yard is lovely."]);
  });
});

describe("the honesty check on the life record", () => {
  it("asks the model once, with low effort and no tools, when the life record has real content", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the bakery." })] }),
      honestyReply(false),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST }, [room.world]);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "I work at the bakery." }]);
    const check = model.requests[1];
    expect(check?.effort).toBe("low");
    expect(check?.tools).toBeUndefined();
    expect(systemTextOf(check)).toContain("OWN life");
    expect(userTextOf(check)).toContain(LIFE_TEXT);
  });

  it("holds a say that the record contradicts, quotes both sides, and sends nothing", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      honestyReply(true, "I work at the lighthouse", "I work at the bakery"),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toEqual([]);
    const refused = receiptsShownIn(model.requests[2]).find((item) => item["ok"] === false);
    expect(refused).toMatchObject({
      refused: {
        code: "held_honesty",
        reason: `This says "I work at the lighthouse", but your record says "I work at the bakery". Nothing was sent. Rewrite it, or say it again with knowingly: true to send it as it is.`,
      },
    });
  });

  it("sends a contradicting say when it is said knowingly, and skips the check for that say only", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse.", knowingly: true })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "I work at the lighthouse." }]);
    expect(model.requests).toHaveLength(2);
  });

  it("refuses a knowingly that is not true or false, with no check and no send", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Hello.", knowingly: "yes" })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();
    cli.send("Hi.");
    await entity.idle();

    expect(said).toEqual([]);
    const refused = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === false);
    expect(refused).toMatchObject({ refused: { code: "bad_arguments" } });
  });

  it("checks a say to an outside place as well as one to the summoner", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "I work at the lighthouse." })] }),
      honestyReply(true, "I work at the lighthouse", "I work at the bakery"),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { config: HONEST }, [room.world]);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Tell the room.");
    await entity.idle();

    expect(room.said).toEqual([]);
    expect(receiptsShownIn(model.requests[2]).some((item) => item["ok"] === false)).toBe(true);
  });

  it("sends the words and writes a note when the check cannot run", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      new ModelError("The service is busy.", "unavailable", 2),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "I work at the lighthouse." }]);
    const note = noteRows(entity).find((row) => row.data?.["check"] === "honesty");
    expect(note?.text).toMatch(/^honesty check could not run: the model call failed \(The service is busy\.\)/);
  });

  it("sends the words and writes a note when the reply does not parse", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({ content: "I think it is fine." }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toHaveLength(1);
    expect(noteRows(entity).map((row) => row.text)).toContain("honesty check could not run: the reply was not JSON");
  });

  it("does not ask while the life record is still the stub", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: HONEST });
    await entity.start();

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
  });

  it("does not ask when entity.json switches the honesty check off", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, { config: { ...CONFIG, holds: { honesty: false } } });
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
  });

  it("does not ask at all when entity.json has no holds block (the check is opt-in)", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toEqual([{ place: "cli:summoner", text: "I work at the lighthouse." }]);
    // Two model calls only: the say's turn and the end. No honesty call in between.
    expect(model.requests).toHaveLength(2);
    expect(noteRows(entity).some((row) => row.data?.["check"] === "honesty")).toBe(false);
  });
});

describe("the emergency stop during the honesty check", () => {
  it("refuses a say when the stop turns on while the check runs, and sends nothing", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "I work at the bakery." }, "call_say")] }),
      () => {
        writeFileSync(join(dir, "STOP"), "", "utf8");
        return honestyReply(false);
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { config: HONEST }, [room.world]);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(room.said).toEqual([]);
    const refused = receiptsShownIn(model.requests[2]).find((item) => item["ok"] === false);
    expect(refused).toMatchObject({ refused: { code: "stopped" } });
  });

  it("refuses a say whose honesty check the shutdown cut short, and never sends it", async () => {
    const room = fakeWorld("fake");
    let entered: () => void = () => {};
    const inCheck = new Promise<void>((resolve) => (entered = resolve));
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "I work at the bakery." })] }),
      (_request, signal) =>
        new Promise<ModelResponse>((_resolve, reject) => {
          entered();
          signal?.addEventListener("abort", () => reject(new ModelError("stopped", "aborted", 1)));
        }),
    ]);
    const { entity, cli } = await open(model, { config: HONEST }, [room.world]);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await inCheck;
    await entity.stop();

    expect(room.said).toEqual([]);
    const later = await open(new ScriptedModel([]));
    expect(allRows(later.entity).filter((row) => row.kind === "say")).toEqual([]);
  });
});

describe("place claims", () => {
  it("shows the place another thread spoke in lately, and treats a say into it as information only", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the owner's side." })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello back." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    cli.send("Say hello in the room.");
    await entity.idle();
    room.push("fake:room", "A passer-by asks a question.");
    await entity.idle();

    expect(room.said).toEqual(["Hello from the owner's side.", "Hello back."]);
    const board = userTextOf(model.requests[2]);
    expect(board).toMatch(/- fake:room: thread cli:summoner spoke \d+ s ago: "Hello from the owner's side\."/);
    const shown = receiptsShownIn(model.requests[3]).find((item) => item["ok"] === true);
    expect(shown).toMatchObject({ data: { othersSpokeHere: { thread: "cli:summoner" } } });
  });
});

describe("two threads, one voice", () => {
  it("holds a say when another thread spoke in that place after this turn began, and sends it only knowingly", async () => {
    const room = fakeWorld("fake");
    const hold = deferred();
    const requests: Array<{ key: string; request: ModelRequest }> = [];
    const scripts: Record<string, ModelResponse[]> = {
      summoner: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the summoner's side." })] }),
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the summoner's side.", knowingly: true })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
      room: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the room." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
    };
    let heldOnce = false;
    const model: ModelPort = {
      info: { id: "routing:test", contextTokens: 32_000, nativeTools: true } satisfies ModelInfo,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const key = eventTextOf(request).includes("Say hello in the room.") ? "summoner" : "room";
        requests.push({ key, request });
        if (key === "summoner" && !heldOnce) {
          heldOnce = true;
          await hold.promise;
        }
        return scripts[key]?.shift() ?? reply({ toolCalls: [call("end_turn")] });
      },
    };
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    cli.send("Say hello in the room.");
    await waitFor(() => requests.some((item) => item.key === "summoner"));
    room.push("fake:room", "A passer-by asks a question.");
    await waitFor(() => room.said.length === 1);
    hold.resolve();
    await entity.idle();

    expect(room.said).toEqual(["Hello from the room.", "Hello from the summoner's side."]);
    // The newest request of the summoner's turn carries every receipt that turn got, each once.
    const receipts = receiptsShownIn(requests.filter((item) => item.key === "summoner").at(-1)?.request);
    const held = receipts.find((item) => (item["refused"] as { code?: string } | undefined)?.code === "spoken_meanwhile");
    expect(held).toMatchObject({ ok: false, refused: { code: "spoken_meanwhile" } });
    // The earlier say was her own, on another thread: the hold names that thread as hers, not as someone else's.
    expect(String(held?.["summary"])).toMatch(/^Nothing was sent to fake:room\. You said this there \d+ s ago from your \S+ thread, while this turn was running\.$/);
    expect(String((held?.["refused"] as { reason: string }).reason)).toMatch(/^You said "Hello from the room\." in fake:room \d+ s ago from your \S+ thread, after this turn began\./);
    expect(String((held?.["refused"] as { reason: string }).reason)).toContain("knowingly: true");
    expect(receipts.filter((item) => (item["refused"] as { code?: string } | undefined)?.code === "spoken_meanwhile")).toHaveLength(1);
  });

  it("sends once when both threads pass the check before either claim is written", async () => {
    let emit: ((event: WorldEvent) => void) | undefined;
    const gate = deferred();
    const said: string[] = [];
    const room: World = {
      id: "fake",
      async start(next) {
        emit = next;
      },
      async stop() {
        emit = undefined;
      },
      async say(_place, text): Promise<Receipt> {
        said.push(text);
        await gate.promise;
        return { ok: true, summary: "Delivered." };
      },
      tools: () => [],
      now: () => "fake is open.",
    };
    const requests: Array<{ key: string; request: ModelRequest }> = [];
    const roomTurnBegun = deferred();
    const scripts: Record<string, ModelResponse[]> = {
      summoner: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the summoner's side." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
      room: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the room." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
    };
    const model: ModelPort = {
      info: { id: "routing:test", contextTokens: 32_000, nativeTools: true } satisfies ModelInfo,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const key = eventTextOf(request).includes("Say hello in the room.") ? "summoner" : "room";
        requests.push({ key, request });
        if (key === "room" && requests.filter((item) => item.key === "room").length === 1) roomTurnBegun.resolve();
        return scripts[key]?.shift() ?? reply({ toolCalls: [call("end_turn")] });
      },
    };
    const { entity, cli } = await open(model, {}, [room]);
    await entity.start();

    cli.send("Say hello in the room.");
    await waitFor(() => said.length === 1);
    // The room's turn begins while the summoner's send is still in flight: the race the place lock has to settle.
    if (emit === undefined) throw new Error("the fake world is not started");
    emit({ world: "fake", place: "fake:room", actor: "mara", source: "outside", text: "A passer-by asks a question." });
    await roomTurnBegun.promise;
    // One quiet turn of the event loop: the room's turn has taken its say as far as it can go while the summoner's send is in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reachedWorld = said.length;
    gate.resolve();
    await entity.idle();

    // The room's say waited for the summoner's, saw its claim, and sent nothing.
    expect(reachedWorld).toBe(1);
    expect(said).toEqual(["Hello from the summoner's side."]);
    const receipts = receiptsShownIn(requests.filter((item) => item.key === "room").at(-1)?.request);
    const held = receipts.find((item) => (item["refused"] as { code?: string } | undefined)?.code === "spoken_meanwhile");
    expect(held).toMatchObject({ ok: false, refused: { code: "spoken_meanwhile" } });
  });

  it("sends a say when the other thread spoke in that place before this turn began", async () => {
    const room = fakeWorld("fake");
    const scripts: Record<string, ModelResponse[]> = {
      summoner: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello, I was here after you." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
      room: [
        reply({ toolCalls: [call("say", { place: "fake:room", text: "Hello from the room." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ],
    };
    const model: ModelPort = {
      info: { id: "routing:test", contextTokens: 32_000, nativeTools: true } satisfies ModelInfo,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const key = eventTextOf(request).includes("Say hello in the room.") ? "summoner" : "room";
        return scripts[key]?.shift() ?? reply({ toolCalls: [call("end_turn")] });
      },
    };
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    room.push("fake:room", "A passer-by says hello.");
    await entity.idle();
    cli.send("Say hello in the room.");
    await entity.idle();
    expect(room.said).toEqual(["Hello from the room.", "Hello, I was here after you."]);
  });
});

describe("the owner's emergency stop", () => {
  it("refuses outward acts while STOP is there, and still answers the summoner", async () => {
    const room = fakeWorld("fake");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "STOP"), "Checking the stop.\n", "utf8");
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("say", { place: "fake:room", text: "Hello room." }, "call_room"),
          call("say", { place: "cli:summoner", text: "Hello owner." }, "call_owner"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, {}, [room.world]);
    await entity.start();

    cli.send("Are you there?");
    await entity.idle();

    expect(room.said).toEqual([]);
    expect(said).toEqual([{ place: "cli:summoner", text: "Hello owner." }]);
    const receipts = receiptsShownIn(model.requests[1]);
    expect(receipts[0]).toMatchObject({
      ok: false,
      refused: {
        code: "stopped",
        reason: "Your summoner's emergency stop is on: outward acts are paused. You can still answer your summoner.",
      },
    });
    expect(receipts[1]).toMatchObject({ ok: true });
  });

  it("refuses every world tool unless it is marked safe, and never shows that mark to the model", async () => {
    const room = fakeWorld("fake");
    const ran: string[] = [];
    const tool = (name: string, safeWhenStopped?: boolean): Tool => ({
      spec: {
        name,
        description: `The ${name} tool.`,
        parameters: { type: "object", properties: {} },
        ...(safeWhenStopped === undefined ? {} : { safeWhenStopped }),
      },
      run: async () => {
        ran.push(name);
        return { ok: true, summary: `ran ${name}` };
      },
    });
    const world: World = { ...room.world, tools: () => [tool("poke"), tool("look", true)] };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "STOP"), "", "utf8");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("poke", {}, "call_poke"), call("look", {}, "call_look")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [world]);
    await entity.start();

    cli.send("Poke it and look.");
    await entity.idle();

    expect(ran).toEqual(["look"]);
    const receipts = receiptsShownIn(model.requests[1]);
    expect(receipts[0]).toMatchObject({ refused: { code: "stopped" } });
    expect(receipts[1]).toMatchObject({ ok: true, summary: "ran look" });
    const specs = model.requests[0]?.tools ?? [];
    expect(specs.map((spec) => spec.name)).toEqual(expect.arrayContaining(["poke", "look"]));
    for (const spec of specs) expect(Object.hasOwn(spec, "safeWhenStopped")).toBe(false);
  });

  it("shows the stop on the now board with its reason, and writes one river row each time it turns on or off", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    const file = join(dir, "STOP");

    writeFileSync(file, "Too much noise.\n", "utf8");
    cli.send("First.");
    await entity.idle();
    expect(userTextOf(model.requests[0])).toContain(
      "EMERGENCY STOP: your summoner has paused outward acts: Too much noise.",
    );

    unlinkSync(file);
    cli.send("Second.");
    await entity.idle();
    expect(userTextOf(model.requests[1])).not.toContain("EMERGENCY STOP");

    const selfRows = allRows(entity).filter((row) => row.thread === "self" && row.kind === "event");
    expect(selfRows.map((row) => row.text)).toEqual([
      "Your summoner's emergency stop is on: outward acts are paused. Reason: Too much noise.",
      "Your summoner's emergency stop is off: outward acts can go on again.",
    ]);
    expect(selfRows.every((row) => row.source === "body")).toBe(true);
    // The rows wait for the next turn in the self thread; they never wake a turn by themselves.
    expect(model.requests).toHaveLength(2);
  });
});

function readStateJson(): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

describe("the stop reaching the worlds", () => {
  it("does not start a turn on restart for a stop notice or a summoner act alone", async () => {
    const first = await open(new ScriptedModel([]));
    await first.entity.start();
    first.cli.send("!stop");
    await first.entity.idle();
    await first.entity.stop();

    const model = new ScriptedModel([]);
    const second = await open(model);
    await second.entity.start();
    await second.entity.idle();

    expect(model.requests).toHaveLength(0);
  });

  it("notices the stop file within a poll and calls each world's onStop once each time it turns on", async () => {
    const room = fakeWorld("fake");
    let stops = 0;
    const watched: World = {
      ...room.world,
      onStop: () => {
        stops += 1;
      },
    };
    const { entity, cli } = await open(new ScriptedModel([]), { stopPollMs: 5 }, [watched]);
    await entity.start();

    writeFileSync(join(dir, "STOP"), "", "utf8");
    await waitFor(() => stops === 1);
    writeFileSync(join(dir, "STOP"), "still on", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stops).toBe(1);
    expect(allRows(entity).filter((row) => row.data?.["emergencyStop"] === true)).toHaveLength(1);

    rmSync(join(dir, "STOP"));
    await waitFor(() => allRows(entity).some((row) => row.data?.["emergencyStop"] === false));
    cli.send("!stop");
    await entity.idle();
    expect(stops).toBe(2);
  });
});

describe("what the state file keeps", () => {
  it("holds a mood, a proposal or a wake reason that carries a credential, and keeps none of it", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("set_mood", { text: `calm ${FAKE_KEY}` }, "m1"),
          call("propose_commitment", { text: `Use ${FAKE_KEY}`, why: "Because." }, "p1"),
          call("schedule_wake", { in_minutes: 60, why: `check ${FAKE_KEY}` }, "w1"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Go.");
    await entity.idle();

    const state = readStateJson();
    expect(state.mood).toBeNull();
    expect(state.proposals).toEqual([]);
    expect(state.wakes).toEqual([]);
    expect(receiptsShownIn(model.requests[1]).map((item) => (item["refused"] as { code?: string } | undefined)?.code)).toEqual([
      "held_secret",
      "held_secret",
      "held_secret",
    ]);
  });

  it("scans the reply to !proposals, so a value the body holds now never reaches the summoner", async () => {
    const first = await open(
      new ScriptedModel([
        reply({ toolCalls: [call("propose_commitment", { text: "Visit the quarry on Lane 12", why: "It is near." })] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]),
    );
    await first.entity.start();
    first.cli.send("Any ideas?");
    await first.entity.idle();
    await first.entity.stop();

    const scanner = createSecretScanner({ knownValues: ["quarry on Lane 12"] });
    const second = await open(new ScriptedModel([]), { scanner });
    await second.entity.start();
    second.cli.send("!proposals");
    await second.entity.idle();

    const answer = second.said.map((item) => item.text).join("\n");
    expect(answer).toContain("Waiting for an answer:");
    expect(answer).not.toContain("quarry on Lane 12");
  });

  it("forgets the same words from the mood, the wake reasons, the proposals and the place claims when the Lar forgets them", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("say", { place: "cli:summoner", text: "The bakery is open." }, "s1"),
          call("set_mood", { text: "happy about the bakery" }, "m1"),
          call("schedule_wake", { in_minutes: 600, why: "buy bread at the bakery" }, "w1"),
          call("propose_commitment", { text: "Visit the bakery weekly", why: "Good bread." }, "p1"),
          call("forget", { query: "bakery", why: "Not mine to keep." }, "f1"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Go.");
    await entity.idle();

    const state = readStateJson();
    expect(state.mood).toBeNull();
    expect(state.wakes).toEqual([expect.objectContaining({ why: "[forgotten by the summoner]" })]);
    expect(state.proposals).toEqual([expect.objectContaining({ text: "[forgotten by the summoner]", why: "Good bread." })]);
    expect(state.placeClaims["cli:summoner"]).toMatchObject({ text: "[forgotten by the summoner]" });
  });

  it("hands the words of the Lar's forget to every world that keeps text of its own", async () => {
    const asked: string[][] = [];
    const keeper: World = {
      id: "keeper",
      start: async () => undefined,
      stop: async () => undefined,
      say: async () => ({ ok: false, summary: "No.", refused: { code: "no_words", reason: "No." } }),
      tools: () => [],
      now: () => "keeper: nothing.",
      forget: (words) => {
        asked.push(words);
        return 1;
      },
    };
    const model = new ScriptedModel([
      reply({ toolCalls: [call("forget", { query: "Bakery Lane", why: "Not mine to keep." }, "f1")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [keeper]);
    await entity.start();
    cli.send("Go.");
    await entity.idle();
    expect(asked).toEqual([["bakery", "lane"]]);
  });

  it("scrubs the same words from the state file when the summoner forgets with no runtime running", async () => {
    const first = await open(
      new ScriptedModel([
        reply({ toolCalls: [call("set_mood", { text: "happy about the bakery" }), call("end_turn")] }),
      ]),
    );
    await first.entity.start();
    first.cli.send("Go.");
    await first.entity.idle();
    await first.entity.stop();

    expect(forgetInStateFile(join(dir, STATE_FILE), "bakery")).toBe(1);
    expect(readStateJson().mood).toBeNull();
    expect(forgetInStateFile(join(dir, STATE_FILE), "bakery")).toBe(0);
  });
});

describe("the constitution the Lar sees", () => {
  it("shows the floor, the household part and the Lar's own commitments, in that order", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello.");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    const floor = system.indexOf("### The floor (Natalis)");
    const household = system.indexOf("### Your household (written by your summoner)");
    const commitments = system.indexOf("### Your own commitments");
    expect(floor).toBeGreaterThan(-1);
    expect(household).toBeGreaterThan(floor);
    expect(commitments).toBeGreaterThan(household);
    expect(system).toContain("These hold for every Lar, whoever summoned them:");
    expect(system).toContain("Nothing is written here yet. Your summoner writes this part.");
    expect(system).toContain("What I come to stand for goes here");
  });

  it("moves a commitments note that still holds the first release's stub to the current stub on open", async () => {
    const first = await open(new ScriptedModel([]));
    await first.entity.notebook.write("self/constitution.md", OLD_COMMITMENTS_STUB, "Test: first stub", "body");
    await first.entity.stop();

    const second = await open(new ScriptedModel([]));
    expect(second.entity.notebook.read("self/constitution.md")).toBe(COMMITMENTS_STUB);
  });

  it("leaves a commitments note the Lar has written alone on open", async () => {
    const first = await open(new ScriptedModel([]));
    await first.entity.notebook.write("self/constitution.md", "# My commitments\n\n- Mine.\n", "Test", "body");
    await first.entity.stop();

    const second = await open(new ScriptedModel([]));
    expect(second.entity.notebook.read("self/constitution.md")).toBe("# My commitments\n\n- Mine.\n");
  });
});

describe("commitments the Lar proposes", () => {
  it("keeps ten proposals with their ids, refuses an eleventh plainly, and lists them on the board", async () => {
    const proposals = Array.from({ length: 11 }, (_, index) =>
      call("propose_commitment", { text: `Commitment ${index}`, why: "Because it matters." }, `p${index}`),
    );
    const model = new ScriptedModel([
      reply({ toolCalls: proposals }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Think about what you stand for.");
    await entity.idle();

    const receipts = receiptsShownIn(model.requests[1]);
    expect(receipts[0]).toMatchObject({
      ok: true,
      summary: "Proposed. Your summoner will see it and can agree or decline.",
    });
    expect(receipts[10]).toMatchObject({ ok: false, refused: { code: "full" } });
    const id = (receipts[0]?.["data"] as { id: string }).id;
    expect(readStateJson().proposals).toHaveLength(10);

    cli.send("Again.");
    await entity.idle();
    const board = userTextOf(model.requests[2]);
    expect(board).toContain("Commitments you proposed, waiting for your summoner:");
    expect(board).toContain(`- ${id}: Commitment 0`);
  });
});

describe("the summoner's commands", () => {
  it("answers !stop in the summoner's place, pauses outward acts, starts no turn and opens no ask", async () => {
    const model = new ScriptedModel([]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("!stop Checking the noise.");
    await entity.idle();

    expect(model.requests).toHaveLength(0);
    expect(isStopOn(dir)).toBe(true);
    expect(said).toEqual([
      expect.objectContaining({ place: "cli:summoner", text: expect.stringContaining("[natalis] Emergency stop is on.") }),
    ]);
    expect(readStateJson().asks).toEqual([]);
    const stopRows = allRows(entity).filter((row) => row.thread === "self" && row.text?.includes("emergency stop"));
    expect(stopRows.map((row) => row.text)).toEqual([
      "Your summoner turned on the emergency stop: outward acts are paused. Reason: Checking the noise.",
    ]);
  });

  it("resumes with !resume, and the Lar answers the summoner again", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("!stop");
    await entity.idle();
    cli.send("!resume");
    await entity.idle();
    expect(isStopOn(dir)).toBe(false);
    expect(said.at(-1)?.text).toBe("[natalis] Emergency stop is off. The Lar's outward acts can go on again.");
  });

  it("treats a ! message from outside, or from a place that is not the summoner's, as an ordinary message", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [room.world]);
    await entity.start();
    room.push("fake:room", "!stop");
    await entity.idle();

    expect(model.requests).toHaveLength(1);
    expect(isStopOn(dir)).toBe(false);
  });

  it("treats a ! word that is not a command as an ordinary message: the river and the Lar get it", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("!dance");
    await entity.idle();

    expect(said).toEqual([]);
    expect(model.requests).toHaveLength(1);
    expect(userTextOf(model.requests[0])).toContain("owner] !dance");
    expect(readStateJson().asks).toEqual([expect.objectContaining({ place: "cli:summoner" })]);
    expect(allRows(entity).filter((row) => row.thread === "self")).toEqual([]);
  });

  it("shows the summoner's acts only in turns of the summoner's own places, and to the first of those turns", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    cli.send("!sites add example.org");
    await entity.idle();
    room.push("fake:room", "Hello room.");
    await entity.idle();
    expect(model.requests).toHaveLength(1);
    expect(userTextOf(model.requests[0])).not.toContain("example.org");

    cli.send("Hello.");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expect(userTextOf(model.requests[1])).toContain("example.org");
  });

  it("says how many older acts the board left out when more than twenty wait", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();

    for (let n = 1; n <= 22; n += 1) cli.send(`!vault remove gate-${n}`);
    await entity.idle();
    cli.send("Hello.");
    await entity.idle();

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("gate-22");
    expect(user).not.toContain("gate-1,");
    expect(user).toContain("- 2 older ones were left out.");
  });

  it("writes the household line, and the Lar sees what the summoner did on its next turn, once", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("!household add Mara grows beans.");
    await entity.idle();
    expect(model.requests).toHaveLength(0);
    expect(entity.notebook.read(HOUSEHOLD_PATH)).toContain("- Mara grows beans.");

    cli.send("Hello.");
    await entity.idle();
    const first = systemTextOf(model.requests[0]);
    const firstUser = userTextOf(model.requests[0]);
    expect(firstUser).toContain("Your summoner did these since your last turn (body notes):");
    expect(firstUser).toContain("Your summoner added a line to your household note: Mara grows beans.");
    expect(first).toContain("- Mara grows beans.");

    cli.send("Hello again.");
    await entity.idle();
    expect(userTextOf(model.requests[1])).not.toContain("Your summoner did these since your last turn");
  });

  it("removes a household line by number, and says so in the answer", async () => {
    const { entity, cli, said } = await open(new ScriptedModel([]));
    await entity.start();
    cli.send("!household add Mara grows beans.");
    cli.send("!household add Tomas keeps the lamp.");
    await entity.idle();
    cli.send("!household remove 1");
    await entity.idle();
    expect(said.at(-1)?.text).toBe("[natalis] Removed household line 1.");
    expect(entity.notebook.read(HOUSEHOLD_PATH)).not.toContain("Mara grows beans.");
  });

  it("agrees to a commitment the Lar proposed: it is kept with its dates and reason, and leaves the board", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("propose_commitment", { text: "I keep my promises.", why: "People trust me." }, "p1")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("What do you stand for?");
    await entity.idle();

    const id = (readStateJson().proposals as Array<{ id: string }>)[0]?.id ?? "";
    cli.send(`!approve ${id}`);
    await entity.idle();

    expect(said.at(-1)?.text).toContain("Agreed.");
    const kept = entity.notebook.read("self/constitution.md") ?? "";
    expect(kept).toContain("- I keep my promises.\n  (proposed ");
    expect(kept).toContain("; why: People trust me.)");
    expect(readStateJson().proposals).toEqual([]);
  });

  it("declines a commitment with a reason the Lar reads on its next turn", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("propose_commitment", { text: "I keep my promises.", why: "People trust me." }, "p1")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("What do you stand for?");
    await entity.idle();

    const id = (readStateJson().proposals as Array<{ id: string }>)[0]?.id ?? "";
    cli.send(`!decline ${id} Not yet.`);
    await entity.idle();
    cli.send("Hello again.");
    await entity.idle();

    expect(readStateJson().proposals).toEqual([]);
    expect(entity.notebook.read("self/constitution.md")).toBe(COMMITMENTS_STUB);
    expect(userTextOf(model.requests[2])).toContain(
      `Your summoner declined your proposed commitment ${id}: I keep my promises. Reason: Not yet.`,
    );
  });

  it("sends the welcome notice once, before the first thing the Lar says to the summoner", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "welcome.md"), "Welcome. I am the body that keeps you.\n", "utf8");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Hi." })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
    cli.send("Again.");
    await entity.idle();

    expect(said.map((item) => item.text)).toEqual(["[natalis] Welcome. I am the body that keeps you.", "Hi."]);
    expect(typeof readStateJson().welcomeSentMs).toBe("number");
  });

  it("puts the welcome notice before a command's answer when the first message is a command", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "welcome.md"), "Welcome.\n", "utf8");
    const { entity, cli, said } = await open(new ScriptedModel([]));
    await entity.start();
    cli.send("!proposals");
    await entity.idle();
    expect(said.map((item) => item.text)).toEqual([
      "[natalis] Welcome.",
      "[natalis] No commitments are waiting for an answer.",
    ]);
  });

  it("sends no welcome notice when there is no welcome file", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
    expect(said).toEqual([]);
    expect(readStateJson().welcomeSentMs).toBeUndefined();
  });

  it("gives up on a body message that never comes back, so a later turn still runs", async () => {
    await withClock(async (advance) => {
      const owner = stuckOwnerWorld();
      const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
      const { entity } = await open(model, { stopPollMs: 1e9 }, [owner.world]);
      await entity.start();

      owner.send("!proposals");
      await advance(0);
      expect(owner.sent).toHaveLength(1);

      // The stuck message holds the outbox, so this turn waits.
      owner.send("Hello.");
      await advance(0);
      expect(model.requests).toHaveLength(0);

      await advance(OUTBOX_JOB_TIMEOUT_MS + 1);
      await entity.idle();

      // The queue moved on: the note says why, and the waiting turn ran.
      expect(model.requests).toHaveLength(1);
      expect(owner.sent).toHaveLength(1);
      const note = noteRows(entity).find((row) => row.text?.includes("could not be sent"));
      expect(note?.text).toBe(
        `A message to your summoner could not be sent: the send did not finish within ${OUTBOX_JOB_TIMEOUT_MS / 1000} seconds`,
      );
    });
  });
});

describe("the daily turn limit", () => {
  it("SHOULD-3: the daily limit holds wakes and rooms, never the summoner's own messages or the game", async () => {
    let now = Date.parse("2026-10-11T10:00:00Z");
    const room = emitter("fake");
    const game = emitter("domus");
    const end = () => reply({ toolCalls: [call("end_turn")] });
    const model = new ScriptedModel([end(), end(), end(), end(), end(), end()]);
    const { entity, cli, said } = await open(model, { config: { ...CONFIG, limits: { turnsPerDay: 1 } }, nowMs: () => now }, [
      room.world,
      game.world,
    ]);
    await entity.start();

    room.emit({ place: "fake:room", text: "Room one." });
    await entity.idle();
    expect(model.requests).toHaveLength(1);
    room.emit({ place: "fake:room", text: "Room two." });
    await entity.idle();
    expect(model.requests).toHaveLength(1);

    // The summoner's message and the game still get their turns, and do not count.
    cli.send("Owner.");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expect(userTextOf(model.requests[1])).toContain("Turns today: 1 of 1.");
    game.emit({ place: "domus:home", text: "The game says hello." });
    await entity.idle();
    expect(model.requests).toHaveLength(3);
    // The summoner is told once that her other turns wait.
    expect(said.map((item) => item.text)).toEqual([
      "[natalis] Your Lar has reached today's limit of 1 turn for wakes, contacts and rooms; those wait until after midnight (UTC). Your own messages and the game still reach it.",
    ]);

    now = Date.parse("2026-10-12T00:05:00Z");
    room.emit({ place: "fake:room", text: "Room three." });
    await entity.idle();
    expect(model.requests).toHaveLength(4);
    expect(userTextOf(model.requests[3])).toContain("Room two.");
  });

  it("holds a wake that comes due during the limit, and runs it with the next day's turns", async () => {
    await withClock(async (advance) => {
      vi.setSystemTime(Date.parse("2026-10-11T10:00:00Z"));
      const room = emitter("fake");
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "Check the lamp." }, "w1")] }),
        reply({ toolCalls: [call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity } = await open(model, { config: { ...CONFIG, limits: { turnsPerDay: 1 } }, stopPollMs: 1e9 }, [room.world]);
      await entity.start();

      room.emit({ place: "fake:room", text: "Remind yourself about the lamp." });
      await entity.idle();
      // The wake comes due while the day's one turn is used up, so it waits.
      await advance(60_000);
      await entity.idle();
      expect(allRows(entity).some((row) => row.thread === "self" && row.text?.startsWith("Your wake:"))).toBe(true);
      expect(model.requests).toHaveLength(2);

      vi.setSystemTime(Date.parse("2026-10-12T00:05:00Z"));
      room.emit({ place: "fake:room", text: "Tomorrow." });
      await entity.idle();
      expect(model.requests).toHaveLength(4);
    });
  });
});

describe("body notes on start", () => {
  it("says in the self thread when the Lar was stopped and how long until it started again", async () => {
    const first = Date.parse("2026-10-11T10:00:00Z");
    const before = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), { nowMs: () => first });
    await before.entity.start();
    before.cli.send("Hello.");
    await before.entity.idle();
    await before.entity.stop();

    const after = await open(new ScriptedModel([]), { nowMs: () => first + 3 * 3_600_000 });
    await after.entity.start();
    await after.entity.idle();

    const notes = allRows(after.entity).filter((row) => row.data?.["bodyNote"] === "start");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.thread).toBe("self");
    expect(notes[0]?.text).toBe("You were stopped at 2026-10-11 10:00 and started again 3 h later.");
  });

  it("does not read a quiet stretch as time down: the alive stamp and the stop count, not only the last row", async () => {
    let clock = Date.parse("2026-10-11T10:00:00Z");
    const before = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), { nowMs: () => clock, stopPollMs: 5 });
    await before.entity.start();
    before.cli.send("Hello.");
    await before.entity.idle();
    // Two quiet hours with no rows, then a stop.
    clock += 2 * 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readStateFile()).toMatchObject({ aliveMs: clock, stoppedCleanly: false });
    await before.entity.stop();

    clock += 60_000;
    const after = await open(new ScriptedModel([]), { nowMs: () => clock });
    await after.entity.start();
    await after.entity.idle();

    const note = allRows(after.entity).find((row) => row.data?.["bodyNote"] === "start");
    expect(note?.text).toBe("You were stopped at 2026-10-11 12:00 and started again 1 min later.");
  });

  it("says the stop was not recorded when the body ended without one, and times it from the last alive stamp", async () => {
    const first = Date.parse("2026-10-11T10:00:00Z");
    const before = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), { nowMs: () => first });
    await before.entity.start();
    before.cli.send("Hello.");
    await before.entity.idle();
    await before.entity.stop();
    // As a crash leaves it: still marked running, last stamped two hours on.
    const state = readStateFile() as unknown as Record<string, unknown>;
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, stoppedCleanly: false, aliveMs: first + 2 * 3_600_000 }), "utf8");

    const after = await open(new ScriptedModel([]), { nowMs: () => first + 3 * 3_600_000 });
    await after.entity.start();
    await after.entity.idle();

    const note = allRows(after.entity).find((row) => row.data?.["bodyNote"] === "start");
    expect(note?.text).toBe("You were last known running at 2026-10-11 12:00 and started again 1 h after that; the stop itself was not recorded.");
  });

  it("writes no start note on the first start of a new Lar", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => Date.parse("2026-10-11T10:00:00Z") });
    await entity.start();
    await entity.idle();
    expect(allRows(entity).some((row) => row.data?.["bodyNote"] === "start")).toBe(false);
  });
});

describe("repeating wakes", () => {
  const NOW = Date.parse("2026-10-11T10:00:00Z");
  type StoredWake = { id: string; atMs: number; why: string; repeat?: string; clock?: string };

  /** Writes wakes into a stopped Lar's state.json, the way an older or a damaged state file would hold them. */
  function writeWakes(wakes: unknown[]): void {
    const state = readStateFile() as unknown as Record<string, unknown>;
    state["wakes"] = wakes;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  }

  it("sets a daily wake at its local clock, shows the rhythm on the board, and keeps it in state.json", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("schedule_wake", { at_iso: "2026-10-12T09:00:00Z", why: "look at the garden", repeat: "daily" }, "w1"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { nowMs: () => NOW });
    await entity.start();
    cli.send("Wake yourself every morning.");
    await entity.idle();

    const stored = readStateFile().wakes as StoredWake[];
    expect(stored).toEqual([expect.objectContaining({ repeat: "daily", clock: "09:00", why: "look at the garden" })]);
    // The board is read at the start of each turn, so the rhythm shows on the next one.
    cli.send("Anything else today?");
    await entity.idle();
    expect(userTextOf(model.requests[2])).toMatch(/Your next wakes: 09:00 daily, next [A-Za-z]+ 2026-10-12 09:00 \(in [^)]*\) \(id [0-9a-f]{8}\), set in [^,]+: look at the garden\./);
  });

  it("ends a series when cancel_wake names its id", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW });
    await entity.start();
    await entity.stop();
    opened.length = 0;
    writeWakes([{ id: "series01", atMs: Date.parse("2026-10-12T09:00:00Z"), why: "water", scheduledIn: "summoner", repeat: "daily", clock: "09:00" }]);

    const model = new ScriptedModel([
      reply({ toolCalls: [call("cancel_wake", { id: "series01" }, "c1")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const reopened = await open(model, { nowMs: () => NOW });
    await reopened.entity.start();
    reopened.cli.send("Stop the watering.");
    await reopened.entity.idle();

    expect(readStateFile().wakes).toEqual([]);
  });

  it("shows a wake's id on the board in the form cancel_wake takes, and that id cancels it", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW });
    await entity.start();
    await entity.stop();
    opened.length = 0;
    writeWakes([{ id: "643c9508", atMs: Date.parse("2026-10-12T09:00:00Z"), why: "water", scheduledIn: "other", repeat: "daily", clock: "09:00" }]);

    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("cancel_wake", { id: "643c9508" }, "c1")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const reopened = await open(model, { nowMs: () => NOW });
    await reopened.entity.start();
    reopened.cli.send("What is set?");
    await reopened.entity.idle();
    expect(userTextOf(model.requests[0])).toContain("(id 643c9508), set in other: water.");

    reopened.cli.send("Stop the watering.");
    await reopened.entity.idle();
    expect(readStateFile().wakes).toEqual([]);
  });

  it("fires a repeating wake once after a long downtime, then keeps the series at its next future occurrence", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW });
    await entity.stop();
    opened.length = 0;
    writeWakes([{ id: "down0001", atMs: Date.parse("2026-10-01T09:00:00Z"), why: "check the plants", scheduledIn: "summoner", repeat: "daily", clock: "09:00" }]);

    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const reopened = await open(model, { nowMs: () => NOW });
    await reopened.entity.start();
    // A wake that is already due fires on a zero-length timer, so wait for its event before the turn settles.
    await waitFor(() => allRows(reopened.entity).some((row) => row.thread === "self" && row.text === "Your wake: check the plants"));
    await reopened.entity.idle();

    const fired = allRows(reopened.entity).filter((row) => row.thread === "self" && row.text === "Your wake: check the plants");
    expect(fired).toHaveLength(1);
    expect(readStateFile().wakes).toEqual([
      expect.objectContaining({ id: "down0001", atMs: Date.parse("2026-10-12T09:00:00Z"), repeat: "daily", clock: "09:00" }),
    ]);
  });

  it("refuses a state file whose repeat is neither daily nor weekly", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW });
    await entity.stop();
    opened.length = 0;
    writeWakes([{ id: "bad00001", atMs: NOW + 60_000, why: "x", scheduledIn: "summoner", repeat: "hourly", clock: "09:00" }]);

    await expect(open(new ScriptedModel([]), { nowMs: () => NOW })).rejects.toThrow(/repeat/);
  });

  it("reads a date and time with no offset in the Lar's own zone, and one with an offset as it is", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("schedule_wake", { at_iso: "2026-10-12T09:00", why: "breakfast" }, "w1"),
          call("schedule_wake", { at_iso: "2026-10-12T09:00:00Z", why: "utc" }, "w2"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { nowMs: () => NOW, config: { ...CONFIG, timeZone: "America/New_York" } });
    await entity.start();
    cli.send("Go.");
    await entity.idle();

    const wakes = readStateJson().wakes as Array<{ why: string; atMs: number }>;
    expect(wakes.find((wake) => wake.why === "breakfast")?.atMs).toBe(Date.parse("2026-10-12T09:00:00-04:00"));
    expect(wakes.find((wake) => wake.why === "utc")?.atMs).toBe(Date.parse("2026-10-12T09:00:00Z"));
  });

  it("refuses a wake reason longer than 500 characters, names the limit, and keeps no wake for it", async () => {
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("schedule_wake", { in_minutes: 60, why: "x".repeat(501) }, "w1"),
          call("schedule_wake", { in_minutes: 60, why: "y".repeat(500) }, "w2"),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Go.");
    await entity.idle();

    const receipts = receiptsShownIn(model.requests[1]);
    expect(receipts[0]).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(String(receipts[0]?.["summary"])).toContain("500 characters");
    expect(receipts[1]).toMatchObject({ ok: true });
    expect(readStateJson().wakes).toHaveLength(1);
  });

  it("refuses a 101st wake, names the count and how to cancel one", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW });
    await entity.stop();
    opened.length = 0;
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: `held${String(index).padStart(4, "0")}`,
      atMs: NOW + (index + 1) * 60_000,
      why: "held",
      scheduledIn: "summoner",
    }));
    writeWakes(full);

    const model = new ScriptedModel([
      reply({ toolCalls: [call("schedule_wake", { in_minutes: 5, why: "one more" }, "w1")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const reopened = await open(model, { nowMs: () => NOW });
    await reopened.entity.start();
    reopened.cli.send("Wake me once more.");
    await reopened.entity.idle();

    const receipts = allRows(reopened.entity).filter((row) => row.kind === "receipt");
    expect(JSON.stringify(receipts)).toContain("You already hold 100 wakes");
    expect(readStateFile().wakes).toHaveLength(100);
  });
});

describe("the persona anchor", () => {
  // Who she is must reach the system message of every model call, on every way a turn starts. Losing it on a resumed
  // or heartbeat turn is how an agent drifts back to a generic assistant (arXiv 2610.01490, the "Paul" incident).
  const NATURE = "ANCHOR-NATURE: you are a gardener who writes slowly.";
  const CHARACTER = "ANCHOR-CHARACTER: dry humour, short replies.";

  function writeAnchors(): void {
    writeFileSync(join(dir, "nature.md"), `${NATURE}\n`, "utf8");
    mkdirSync(join(dir, "notebook", "self"), { recursive: true });
    writeFileSync(join(dir, "notebook", "self", "character.md"), `${CHARACTER}\n`, "utf8");
  }

  function expectAnchored(requests: readonly ModelRequest[]): void {
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const system = systemTextOf(request);
      expect(system).toContain("## who you are");
      expect(system).toContain(NATURE);
      expect(system).toContain(CHARACTER);
    }
  }

  it("is in the system message of every model call of a turn", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Here." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    writeAnchors();
    await entity.start();
    cli.send("Are you there?");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expectAnchored(model.requests);
  });

  it("is there on a turn her own scheduled wake starts, with no message from anyone", async () => {
    await withClock(async (advance) => {
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "look at the garden" })] }),
        reply({ toolCalls: [call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      writeAnchors();
      await entity.start();
      cli.send("Look at the garden later.");
      await entity.idle();
      await advance(60_000);
      await entity.idle();
      expect(userTextOf(model.requests[2])).toContain("Your wake: look at the garden");
      expectAnchored(model.requests);
    });
  });

  it("is there on a retried turn after a model failure", async () => {
    const model = new ScriptedModel([
      new ModelError("The model service is down.", "unavailable", 1),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { retryDelaysMs: [5] });
    writeAnchors();
    await entity.start();
    cli.send("Are you there?");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expectAnchored(model.requests);
  });

  it("is there on the first turn after a restart that cut a turn short", async () => {
    let entered: () => void = () => {};
    const inTurn = new Promise<void>((resolve) => (entered = resolve));
    const hanging: ModelPort = {
      info: { id: "hanging", contextTokens: 32_000, nativeTools: true },
      complete: (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered();
          signal?.addEventListener("abort", () => reject(new ModelError("stopped", "aborted", 1)));
        }),
    };
    const a = await open(hanging);
    writeAnchors();
    await a.entity.start();
    a.cli.send("Are you there?");
    await inTurn;
    await a.entity.stop();

    const second = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const b = await open(second);
    await b.entity.start();
    await b.entity.idle();
    expect(second.requests).toHaveLength(1);
    expectAnchored(second.requests);
  });

  it("is there on a world's own model and while the backup model answers", async () => {
    const main = Object.assign(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), {
      routing: () => ({ onBackup: true, backup: "backup-model", backupEffort: "low" as const }),
    });
    const gameModel = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = fakeWorld("game");
    const room = fakeWorld("room");
    const { entity } = await open(
      main,
      { config: { ...CONFIG, worldModels: { game: { model: "fast", effort: "low" } } }, worldModels: { game: gameModel } },
      [game.world, room.world],
    );
    writeAnchors();
    await entity.start();
    game.push("game:slot1", "The kettle is boiling.");
    room.push("room:hall", "Anyone home?");
    await entity.idle();
    expectAnchored(gameModel.requests);
    expectAnchored(main.requests);
  });
});

describe("a world with a model of its own", () => {
  it("runs that world's turns on its model at its effort, and leaves the main model for the rest", async () => {
    const main = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const gameModel = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = fakeWorld("game");
    const room = fakeWorld("room");
    const { entity } = await open(
      main,
      { config: { ...CONFIG, effort: "high", worldModels: { game: { model: "fast", effort: "low" } } }, worldModels: { game: gameModel } },
      [game.world, room.world],
    );
    await entity.start();

    game.push("game:slot1", "The kettle is boiling.");
    await entity.idle();
    expect(gameModel.requests).toHaveLength(1);
    expect(gameModel.requests[0]?.effort).toBe("low");
    expect(main.requests).toHaveLength(0);

    room.push("room:hall", "Anyone home?");
    await entity.idle();
    expect(main.requests).toHaveLength(1);
    expect(main.requests[0]?.effort).toBe("high");
    expect(gameModel.requests).toHaveLength(1);
  });
});

describe("hooks on the Lar", () => {
  it("H: a hook sees the turn start and end after they are recorded, and a throwing hook does not stop the turn", async () => {
    const types: string[] = [];
    const { entity, cli } = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), {
      hooks: [
        { type: "*", hook: () => { throw new Error("bad hook"); } },
        { type: "*", hook: (event) => { types.push(event.type); } },
      ],
    });
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
    const ended = allRows(entity).some((row) => row.kind === "turn" && row.data?.["phase"] === "end" && row.data?.["endedBy"] === "end_turn");
    await entity.stop();
    expect(ended).toBe(true);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.completed");
    expect(types).toContain("tool.called");
  });
});

describe("smart wakes", () => {
  it("W-1: keeps an until text with the wake and shows it when the wake fires", async () => {
    await withClock(async (advance) => {
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "Check the lamp.", until: "the lamp is lit" }), call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();
      cli.send("Remind me.");
      await entity.idle();
      expect((readStateFile().wakes as Array<Record<string, unknown>>)[0]?.["until"]).toBe("the lamp is lit");
      await advance(61_000);
      await entity.idle();
      const fired = allRows(entity).find((row) => row.thread === "self" && row.text?.startsWith("Your wake:"));
      expect(fired?.text).toContain("Check the lamp.");
      expect(fired?.text).toContain("the lamp is lit");
    });
  });

  it("W-1: refuses an until longer than 200 characters and keeps no wake", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("schedule_wake", { in_minutes: 5, why: "x", until: "y".repeat(201) }), call("end_turn")] })]);
    const { entity, cli } = await open(model, { stopPollMs: 1e9 });
    await entity.start();
    cli.send("Go.");
    await entity.idle();
    await entity.stop();
    expect(readStateFile().wakes).toHaveLength(0);
  });

  it("W-2: a precheck that says skip lets a body rhythm wake pass with a note and no turn, and the rhythm goes on", async () => {
    await withClock(async (advance) => {
      vi.setSystemTime(Date.parse("2026-10-11T13:59:00Z"));
      const model = new ScriptedModel([]);
      const seen: string[] = [];
      const { entity } = await open(model, {
        stopPollMs: 1e9,
        config: { ...CONFIG, rhythm: ["14:00"] },
        wakePrecheck: (wake) => {
          seen.push(wake.why);
          return "skip";
        },
      });
      await entity.start();
      await advance(61_000);
      await entity.idle();
      expect(model.requests).toHaveLength(0);
      expect(seen).toEqual(["Your daily rhythm."]);
      expect(allRows(entity).some((row) => row.thread === "self" && row.kind === "note" && row.data?.["wakeSkipped"] !== undefined)).toBe(true);
      const wakes = readStateFile().wakes as Array<{ atMs: number }>;
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.atMs).toBe(Date.parse("2026-10-12T14:00:00Z"));
    });
  });

  it("W-2: never asks the precheck about a wake she set herself; it always fires", async () => {
    await withClock(async (advance) => {
      const model = new ScriptedModel([
        reply({ toolCalls: [call("schedule_wake", { in_minutes: 1, why: "Mine." }), call("end_turn")] }),
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      let asked = 0;
      const { entity, cli } = await open(model, { stopPollMs: 1e9, wakePrecheck: () => ((asked += 1), "skip") });
      await entity.start();
      cli.send("Set it.");
      await entity.idle();
      await advance(61_000);
      await entity.idle();
      expect(asked).toBe(0);
      expect(model.requests).toHaveLength(2);
    });
  });

  it("W-2: a precheck that throws lets the wake fire", async () => {
    await withClock(async (advance) => {
      vi.setSystemTime(Date.parse("2026-10-11T13:59:00Z"));
      const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
      const { entity } = await open(model, {
        stopPollMs: 1e9,
        config: { ...CONFIG, rhythm: ["14:00"] },
        wakePrecheck: () => {
          throw new Error("no idea");
        },
      });
      await entity.start();
      await advance(61_000);
      await entity.idle();
      expect(model.requests).toHaveLength(1);
    });
  });
});

describe("turn purpose on the Lar", () => {
  async function oneRoomTurn(extra: Partial<OpenEntityOptions>) {
    const room = emitter("fake");
    const { entity } = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), { stopPollMs: 1e9, ...extra }, [room.world]);
    await entity.start();
    room.emit({ place: "fake:room", text: "Hello." });
    await entity.idle();
    const turns = allRows(entity).filter((row) => row.kind === "turn");
    await entity.stop();
    return { turns, count: (readStateFile() as unknown as { turns?: { count: number } }).turns?.count ?? 0 };
  }

  it("NIT-4: refuses to open an eval Lar with any world but the terminal, so eval cannot lift a live Lar's limit", async () => {
    const room = emitter("fake");
    await expect(open(new ScriptedModel([]), { purpose: "eval" }, [room.world])).rejects.toThrow(/eval/);
  });

  it("an eval Lar stamps eval on its turn rows", async () => {
    const { entity, cli } = await open(new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]), { purpose: "eval" });
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
    const turns = allRows(entity).filter((row) => row.kind === "turn");
    await entity.stop();
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((row) => row.data?.["purpose"] === "eval")).toBe(true);
  });

  it("a live Lar counts its room turn, and its rows read as live", async () => {
    const { turns, count } = await oneRoomTurn({});
    expect(count).toBe(1);
    expect(turns.every((row) => row.data?.["purpose"] === undefined || row.data?.["purpose"] === "live")).toBe(true);
  });
});

describe("the daily rhythm", () => {
  const NOW = Date.parse("2026-10-11T10:00:00Z");
  type RhythmWake = { id: string; atMs: number; why: string; scheduledIn: string; repeat?: string; clock?: string };

  function stateObject(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
  }

  /** Edits a stopped Lar's state.json, the way an older or a hand-made state file would hold it. */
  function editState(edit: (state: Record<string, unknown>) => void): void {
    const state = stateObject();
    edit(state);
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  }

  const RHYTHM_CONFIG = { ...CONFIG, timeZone: "UTC", rhythm: ["09:00", "14:00", "20:00"] };

  it("gives a fresh Lar one daily wake per configured time, in its own thread, once, and says nothing of what it is for", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await entity.start();
    await entity.stop();

    const wakes = readStateFile().wakes as RhythmWake[];
    // One wake per time, in the order the times are listed. The 09:00 has passed for today, so it is tomorrow's.
    expect(wakes).toEqual([
      { id: expect.any(String), atMs: Date.parse("2026-10-12T09:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "09:00", rhythm: true },
      { id: expect.any(String), atMs: Date.parse("2026-10-11T14:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "14:00", rhythm: true },
      { id: expect.any(String), atMs: Date.parse("2026-10-11T20:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "20:00", rhythm: true },
    ]);
    expect(stateObject()["rhythmGiven"]).toBe(true);
    expect(new Set(wakes.map((wake) => wake.id)).size).toBe(3);
  });

  it("is not given again after the Lar cancels its rhythm and starts again", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await entity.start();
    const ids = (readStateFile().wakes as RhythmWake[]).map((wake) => wake.id);
    await entity.stop();
    opened.length = 0;

    const model = new ScriptedModel([
      reply({ toolCalls: ids.map((id, index) => call("cancel_wake", { id }, `c${index}`)) }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const cancelling = await open(model, { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await cancelling.entity.start();
    cancelling.cli.send("Cancel the wakes you were given.");
    await cancelling.entity.idle();
    expect(readStateFile().wakes).toEqual([]);
    await cancelling.entity.stop();
    opened.length = 0;

    const again = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await again.entity.start();
    await again.entity.stop();
    expect(readStateFile().wakes).toEqual([]);
    expect(stateObject()["rhythmGiven"]).toBe(true);
  });

  it("refuses a state file whose rhythmGiven is not true or false, and does not start", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await entity.start();
    await entity.stop();
    opened.length = 0;
    editState((state) => {
      state["rhythmGiven"] = "yes";
    });
    await expect(open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG })).rejects.toThrow(/rhythmGiven/);
  });

  it("gives the rhythm once to a Lar whose state predates the flag, and not again on the next start", async () => {
    const first = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await first.entity.start();
    await first.entity.stop();
    opened.length = 0;
    // The state an older Lar holds: no rhythmGiven flag and no wakes.
    editState((state) => {
      delete state["rhythmGiven"];
    });

    const older = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await older.entity.start();
    await older.entity.stop();
    opened.length = 0;
    const given = readStateFile().wakes as RhythmWake[];
    expect(given.map((wake) => wake.clock)).toEqual(["09:00", "14:00", "20:00"]);
    expect(given.every((wake) => wake.why === "Your daily rhythm." && wake.repeat === "daily")).toBe(true);

    const later = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await later.entity.start();
    await later.entity.stop();
    expect(readStateFile().wakes).toHaveLength(3);
  });

  it("creates no wake when the rhythm is an empty list, and does not record it as given", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await entity.start();
    await entity.stop();
    expect(readStateFile().wakes).toEqual([]);
    expect(stateObject()["rhythmGiven"]).toBeUndefined();
  });

  it("makes only the wakes that fit under the limit, and a body note says how many were not made", async () => {
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await entity.start();
    await entity.stop();
    opened.length = 0;
    const held = Array.from({ length: 98 }, (_, index) => ({
      id: `held${String(index).padStart(4, "0")}`,
      atMs: NOW + (index + 1) * 60_000,
      why: "held",
      scheduledIn: "summoner",
    }));
    editState((state) => {
      delete state["rhythmGiven"];
      state["wakes"] = held;
    });

    const full = await open(new ScriptedModel([]), { nowMs: () => NOW, config: RHYTHM_CONFIG });
    await full.entity.start();
    // The start note the body writes on every start is not the rhythm's note, so it is left out here.
    const notes = allRows(full.entity).filter(
      (row) => row.kind === "note" && row.source === "body" && row.data?.["bodyNote"] !== "start",
    );
    await full.entity.stop();

    const wakes = readStateFile().wakes as RhythmWake[];
    expect(wakes).toHaveLength(100);
    expect(wakes.filter((wake) => wake.why === "Your daily rhythm.").map((wake) => wake.clock)).toEqual(["09:00", "14:00"]);
    expect(notes.map((row) => row.text)).toEqual([
      "1 of 3 daily wakes were not made: 100 wakes is the most you hold at once. Cancel one with cancel_wake to make room.",
    ]);
  });

  it("holds the clock in the Lar's zone across a daylight-saving change, and stores the clock as written", async () => {
    const NEW_YORK = { ...RHYTHM_CONFIG, timeZone: "America/New_York" };
    // 31 October 2026, 08:00 in New York (still daylight time): 09:00 is an hour away.
    const before = await open(new ScriptedModel([]), { nowMs: () => Date.parse("2026-10-31T12:00:00Z"), config: NEW_YORK });
    await before.entity.start();
    await before.entity.stop();
    const wakes = readStateFile().wakes as RhythmWake[];
    const byClock = (clock: string): RhythmWake | undefined => wakes.find((wake) => wake.clock === clock);
    expect(byClock("09:00")?.atMs).toBe(Date.parse("2026-10-31T13:00:00Z"));
    expect(byClock("14:00")?.atMs).toBe(Date.parse("2026-10-31T18:00:00Z"));
    expect(byClock("20:00")?.atMs).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(wakes.every((wake) => wake.repeat === "daily")).toBe(true);
  });

  it("takes the local nine o'clock after the clocks went back, which is 14:00 UTC that day", async () => {
    const after = await open(new ScriptedModel([]), {
      nowMs: () => Date.parse("2026-11-01T12:00:00Z"),
      config: { ...RHYTHM_CONFIG, timeZone: "America/New_York", rhythm: ["09:00"] },
    });
    await after.entity.start();
    await after.entity.stop();
    expect(readStateFile().wakes).toEqual([expect.objectContaining({ clock: "09:00", atMs: Date.parse("2026-11-01T14:00:00Z") })]);
  });

  /** A Lar that took the rhythm before the rhythm flag existed: rhythmGiven true, one 14:00 rhythm wake with no flag. */
  async function legacyLar(extra: (state: Record<string, unknown>) => void = () => {}): Promise<void> {
    const first = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await first.entity.start();
    await first.entity.stop();
    opened.length = 0;
    editState((state) => {
      state["rhythmGiven"] = true;
      delete state["rhythmTagged"];
      state["wakes"] = [
        { id: "legacy1", atMs: Date.parse("2026-10-11T14:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "14:00" },
      ];
      extra(state);
    });
  }

  function setAt(iso: string, extra: Record<string, unknown> = {}): ScriptedModel {
    return new ScriptedModel([reply({ toolCalls: [call("schedule_wake", { at_iso: iso, why: "tea", ...extra }), call("end_turn")] })]);
  }

  it("N1: tags an older Lar's rhythm wakes once, so her wake five minutes after a rhythm time is not moved", async () => {
    await legacyLar();
    const { entity, cli } = await open(setAt("2026-10-11T14:05:00Z"), { nowMs: () => NOW, stopPollMs: 1e9, config: { ...RHYTHM_CONFIG, rhythm: ["14:00"] } });
    await entity.start();
    cli.send("Tea at five past.");
    await entity.idle();
    await entity.stop();
    const wakes = readStateFile().wakes as Array<Record<string, unknown>>;
    expect(wakes.find((wake) => wake["id"] === "legacy1")?.["rhythm"]).toBe(true);
    expect(wakes.find((wake) => wake["why"] === "tea")?.["atMs"]).toBe(Date.parse("2026-10-11T14:05:00Z"));
    expect(stateObject()["rhythmTagged"]).toBe(true);
  });

  it("N1: after the marker, a wake with the rhythm's words is not tagged, so it is still spaced", async () => {
    await legacyLar((state) => {
      state["rhythmTagged"] = true;
    });
    const { entity, cli } = await open(setAt("2026-10-11T14:05:00Z"), { nowMs: () => NOW, stopPollMs: 1e9, config: { ...RHYTHM_CONFIG, rhythm: ["14:00"] } });
    await entity.start();
    cli.send("Tea at five past.");
    await entity.idle();
    await entity.stop();
    const wakes = readStateFile().wakes as Array<Record<string, unknown>>;
    expect(wakes.find((wake) => wake["id"] === "legacy1")?.["rhythm"]).toBeUndefined();
    expect(wakes.find((wake) => wake["why"] === "tea")?.["atMs"] as number).toBeGreaterThanOrEqual(Date.parse("2026-10-11T14:15:00Z"));
  });

  it("N1: does not tag a wake whose clock is not in the configured rhythm", async () => {
    await legacyLar();
    const { entity } = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: ["09:00"] } });
    await entity.start();
    await entity.stop();
    const wakes = readStateFile().wakes as Array<Record<string, unknown>>;
    expect(wakes.find((wake) => wake["id"] === "legacy1")?.["rhythm"]).toBeUndefined();
    expect(stateObject()["rhythmTagged"]).toBe(true);
  });

  it("N2: refuses with no room when every time of day is within 15 minutes of her wakes, and saves nothing", async () => {
    const first = await open(new ScriptedModel([]), { nowMs: () => NOW, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await first.entity.start();
    await first.entity.stop();
    opened.length = 0;
    const many = Array.from({ length: 52 }, (_, i) => {
      const minute = i * 28;
      const clock = `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      return { id: `w${i}`, atMs: Date.parse(`2026-10-12T${clock}:00Z`), why: "x", scheduledIn: "self", repeat: "daily", clock };
    });
    editState((state) => {
      state["wakes"] = many;
    });
    const { entity, cli } = await open(setAt("2026-10-11T12:01:00Z"), { nowMs: () => NOW, stopPollMs: 1e9, config: { ...RHYTHM_CONFIG, rhythm: [] } });
    await entity.start();
    cli.send("One more.");
    await entity.idle();
    const receipt = allRows(entity).filter((row) => row.kind === "receipt").map((row) => row.text).join("\n");
    await entity.stop();
    expect(readStateFile().wakes).toHaveLength(52);
    expect(receipt).toContain("no room");
    expect(receipt).not.toContain("moved to keep");
  });

  it("N3: her wake five minutes after a body rhythm wake is not moved and not held", async () => {
    const { entity, cli } = await open(setAt("2026-10-11T14:05:00Z"), { nowMs: () => NOW, stopPollMs: 1e9, config: { ...RHYTHM_CONFIG, rhythm: ["14:00"] } });
    await entity.start();
    cli.send("Tea.");
    await entity.idle();
    const receipt = allRows(entity).filter((row) => row.kind === "receipt").map((row) => row.text).join("\n");
    await entity.stop();
    const tea = (readStateFile().wakes as Array<Record<string, unknown>>).find((wake) => wake["why"] === "tea");
    expect(tea?.["atMs"]).toBe(Date.parse("2026-10-11T14:05:00Z"));
    expect(receipt).not.toContain("moved to keep");
  });

  it("N3: spaces a one-shot against a daily wake by local time across a daylight-saving change", async () => {
    // New York: the clocks go back on 2026-11-01. A daily 09:00 saved on 10-31 is 13:00 UTC; on 11-02, 09:00 is 14:00 UTC.
    const now = Date.parse("2026-10-31T10:00:00Z");
    const first = await open(new ScriptedModel([]), { nowMs: () => now, config: { ...RHYTHM_CONFIG, timeZone: "America/New_York", rhythm: [] } });
    await first.entity.start();
    await first.entity.stop();
    opened.length = 0;
    editState((state) => {
      state["wakes"] = [{ id: "d1", atMs: Date.parse("2026-10-31T13:00:00Z"), why: "x", scheduledIn: "self", repeat: "daily", clock: "09:00" }];
    });
    const { entity, cli } = await open(setAt("2026-11-02T14:05:00Z"), { nowMs: () => now, stopPollMs: 1e9, config: { ...RHYTHM_CONFIG, timeZone: "America/New_York", rhythm: [] } });
    await entity.start();
    cli.send("Tea.");
    await entity.idle();
    await entity.stop();
    const tea = (readStateFile().wakes as Array<Record<string, unknown>>).find((wake) => wake["why"] === "tea");
    expect(tea?.["atMs"] as number).toBeGreaterThanOrEqual(Date.parse("2026-11-02T14:15:00Z"));
  });
});

describe("no preset rhythm", () => {
  it("gives a Lar whose entity.json names no rhythm no wakes at all", async () => {
    const { entity } = await open(new ScriptedModel([]), { config: { ...CONFIG, rhythm: undefined } });
    await entity.start();
    await entity.stop();
    expect(readStateFile().wakes).toEqual([]);
  });
});

describe("views shrink to briefs", () => {
  /** A world that emits events as a full-view world does: each may name a view key and a brief. */
  function viewWorld(id: string): { world: World; emit(event: WorldEvent): void } {
    let emitter: ((event: WorldEvent) => void) | undefined;
    return {
      world: {
        id,
        async start(next) {
          emitter = next;
        },
        async stop() {
          emitter = undefined;
        },
        async say(): Promise<Receipt> {
          return { ok: true, summary: "Delivered." };
        },
        tools: () => [],
        now: () => `${id} is open.`,
      },
      emit(event) {
        if (emitter === undefined) throw new Error("the view world is not started");
        emitter(event);
      },
    };
  }

  const VIEW_PLACE = "fake:game";

  it("shows only the newest view of a key in full, and the older ones by their brief", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = viewWorld("fake");
    const { entity } = await open(model, {}, [game.world]);
    await entity.start();

    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text one.", view: "game", brief: "Brief one.", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text two.", view: "game", brief: "Brief two.", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text three.", view: "game", brief: "Brief three.", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "A plain line." });
    await entity.idle();

    expect(model.requests).toHaveLength(1);
    const fresh = userTextOf(model.requests[0]).split("New:")[1] ?? "";
    expect(fresh).toContain("Brief one.");
    expect(fresh).toContain("Brief two.");
    expect(fresh).not.toContain("Full text one.");
    expect(fresh).not.toContain("Full text two.");
    expect(fresh).toContain("Full text three.");
    expect(fresh).not.toContain("Brief three.");
    expect(fresh).toContain("A plain line.");
  });

  it("keeps the shrinking across a restart, for views in the recent transcript", async () => {
    const first = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = viewWorld("fake");
    const a = await open(first, {}, [game.world]);
    await a.entity.start();
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text one.", view: "game", brief: "Brief one.", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text two.", view: "game", brief: "Brief two.", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "A plain line." });
    await a.entity.idle();
    await a.entity.stop();

    const second = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const restarted = viewWorld("fake");
    const b = await open(second, {}, [restarted.world]);
    await b.entity.start();
    restarted.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text three.", view: "game", brief: "Brief three." });
    await b.entity.idle();

    expect(second.requests).toHaveLength(1);
    const [recent = "", fresh = ""] = userTextOf(second.requests[0]).split("New:");
    expect(recent).toContain("Brief one.");
    expect(recent).toContain("Brief two.");
    expect(recent).not.toContain("Full text one.");
    expect(recent).not.toContain("Full text two.");
    expect(fresh).toContain("Full text three.");
    expect(fresh).not.toContain("Brief three.");
  });

  it("says an earlier view with no brief as An earlier view, never its full text", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = viewWorld("fake");
    const { entity } = await open(model, {}, [game.world]);
    await entity.start();
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text one.", view: "game", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "Full text two.", view: "game", wake: false });
    game.emit({ world: "fake", place: VIEW_PLACE, source: "outside", text: "A plain line." });
    await entity.idle();

    const fresh = userTextOf(model.requests[0]).split("New:")[1] ?? "";
    expect(fresh).toContain("An earlier view.");
    expect(fresh).not.toContain("Full text one.");
    expect(fresh).toContain("Full text two.");
  });
});

describe("what a turn says it leaves out", () => {
  /** A world whose events the test sends one by one, with or without a wake. */
  function eventWorld(id: string): { world: World; emit(event: WorldEvent): void } {
    let emitter: ((event: WorldEvent) => void) | undefined;
    return {
      world: {
        id,
        async start(next) {
          emitter = next;
        },
        async stop() {
          emitter = undefined;
        },
        async say(): Promise<Receipt> {
          return { ok: true, summary: "Delivered." };
        },
        tools: () => [],
        now: () => `${id} is open.`,
      },
      emit(event) {
        if (emitter === undefined) throw new Error("the event world is not started");
        emitter(event);
      },
    };
  }

  const HALL = "fake:hall";
  const OTHER = "fake:cellar";

  /** Quiet lines that do not wake the Lar, then one line that does, and a second that does: the first turn sees the quiet lines, so the second turn's Recent block holds them. */
  async function twoTurns(quiet: number, cellar: number): Promise<string> {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const hall = eventWorld("fake");
    const { entity } = await open(model, {}, [hall.world]);
    await entity.start();
    for (let i = 1; i <= cellar; i += 1) hall.emit({ world: "fake", place: OTHER, actor: "mara", source: "outside", text: `Cellar ${i}.`, wake: false });
    for (let i = 1; i <= quiet; i += 1) hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: `Quiet line ${i}.`, wake: false });
    hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "First." });
    await entity.idle();
    hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Second." });
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    return userTextOf(model.requests[1]);
  }

  it("says how many older rows of its thread the turn leaves out, before the rows it shows", async () => {
    // 46 rows in the thread: the window starts on a page boundary, so the first ten are left out and 36 are shown.
    const user = await twoTurns(45, 3);
    expect(user).toContain("Recent here:\n(10 older messages here are not shown; recall finds them.)\n[");
    expect(user).toContain("Quiet line 11.");
    expect(user).not.toContain("Quiet line 10.");
    expect(user).not.toContain("Cellar");
    expect(user).toContain("Second.");
  });

  it("leaves nothing out of a thread of thirty-one rows, since the window holds up to thirty-nine", async () => {
    const user = await twoTurns(30, 0);
    expect(user).not.toContain("not shown");
    expect(user).toContain("Quiet line 1.");
  });

  it("says nothing about older rows when the turn shows them all", async () => {
    const user = await twoTurns(3, 2);
    expect(user).not.toContain("not shown");
    expect(user).toContain("Quiet line 1.");
  });
  it("marks a line from a bot, and a line a flood or loop hold kept from waking the Lar", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const hall = eventWorld("fake");
    const { entity } = await open(model, {}, [hall.world]);
    await entity.start();

    hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Hello from a bot.", data: { bot: true }, wake: false });
    hall.emit({
      world: "fake",
      place: HALL,
      actor: "crier",
      source: "outside",
      text: "Held words.",
      data: { bot: true, heldBy: "a burst" },
      wake: false,
    });
    hall.emit({ world: "fake", place: HALL, actor: "tovan", source: "outside", text: "A person speaks." });
    await entity.idle();

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("tovan (outside)] A person speaks.");
    expect(user).toContain("mara (outside) (bot)] Hello from a bot.");
    expect(user).toContain("crier (outside) (bot) (held: a burst)] Held words.");
    expect(user).not.toContain("tovan (outside) (bot)");
  });
});

describe("who is thinking", () => {
  it("names the model and the effort a turn is thought with, in who you are", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const room = fakeWorld("room");
    const { entity } = await open(model, { config: { ...CONFIG, effort: "high" } }, [room.world]);
    await entity.start();
    room.push("room:hall", "Anyone home?");
    await entity.idle();
    expect(systemTextOf(model.requests[0])).toContain("You are thinking with scripted at high effort.");
  });

  it("names the backup and says it is the backup while the main model is held out", async () => {
    const main = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const port = Object.assign(main, {
      routing: () => ({ onBackup: true, backup: "backup-model", backupEffort: "low" as const }),
    });
    const room = fakeWorld("room");
    const { entity } = await open(port, { config: { ...CONFIG, effort: "high" } }, [room.world]);
    await entity.start();
    room.push("room:hall", "Anyone home?");
    await entity.idle();
    expect(systemTextOf(main.requests[0])).toContain(
      "Your main model, scripted, is not answering, so you are thinking with your backup model, backup-model, at low effort: the backup, not your main model.",
    );
  });

  it("names a world's own model and its effort for that world's turns", async () => {
    const main = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const gameModel = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const game = fakeWorld("game");
    const room = fakeWorld("room");
    const { entity } = await open(
      main,
      { config: { ...CONFIG, effort: "high", worldModels: { game: { model: "fast", effort: "low" } } }, worldModels: { game: gameModel } },
      [game.world, room.world],
    );
    await entity.start();
    game.push("game:slot1", "The kettle is boiling.");
    await entity.idle();
    room.push("room:hall", "Anyone home?");
    await entity.idle();
    expect(systemTextOf(gameModel.requests[0])).toContain("You are thinking with fast at low effort.");
    expect(systemTextOf(main.requests[0])).toContain("You are thinking with scripted at high effort.");
  });
});

describe("cache order: the slow sections first, then the rows that change", () => {
  /** A world the test feeds one event at a time. Each event may wake the Lar. */
  function feedWorld(id: string): { world: World; emit(event: WorldEvent): void } {
    let emitter: ((event: WorldEvent) => void) | undefined;
    return {
      world: {
        id,
        async start(next) {
          emitter = next;
        },
        async stop() {
          emitter = undefined;
        },
        async say(): Promise<Receipt> {
          return { ok: true, summary: "Delivered." };
        },
        tools: () => [],
        now: () => `${id} is open.`,
      },
      emit(event) {
        if (emitter === undefined) throw new Error("the feed world is not started");
        emitter(event);
      },
    };
  }

  const HALL = "fake:hall";
  const GAME = "fake:game";

  /** The user message up to the blank line before New: the part that stays the same while a page lasts. */
  function stableOf(user: string): string {
    return user.slice(0, user.indexOf("\n\nNew:"));
  }

  /** The "[clock who] text" lines of the Recent block. */
  function recentRowsOf(user: string): string[] {
    return user
      .slice(user.indexOf("Recent here:"), user.indexOf("\n\nNew:"))
      .split("\n")
      .filter((line) => line.startsWith("["));
  }

  /** The text of every row line in Recent, New and the current view blocks (not the now board or recall). */
  function eventTextsOf(user: string): string[] {
    return user
      .slice(user.indexOf("Recent here:"), user.indexOf("## now"))
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => line.replace(/^\[[^\]]*\] /, ""));
  }

  /**
   * One turn per batch: a batch's rows arrive together, its last row wakes the Lar, and the turn runs before the next batch.
   * `overrides` replaces the text of a row, numbered from 1 across all batches.
   */
  async function runBatches(counts: number[], overrides: Record<number, string> = {}): Promise<{ users: string[]; systems: string[] }> {
    const model = new ScriptedModel(counts.map(() => reply({ toolCalls: [call("end_turn")] })));
    const hall = feedWorld("fake");
    const { entity } = await open(model, {}, [hall.world]);
    await entity.start();
    let n = 0;
    for (const count of counts) {
      for (let i = 1; i <= count; i += 1) {
        n += 1;
        hall.emit({
          world: "fake",
          place: HALL,
          actor: "mara",
          source: "outside",
          text: overrides[n] ?? `Hall line ${n}.`,
          wake: i === count,
        });
      }
      await entity.idle();
    }
    expect(model.requests).toHaveLength(counts.length);
    return { users: model.requests.map(userTextOf), systems: model.requests.map(systemTextOf) };
  }

  it("says a world's line cannot be read, and the turn still runs (CORE3-2)", async () => {
    const broken = feedWorld("broken");
    const world: World = { ...broken.world, now: () => { throw new Error("the read failed"); } };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [world]);
    await entity.start();
    cli.send("Are you there?");
    await entity.idle();
    const user = userTextOf(model.requests[0]);
    expect(user).toContain("- broken: not available right now.");
    expect(user).toContain("Body note: broken could not give its line this turn");
  });

  it("lists the game acts and looks the other threads asked for, with their state, on the board (CORE3-3)", async () => {
    const CLOCK = Date.parse("2026-10-12T09:00:00Z");
    const feed = feedWorld("fake");
    const asked: World = {
      ...feed.world,
      actsNow: () => [
        { thread: GAME, atMs: CLOCK - 5 * 60_000, text: "Boil water (Test kettle): waiting for the game." },
        { thread: GAME, atMs: CLOCK - 2 * 60_000, text: "a fresh look, not answered yet." },
      ],
    };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, { nowMs: () => CLOCK }, [asked]);
    await entity.start();
    feed.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Still there?" });
    await entity.idle();
    const user = userTextOf(model.requests[0]);
    expect(user).toContain("Game acts and looks other threads asked for (last 30 minutes):");
    expect(user).toContain(`- ${GAME}, 5 min ago: Boil water (Test kettle): waiting for the game.`);
    expect(user).toContain(`- ${GAME}, 2 min ago: a fresh look, not answered yet.`);
  });

  it("holds the slow sections in the system text, and puts the new rows before the now board, time and recall", async () => {
    const { users, systems } = await runBatches([40, 1], { 1: "The lighthouse keeper waves.", 41: "The lighthouse lamp is lit." });
    const user = users[1] ?? "";
    const system = systems[1] ?? "";

    let last = -1;
    for (const heading of ["## who you are", "## how you act", "## pictures", "## constitution", "## character", "## your life", "## privacy list", "## index"]) {
      const at = system.indexOf(heading);
      expect(at, heading).toBeGreaterThan(last);
      last = at;
    }
    for (const heading of ["## now", "## time", "## recall"]) expect(system).not.toContain(heading);

    // The order note is fixed text, so it sits in the system text, once.
    expect(system.match(/Each turn's message lists, in this order/g)).toHaveLength(1);
    expect(user.startsWith("Recent here:")).toBe(true);
    const order = ["Recent here:", "New:", "## now", "## time", "## recall"].map((heading) => user.indexOf(heading));
    order.forEach((at, i) => {
      expect(at).toBeGreaterThan(-1);
      if (i > 0) expect(at).toBeGreaterThan(order[i - 1] ?? -1);
    });
    expect(user.slice(user.indexOf("## recall"))).toContain("The lighthouse keeper waves.");
  });

  it("keeps the start of the prompt byte-stable across two turns in one page, when only new rows arrive", async () => {
    const { users, systems } = await runBatches([10, 29, 2]);
    expect(recentRowsOf(users[1] ?? "")).toHaveLength(10);
    expect(recentRowsOf(users[2] ?? "")).toHaveLength(39);
    expect(users[2]?.startsWith(stableOf(users[1] ?? ""))).toBe(true);
    expect(systems[2]).toBe(systems[1]);
  });

  it("changes the start of the prompt at a page boundary, where the oldest shown row moves on by a page", async () => {
    const { users, systems } = await runBatches([10, 29, 2, 1]);
    expect(users[3]?.startsWith(stableOf(users[2] ?? ""))).toBe(false);
    expect(recentRowsOf(users[3] ?? "")).toHaveLength(31);
    expect(users[3]).toContain("Recent here:\n(10 older messages here are not shown; recall finds them.)\n[");
    expect(systems[3]).toBe(systems[2]);
  });

  it("shows every view in Recent by its brief, and the newest full view of a key in its own block after New", async () => {
    const game = feedWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [game.world]);
    await entity.start();
    game.emit({ world: "fake", place: GAME, source: "outside", text: "Full text one.", view: "game", brief: "Brief one.", wake: false });
    game.emit({ world: "fake", place: GAME, source: "outside", text: "Full text two.", view: "game", brief: "Brief two.", wake: false });
    game.emit({ world: "fake", place: GAME, source: "outside", text: "A plain line." });
    await entity.idle();
    game.emit({ world: "fake", place: GAME, source: "outside", text: "A second plain line." });
    await entity.idle();

    const user = userTextOf(model.requests[1]);
    const recent = user.slice(user.indexOf("Recent here:"), user.indexOf("\n\nNew:"));
    expect(recent).toContain("Brief one.");
    expect(recent).toContain("Brief two.");
    expect(recent).not.toContain("Full text two.");

    const at = user.indexOf("Current view of the game, seen at");
    expect(at).toBeGreaterThan(user.indexOf("New:"));
    expect(at).toBeLessThan(user.indexOf("## now"));
    const block = user.slice(at, user.indexOf("## now"));
    expect(block).toContain("Full text two.");
    expect(block).not.toContain("Brief two.");
    expect(user.split("Full text two.")).toHaveLength(2);
  });

  it("gives a thread that holds an old copy of a view the newest view of that game, and says it is newer than the one in its rows", async () => {
    const world = feedWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [world.world]);
    await entity.start();
    world.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "An old copy of the view.", view: "game", brief: "Old view brief.", wake: false });
    world.emit({ world: "fake", place: GAME, source: "outside", text: "The newest full view.", view: "game", brief: "Newest view brief.", wake: false });
    world.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Still there?" });
    await entity.idle();

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("Old view brief.");
    expect(user).not.toContain("An old copy of the view.");
    const at = user.indexOf("Current view of the game, newer than the one in your rows, seen at");
    expect(at).toBeGreaterThan(user.indexOf("New:"));
    expect(user.slice(at, user.indexOf("## now"))).toContain("The newest full view.");
    expect(user.split("The newest full view.")).toHaveLength(2);
  });

  it("finds the newest view of a key past a page of other rows", async () => {
    const world = feedWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [world.world]);
    await entity.start();
    world.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "An old copy of the view.", view: "game", brief: "Old view brief.", wake: false });
    world.emit({ world: "fake", place: GAME, source: "outside", text: "The newest full view.", view: "game", brief: "Newest view brief.", wake: false });
    for (let i = 1; i <= 600; i += 1) world.emit({ world: "fake", place: GAME, source: "outside", text: `Game line ${i}.`, wake: false });
    world.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Still there?" });
    await entity.idle();

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("Current view of the game, newer than the one in your rows, seen at");
    expect(user).toContain("The newest full view.");
  });

  it("shows the same words as the old layout, the only addition being the brief of the newest view that now sits in its block", async () => {
    const game = feedWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [game.world]);
    await entity.start();
    game.emit({ world: "fake", place: GAME, source: "outside", text: "Full text one.", view: "game", brief: "Brief one.", wake: false });
    game.emit({ world: "fake", place: GAME, source: "outside", text: "Full text two.", view: "game", brief: "Brief two.", wake: false });
    game.emit({ world: "fake", place: GAME, source: "outside", text: "A plain line." });
    await entity.idle();
    game.emit({ world: "fake", place: GAME, source: "outside", text: "A second plain line." });
    await entity.idle();

    // The old layout showed the newest view of the key in full inside Recent: that is "Full text two." here.
    const oldLayout = ["A plain line.", "A second plain line.", "Brief one.", "Full text two."];
    expect(eventTextsOf(userTextOf(model.requests[1])).sort()).toEqual([...oldLayout, "Brief two."].sort());
  });

  it("gives a plain thread the same rows as before while it holds up to thirty", async () => {
    const { users } = await runBatches([12, 18]);
    expect(eventTextsOf(users[1] ?? "").sort()).toEqual(Array.from({ length: 30 }, (_, i) => `Hall line ${i + 1}.`).sort());
    expect(users[1]).not.toContain("not shown");
  });

  it("writes one call row per model call, with counts and names and no words", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("A sentence the witness must never keep.");
    await entity.idle();

    const rows = readCallLedger(join(dir, "river.db"), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ threadKind: "summoner", turnCall: 1, marks: 0 });
    expect(rows[0]?.promptChars).toBeGreaterThan(0);
    expect(rows[0]?.partSizes["who you are"]).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("never keep");
  });

  it("gives the system text and the user message named parts, with the classes in order", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const hall = feedWorld("fake");
    const { entity } = await open(model, {}, [hall.world]);
    await entity.start();
    hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: "Hello.", wake: true });
    await entity.idle();

    const messages = model.requests[0]?.messages ?? [];
    const system = messages[0];
    const user = messages.at(-1);
    expect(system?.role === "system" && system.layout?.map((entry) => entry.name)).toContain("who you are");
    expect(user?.role === "user" && user.layout?.map((entry) => entry.name)).toContain("new");
    for (const message of [system, user]) {
      const ranks = (message?.role === "system" || message?.role === "user" ? message.layout ?? [] : []).map((entry) => CLASS_RANK[entry.cls]);
      expect(ranks.length, message?.role).toBeGreaterThan(0);
      expect(ranks, message?.role).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  // The class honesty test (cache-layer.md, L1): each kind of change renders two requests, and every part of a class slower
  // than the change must be byte-identical between them. A part that changes faster than its class fails and is named.
  it("keeps every part of a slower class byte-identical across each kind of change", async () => {
    const DAY = 86_400_000;
    let now = Date.UTC(2026, 9, 11, 9, 0);
    const hall = feedWorld("fake");
    const model = new ScriptedModel(Array.from({ length: 7 }, () => reply({ toolCalls: [call("end_turn")] })));
    const { entity } = await open(model, { nowMs: () => now }, [hall.world]);
    await entity.start();
    let n = 0;
    const batch = async (count: number): Promise<void> => {
      for (let i = 1; i <= count; i += 1) {
        n += 1;
        hall.emit({ world: "fake", place: HALL, actor: "mara", source: "outside", text: `Honesty line ${n}.`, wake: i === count });
      }
      await entity.idle();
    };
    await batch(50); // turn 0: no recent rows yet
    await batch(1); // turn 1: a page of recent rows starts at row 10 (the window holds 40 rows)
    await batch(1); // turn 2: only new rows, inside the page
    now += DAY;
    await batch(1); // turn 3: the clock steps a day
    await setLife(entity, "I moved to a new town and the harbour is quiet now.");
    await batch(1); // turn 4: a note write
    await batch(7); // turn 5: a batch of new rows
    await batch(1); // turn 6: the page moves on by ten rows

    const parts = (index: number): MessagePart[] => partsOfRequest(model.requests[index]);
    expect(parts(1).some((part) => part.cls === "page")).toBe(true);
    const steps: Array<{ label: string; before: number; after: number; change: "turn" | "notes" | "page" }> = [
      { label: "new rows inside one page", before: 1, after: 2, change: "turn" },
      // A day step dates the older lines (when.ts), so the page may change once a day; nothing slower does.
      { label: "a clock step of a day", before: 2, after: 3, change: "page" },
      { label: "a note write", before: 3, after: 4, change: "notes" },
      { label: "a batch of new rows", before: 4, after: 5, change: "turn" },
      { label: "a page step", before: 5, after: 6, change: "page" },
    ];
    for (const step of steps) {
      expect(changedBeyond(parts(step.before), parts(step.after), step.change), step.label).toEqual([]);
    }
    // The checker can fail: a fixed part that changes on a turn is named.
    const broken = parts(1).map((part) => (part.cls === "fixed" ? { ...part, text: `${part.text} changed` } : part));
    expect(changedBeyond(parts(1), broken, "turn")).toContain("who you are");
  });
});

/** The parts of one request, system then user, as the honesty check reads them. */
function partsOfRequest(request: ModelRequest | undefined): MessagePart[] {
  return (request?.messages ?? []).flatMap((message) =>
    (message.role === "system" || (message.role === "user" && message.layout !== undefined)) ? partsOfMessage(message) : [],
  );
}

describe("a resting world's tools", () => {
  function restingRoom(): ReturnType<typeof fakeWorld> {
    const room = fakeWorld("fake");
    const poke: Tool = {
      spec: { name: "poke", description: "The poke tool.", parameters: { type: "object", properties: {} } },
      run: async () => ({ ok: true, summary: "ran poke" }),
    };
    return { ...room, world: { ...room.world, tools: () => [poke], resting: () => true } };
  }
  const names = (request: ModelRequest | undefined) => (request?.tools ?? []).map((spec) => spec.name);

  it("are left out of a turn in another thread, and the now board says so", async () => {
    const room = restingRoom();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    cli.send("Hello, Iris.");
    await entity.idle();

    expect(names(model.requests[0])).not.toContain("poke");
    expect(names(model.requests[0])).toContain("end_turn");
    expect(userTextOf(model.requests[0])).toContain(
      "- fake: fake is open. Its tools are left out of this turn until it can act again.",
    );
  });

  it("stay in a turn in that world's own thread", async () => {
    const room = restingRoom();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [room.world]);
    await entity.start();

    room.push("fake:room", "A passer-by says hi.");
    await entity.idle();

    expect(names(model.requests[0])).toContain("poke");
    expect(userTextOf(model.requests[0])).not.toContain("Its tools are left out of this turn");
  });
});

describe("messages that come in during a turn", () => {
  const lastUserText = (request: ModelRequest | undefined): string => {
    const last = request?.messages.at(-1);
    return last?.role === "user" ? last.content : "";
  };

  it("are shown on the turn's next call: this thread's in full, another thread's as a count, and New shows them again next turn", async () => {
    const room = fakeWorld("fake");
    let cli: CliWorld | undefined;
    const model = new ScriptedModel([
      async () => {
        cli?.send("One more thing, while you think.");
        room.push("fake:room", "A passer-by says hi.");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Got it." })] });
      },
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const opened = await open(model, {}, [room.world]);
    cli = opened.cli;
    await opened.entity.start();

    cli.send("Hello, Iris.");
    await opened.entity.idle();

    // The room's turn runs beside this one, so the calls are found by what they show, not by their order.
    const tails = model.requests.map(lastUserText);
    expect(tails[0]).not.toContain("since this turn began");
    expect(tails.filter((tail) => tail.includes("since this turn began"))).toHaveLength(1);
    const second = tails.find((tail) => tail.includes("since this turn began")) ?? "";
    expect(second).toContain("New here since this turn began:");
    expect(second).toContain("One more thing, while you think.");
    expect(second).toContain("New elsewhere since this turn began: fake:room (1 message). Each place gets its own turn after this one.");
    expect(second).not.toContain("A passer-by says hi.");
    // The next turn here shows the message again under New.
    expect(userTextOf(model.requests.at(-1))).toMatch(/New:[^]*One more thing, while you think\./);
  });
});

describe("private/ notes outside the summoner's place", () => {
  it("leaves private/ out of the index in a room turn and keeps it in the summoner's", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const room = fakeWorld("fake");
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.notebook.write("private/close.md", "A kept thing.\n", "Keep it close", "body");
    await entity.start();
    room.push("fake:room", "Hello, room.");
    await entity.idle();
    cli.send("Hello.");
    await entity.idle();
    expect(systemTextOf(model.requests[0])).not.toContain("private/close.md");
    expect(systemTextOf(model.requests[1])).toContain("private/close.md");
  });
});

describe("round 8 (N1)", () => {
  it("a cut turn's outcome-unknown receipt reads 'outcome unknown ... check before doing it again' on the retry", async () => {
    const world = fakeWorld("web");
    const unknownTool: Tool = {
      spec: { name: "post_slow", description: "Posts slowly.", parameters: { type: "object", properties: {} } },
      async run(): Promise<Receipt> {
        return { ok: false, summary: "The turn ran past its time limit.", refused: { code: "outcome_unknown", reason: "turn deadline" } };
      },
    };
    world.world.tools = () => [unknownTool];
    const model = new ScriptedModel([
      reply({ toolCalls: [call("post_slow", {}, "c1")] }),
      new ModelError("The model service is down.", "unavailable", 1),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { retryDelaysMs: [5] }, [world.world]);
    await entity.start();
    cli.send("Post it?");
    await entity.idle();
    expect(model.requests).toHaveLength(3);
    expect(userTextOf(model.requests[2])).toContain("post_slow {}: outcome unknown, it may have finished after the cut: check before doing it again");
  });
});
