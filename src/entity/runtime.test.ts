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
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld, type CliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { forgetInStateFile, openEntity, STATE_FILE, type Entity, type OpenEntityOptions } from "./runtime.js";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const system = systemTextOf(model.requests[1]);
    expect(system).toContain("Open asks");
    // Two messages wait in one place: two asks in the state, one line on the board.
    expect(readStateFile().asks).toHaveLength(2);
    expect(system.match(/- cli:summoner, asked/g)).toHaveLength(1);
    expect(system).toContain("(2 messages waiting)");
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
    expect(said).toEqual([{ place: "cli:summoner", text: "I am here, Mira." }]);
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

    expect(said).toEqual([{ place: "cli:summoner", text: "On my way." }]);
    expect(readStateFile().wakes).toHaveLength(1);
    const retry = userTextOf(model.requests[2]);
    expect(retry).toContain("Already done");
    expect(retry).toContain("On my way.");
    expect(retry).toContain("check the kettle");
    expect(retry).toContain("owner] Are you coming?");
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
    const model = new ScriptedModel([
      reply({ toolCalls: [call("schedule_wake", { in_minutes: 0.01, why: "look at the garden" })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Remind yourself to look at the garden later.");
    await waitFor(() => model.requests.length >= 3);
    await entity.idle();

    expect(userTextOf(model.requests[2])).toContain("Your wake: look at the garden");
    const wake = allRows(entity).find((row) => row.thread === "self" && row.kind === "event");
    expect(wake).toMatchObject({ source: "body", text: "Your wake: look at the garden" });
    expect(readStateFile().wakes).toHaveLength(0);
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

    expect(systemTextOf(model.requests[2])).toContain("Your mood: quiet and curious.");
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

    const system = systemTextOf(model.requests[2]);
    expect(system).toContain("- cli:summoner, ");
    expect(system).toContain('last said: "Hello from the command line."');
    expect(system).toContain("- fake: fake is open.");
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

    const system = systemTextOf(model.requests[1]);
    expect(system).toContain("## recall");
    expect(system).toContain("fake:room mara] The lighthouse at the point is my favourite place.");
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
    expect(system).toContain("Body note: nature.md could not be read (the file could not be read), so the default nature is in use.");
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
    expect(system).toContain("Body note: your summoner's privacy list cannot be read, so nothing leaves until it is fixed");
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
    const board = systemTextOf(model.requests[2]);
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
        const key = userTextOf(request).includes("Say hello in the room.") ? "summoner" : "room";
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
    expect(String((held?.["refused"] as { reason: string }).reason)).toContain('"Hello from the room."');
    expect(String((held?.["refused"] as { reason: string }).reason)).toContain("knowingly: true");
    expect(receipts.filter((item) => (item["refused"] as { code?: string } | undefined)?.code === "spoken_meanwhile")).toHaveLength(1);
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
        const key = userTextOf(request).includes("Say hello in the room.") ? "summoner" : "room";
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
    expect(systemTextOf(model.requests[0])).toContain(
      "EMERGENCY STOP: your summoner has paused outward acts: Too much noise.",
    );

    unlinkSync(file);
    cli.send("Second.");
    await entity.idle();
    expect(systemTextOf(model.requests[1])).not.toContain("EMERGENCY STOP");

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
    const board = systemTextOf(model.requests[2]);
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
    expect(systemTextOf(model.requests[0])).not.toContain("example.org");

    cli.send("Hello.");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expect(systemTextOf(model.requests[1])).toContain("example.org");
  });

  it("says how many older acts the board left out when more than twenty wait", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();

    for (let n = 1; n <= 22; n += 1) cli.send(`!vault remove gate-${n}`);
    await entity.idle();
    cli.send("Hello.");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(system).toContain("gate-22");
    expect(system).not.toContain("gate-1,");
    expect(system).toContain("- 2 older ones were left out.");
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
    expect(first).toContain("Your summoner did these since your last turn (body notes):");
    expect(first).toContain("Your summoner added a line to your household note: Mara grows beans.");
    expect(first).toContain("- Mara grows beans.");

    cli.send("Hello again.");
    await entity.idle();
    expect(systemTextOf(model.requests[1])).not.toContain("Your summoner did these since your last turn");
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
    expect(systemTextOf(model.requests[2])).toContain(
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
});

describe("the daily turn limit", () => {
  it("holds turns past the limit until the next local day, tells each waiting place once a day, then runs them", async () => {
    let now = Date.parse("2026-10-11T10:00:00Z");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(model, {
      config: { ...CONFIG, limits: { turnsPerDay: 1 } },
      nowMs: () => now,
    });
    await entity.start();

    cli.send("First.");
    await entity.idle();
    expect(model.requests).toHaveLength(1);
    expect(systemTextOf(model.requests[0])).toContain("Turns today: 1 of 1.");

    now += 60_000;
    cli.send("Second.");
    await entity.idle();
    now += 60_000;
    cli.send("Third.");
    await entity.idle();
    expect(model.requests).toHaveLength(1);
    expect(said.map((item) => item.text)).toEqual([
      "[natalis] Your Lar has reached today's limit of 1 turn and will see this after midnight (UTC).",
    ]);
    expect(readStateJson().asks).toHaveLength(3);

    now = Date.parse("2026-10-12T00:05:00Z");
    cli.send("Fourth.");
    await entity.idle();
    expect(model.requests).toHaveLength(2);
    expect(userTextOf(model.requests[1])).toContain("Second.");
    expect(userTextOf(model.requests[1])).toContain("Fourth.");
    expect(systemTextOf(model.requests[1])).toContain("Turns today: 1 of 1.");
  });

  it("tells only the summoner's own places about the limit, never a room where a message waits", async () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    let emitRoom: ((event: WorldEvent) => void) | undefined;
    const roomSaid: string[] = [];
    const room: World = {
      id: "fake",
      async start(next) {
        emitRoom = next;
      },
      async stop() {
        emitRoom = undefined;
      },
      async say(_place, text): Promise<Receipt> {
        roomSaid.push(text);
        return { ok: true, summary: "Delivered." };
      },
      tools: () => [],
      now: () => "fake is open.",
    };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(
      model,
      { config: { ...CONFIG, limits: { turnsPerDay: 1 } }, nowMs: () => now },
      [room],
    );
    await entity.start();

    emitRoom?.({ world: "fake", place: "fake:room", actor: "owner", source: "owner", text: "Room hello." });
    await entity.idle();
    cli.send("Second.");
    await entity.idle();

    expect(roomSaid).toEqual([]);
    expect(said.map((item) => item.text)).toEqual([
      "[natalis] Your Lar has reached today's limit of 1 turn and will see this after midnight (UTC).",
    ]);
  });

  it("tells no place about the limit while the emergency stop is on, and tells once the stop is off", async () => {
    let now = Date.parse("2026-10-11T10:00:00Z");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli, said } = await open(model, {
      config: { ...CONFIG, limits: { turnsPerDay: 1 } },
      nowMs: () => now,
    });
    await entity.start();

    cli.send("First.");
    await entity.idle();
    writeFileSync(join(dir, "STOP"), "", "utf8");
    now += 60_000;
    cli.send("Second.");
    await entity.idle();
    expect(said).toEqual([]);

    rmSync(join(dir, "STOP"));
    now += 60_000;
    cli.send("Third.");
    await entity.idle();
    expect(said.map((item) => item.text)).toEqual([
      "[natalis] Your Lar has reached today's limit of 1 turn and will see this after midnight (UTC).",
    ]);
  });

  it("holds a wake that comes due during the limit, and runs it with the next day's turns", async () => {
    let now = Date.parse("2026-10-11T10:00:00Z");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("schedule_wake", { in_minutes: 0, why: "Check the lamp." }, "w1")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {
      config: { ...CONFIG, limits: { turnsPerDay: 1 } },
      nowMs: () => now,
    });
    await entity.start();

    cli.send("Remind yourself about the lamp.");
    await entity.idle();
    await waitFor(() => allRows(entity).some((row) => row.thread === "self" && row.text?.startsWith("Your wake:")));
    await entity.idle();
    expect(model.requests).toHaveLength(2);

    now = Date.parse("2026-10-12T00:05:00Z");
    cli.send("Tomorrow.");
    await entity.idle();
    expect(model.requests).toHaveLength(4);
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
    expect(systemTextOf(model.requests[2])).toContain("Next wakes: 09:00 daily (next 2026-10-12 09:00): look at the garden.");
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
    const { entity, cli } = await open(model, { config: { ...CONFIG, timeZone: "America/New_York" } });
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
      { id: expect.any(String), atMs: Date.parse("2026-10-12T09:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "09:00" },
      { id: expect.any(String), atMs: Date.parse("2026-10-11T14:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "14:00" },
      { id: expect.any(String), atMs: Date.parse("2026-10-11T20:00:00Z"), why: "Your daily rhythm.", scheduledIn: "self", repeat: "daily", clock: "20:00" },
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
    const notes = allRows(full.entity).filter((row) => row.kind === "note" && row.source === "body");
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
