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
import { openEntity, type Entity, type OpenEntityOptions } from "./runtime.js";

// The fake credential is built from parts at run time, so no token-shaped literal sits in the source.
const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
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
    expect(entity.notebook.read("self/constitution.md")).toContain("# Constitution");
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
    // The river came back too: what she said before the restart is in the recent transcript now.
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
});

describe("what she sends and what she is shown", () => {
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

  it("shows her mood on the now board", async () => {
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

  it("lists another active thread on the now board with what she last said there", async () => {
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

  it("does not hold the same words when they are said to her owner", async () => {
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

  it("shows her the categories in a privacy section, never the words", async () => {
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

  it("treats a privacy file that is not JSON as empty, and says so on the now board", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "privacy.json"), "{ not json", "utf8");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    cli.send("Hello?");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(system).toContain("Body note: the privacy list could not be read");
    expect(system).toContain("No categories are on the list right now.");
  });

  it("reloads the list when the file changes while she runs", async () => {
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

describe("the honesty check on her life record", () => {
  it("asks the model once, with low effort and no tools, when her life record has real content", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the bakery." })] }),
      honestyReply(false),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model, {}, [room.world]);
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

  it("holds a say that her record contradicts, quotes both sides, and sends nothing", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      honestyReply(true, "I work at the lighthouse", "I work at the bakery"),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
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

  it("sends a contradicting say when she says it knowingly, and skips the check for that say only", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse.", knowingly: true })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
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
    const { entity, cli, said } = await open(model);
    await entity.start();
    cli.send("Hi.");
    await entity.idle();

    expect(said).toEqual([]);
    const refused = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === false);
    expect(refused).toMatchObject({ refused: { code: "bad_arguments" } });
  });

  it("checks a say to an outside place as well as one to her owner", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "I work at the lighthouse." })] }),
      honestyReply(true, "I work at the lighthouse", "I work at the bakery"),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, {}, [room.world]);
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
    const { entity, cli, said } = await open(model);
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
    const { entity, cli, said } = await open(model);
    await entity.start();
    await setLife(entity, LIFE_TEXT);

    cli.send("Where do you work?");
    await entity.idle();

    expect(said).toHaveLength(1);
    expect(noteRows(entity).map((row) => row.text)).toContain("honesty check could not run: the reply was not JSON");
  });

  it("does not ask while her life record is still the stub", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli, said } = await open(model);
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

describe("the owner's emergency stop", () => {
  it("refuses outward acts while STOP is there, and still answers her owner", async () => {
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
    // The rows wait for her next turn in her own thread; they never wake a turn by themselves.
    expect(model.requests).toHaveLength(2);
  });
});
