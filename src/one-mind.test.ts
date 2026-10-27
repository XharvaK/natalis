// The one-mind invariants, asserted directly. The paper's B2 U14: one river writer, L1, the folder lock and its
// holders, the copy guard, the say-hold per place, no new RiverKind, body notices kept apart from her says, and no
// model-written text in her context except her own turns. Each test is small on purpose; docs/one-mind.md names the
// deeper test that guards each rule too.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelError,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type Receipt,
  type RiverKind,
  type RiverRow,
  type World,
  type WorldEvent,
} from "./contracts.js";
import { runCommand } from "./bin/commands/run.js";
import type { EntityConfig } from "./entity/config.js";
import { checkCopyGuard, FOLDER_MOVED_MESSAGE, folderHash } from "./entity/copy-guard.js";
import { acquireLarLock, LAR_LOCK_BUSY_MESSAGE, LarLockBusy } from "./entity/lar-lock.js";
import { type Entity, openEntity, type OpenEntityOptions } from "./entity/runtime.js";
import { runTurn } from "./loop/run-turn.js";
import { RiverError, openRiver } from "./river/sqlite-river.js";
import { MemoryNotebook } from "./testing/memory-notebook.js";
import { MemoryRiver } from "./testing/memory-river.js";
import { ScriptedModel, call, reply } from "./testing/scripted-model.js";
import { createCliWorld, type CliWorld } from "./worlds/cli.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};
const HONEST: EntityConfig = { ...CONFIG, holds: { honesty: true } };

let templateRoot: string;
let templateNotebook: string;
let root: string;
let dir: string;
const opened: Entity[] = [];

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-one-mind-template-"));
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
  root = mkdtempSync(join(tmpdir(), "natalis-one-mind-"));
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
): Promise<Opened> {
  if (!existsSync(join(dir, "notebook"))) {
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets queued microtasks run on a fake clock. */
async function flush(advance: (ms: number) => Promise<void>, times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await advance(0);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Runs a test on the same fake clock the runtime tests use, and stops every entity before the clock goes back. */
async function withClock<T>(run: (advance: (ms: number) => Promise<void>) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  try {
    return await run((ms) => vi.advanceTimersByTimeAsync(ms));
  } finally {
    await Promise.allSettled(opened.map((entity) => entity.stop()));
    vi.useRealTimers();
  }
}

function stopped(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new ModelError("The request was aborted.", "aborted", 1));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

/** The scheduler's private turn queue, reached the way the runtime tests reach it. */
type SchedulerSeam = { queueReflectTurn(thread: string): void };

function schedulerOf(entity: Entity): SchedulerSeam {
  return entity as unknown as SchedulerSeam;
}

/** An event row written straight to the river, so the test's own turn takes it. */
function appendEventRow(entity: Entity, thread: string, text: string): void {
  entity.river.append({ kind: "event", thread, place: thread, source: "outside", text, atMs: Date.now() });
}

function eventTextOf(request: ModelRequest | undefined): string {
  const message = request?.messages.find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

function receiptsShownIn(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  return (request?.messages ?? []).flatMap((message) => {
    if (message.role !== "tool") return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });
}

function endRow(entity: Entity, thread: string): RiverRow | undefined {
  return allRows(entity).find(
    (row) => row.kind === "turn" && row.thread === thread && row.data?.["phase"] === "end",
  );
}

// ---------------------------------------------------------------------------------------------------
// 1. One river writer. The folder lock is taken before the river opens; a second holder writes nothing.

describe("one river writer", () => {
  it("one river writer: a second holder writes no river row", async () => {
    const folder = join(root, "one-writer");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "entity.json"),
      JSON.stringify({
        model: { baseUrl: "https://model.example.invalid/v1", model: "test-model", contextTokens: 1_000 },
        summoner: { alias: "Mara" },
      }),
      "utf8",
    );

    const lock = acquireLarLock(folder);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCommand(["--dir", folder], (line) => out.push(line), (line) => err.push(line));
      expect(code).toBe(1);
      expect(err).toEqual([LAR_LOCK_BUSY_MESSAGE]);
      // The refused start never opened the river or wrote its state: one writer, and it is the holder.
      expect(existsSync(join(folder, "river.db"))).toBe(false);
      expect(existsSync(join(folder, "state.json"))).toBe(false);
    } finally {
      lock.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. L1. A reflect turn starts only when no turn runs anywhere; the summoner pre-empts one.

describe("L1: non-live turns", () => {
  it("L1: a reflect turn starts only after the running live turn ends", async () => {
    await withClock(async (advance) => {
      const liveStarted = deferred();
      const liveDone = deferred();
      const model = new ScriptedModel([
        async (_request, signal) => {
          liveStarted.resolve();
          await Promise.race([liveDone.promise, stopped(signal)]);
          return reply({ toolCalls: [call("end_turn")] });
        },
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const room = sourceWorld("fake");
      const { entity } = await open(model, { stopPollMs: 1e9 }, [room.world]);
      await entity.start();

      room.push("fake:room", "A live message.");
      await liveStarted.promise;
      appendEventRow(entity, "self", "Think about this on your own.");
      schedulerOf(entity).queueReflectTurn("self");
      await flush(advance);

      expect(model.requests).toHaveLength(1);
      const started = allRows(entity).filter((row) => row.kind === "turn" && row.data?.["phase"] === "start");
      expect(started.map((row) => row.thread)).toEqual(["fake:room"]);

      liveDone.resolve();
      await flush(advance);

      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.thread).toBe("self");
      const after = allRows(entity).filter((row) => row.kind === "turn" && row.data?.["phase"] === "start");
      expect(after.map((row) => row.thread)).toEqual(["fake:room", "self"]);
      expect(after[1]?.data?.["purpose"]).toBe("reflect");
      await entity.idle();
    });
  });

  it("L1: a summoner event pre-empts a running reflect turn", async () => {
    await withClock(async (advance) => {
      const reflectStarted = deferred();
      const model = new ScriptedModel([
        async (_request, signal) => {
          reflectStarted.resolve();
          return await new Promise<ModelResponse>((_resolve, reject) => {
            const fail = (): void => reject(new ModelError("The request was aborted.", "aborted", 1));
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
        },
        reply({ toolCalls: [call("end_turn")] }),
      ]);
      const { entity, cli } = await open(model, { stopPollMs: 1e9 });
      await entity.start();

      appendEventRow(entity, "self", "Think about this on your own.");
      schedulerOf(entity).queueReflectTurn("self");
      await reflectStarted.promise;

      cli.send("Answer me now.");
      await flush(advance);

      expect(model.requests.map((request) => request.thread)).toEqual(["self", "cli:summoner"]);
      expect(endRow(entity, "self")?.data?.["endedBy"]).toBe("aborted");
      expect(endRow(entity, "cli:summoner")?.data?.["endedBy"]).toBe("end_turn");
      await entity.idle();
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. The Lar folder lock and its holders.

const HOLDER_FILES = [
  "src/bin/commands/run.ts",
  "src/bin/commands/forget.ts",
  "src/bin/commands/restore.ts",
  "src/bin/commands/notebook-restore.ts",
  "src/bin/commands/import.ts",
  "src/bin/commands/vault.ts",
] as const;

describe("the Lar folder lock and its holders", () => {
  it("the folder lock has one holder, and every writer command takes it", () => {
    const folder = join(root, "lock-holder");
    mkdirSync(folder, { recursive: true });
    const lock = acquireLarLock(folder);
    try {
      expect(() => acquireLarLock(folder)).toThrow(LarLockBusy);
    } finally {
      lock.release();
    }

    for (const relative of HOLDER_FILES) {
      const source = readFileSync(join(REPO, relative), "utf8");
      expect(source, `${relative} must take the Lar folder lock`).toContain("acquireLarLock(");
    }

    // run takes the lock before it opens the Lar, and serves a keep through the vault queue while it holds it.
    const run = readFileSync(join(REPO, "src/bin/commands/run.ts"), "utf8");
    expect(run.indexOf("acquireLarLock(")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("acquireLarLock(")).toBeLessThan(run.indexOf("openEntity("));
    expect(run).toContain("startVaultChannel(");
    // A keep that cannot take the lock hands the value to the running Lar's channel instead of writing the folder.
    expect(readFileSync(join(REPO, "src/bin/commands/vault.ts"), "utf8")).toContain("openVaultChannel(");
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. The copy guard.

describe("the copy guard", () => {
  it("the copy guard keeps the recorded folder and refuses another", () => {
    const machine = "test-machine";
    const here = join(root, "here");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(here, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });

    const recorded = folderHash(here, machine);
    expect(checkCopyGuard({ dir: here, recorded, machine })).toEqual({ action: "keep", folderHash: recorded });
    expect(checkCopyGuard({ dir: elsewhere, recorded, machine })).toEqual({
      action: "refuse",
      message: FOLDER_MOVED_MESSAGE,
    });
    // The owner may say the folder moved on purpose; only then is the new place recorded.
    expect(checkCopyGuard({ dir: elsewhere, recorded, moved: true, machine })).toEqual({
      action: "record",
      folderHash: folderHash(elsewhere, machine),
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. The say-hold per place.

describe("the say-hold per place", () => {
  it("the say-hold per place lets two racing threads send once", async () => {
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
    // The room's turn begins while the summoner's send is still in flight: the race the place lock settles.
    if (emit === undefined) throw new Error("the fake world is not started");
    emit({ world: "fake", place: "fake:room", actor: "mara", source: "outside", text: "A passer-by asks a question." });
    await roomTurnBegun.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reachedWorld = said.length;
    gate.resolve();
    await entity.idle();

    expect(reachedWorld).toBe(1);
    expect(said).toEqual(["Hello from the summoner's side."]);
    const receipts = receiptsShownIn(requests.filter((item) => item.key === "room").at(-1)?.request);
    const held = receipts.find((item) => (item["refused"] as { code?: string } | undefined)?.code === "spoken_meanwhile");
    expect(held).toMatchObject({ ok: false, refused: { code: "spoken_meanwhile" } });
  });
});

// ---------------------------------------------------------------------------------------------------
// 6. No new RiverKind.

describe("no new RiverKind", () => {
  it("no new river kind: the contract's list is the known seven and the river refuses any other", () => {
    const contracts = readFileSync(join(REPO, "src/contracts.ts"), "utf8");
    const block = /export type RiverKind =([\s\S]*?);/.exec(contracts)?.[1] ?? "";
    const kinds = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    const known = ["event", "say", "tool_call", "receipt", "turn", "note", "tombstone"];
    expect(kinds).toHaveLength(known.length);
    expect([...kinds].sort()).toEqual([...known].sort());

    const river = openRiver(":memory:");
    try {
      for (const kind of ["event", "say", "tool_call", "receipt", "turn", "note"] as const) {
        river.append({
          thread: "self",
          kind,
          source: kind === "event" ? "outside" : "body",
          text: `${kind} row`,
        });
      }
      // A tombstone is written only by forget, never appended directly.
      river.forget({ seqs: [1] }, "owner", "the one-mind test");
      expect([...new Set(river.read({ limit: 100 }).map((row) => row.kind))].sort()).toEqual([...known].sort());
      expect(() =>
        river.append({ thread: "self", kind: "gossip" as RiverKind, source: "body", text: "new kind" }),
      ).toThrow(RiverError);
    } finally {
      river.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 7. Body notices are never recorded as her says.

describe("body notices", () => {
  it("body notices are body notes, never her says", async () => {
    const now = Date.UTC(2026, 9, 11, 11, 5);
    const river = new MemoryRiver({ nowMs: () => now });
    const notebook = new MemoryNotebook({ nowMs: () => now });
    const model = new ScriptedModel([new ModelError("The service is down.", "unavailable", 1)]);

    const result = await runTurn({
      model,
      tools: [],
      system: "You are Iris, a test entity.",
      history: [],
      event: "Owner: hello.",
      thread: "cli:summoner",
      river,
      notebook,
      ceiling: { maxModelCalls: 4, maxToolCalls: 4 },
      nowMs: () => now,
      turnId: "turn-body-notice",
    });

    expect(result.endedBy).toBe("model_error");
    const rows = river.read({ limit: 100 });
    const notice = rows.find(
      (row) => row.kind === "note" && row.source === "body" && row.data?.["kind"] === "unavailable",
    );
    expect(notice).toMatchObject({ kind: "note", source: "body" });
    expect(rows.filter((row) => row.source === "body").some((row) => row.kind === "say")).toBe(false);
    expect(rows.filter((row) => row.kind === "say").every((row) => row.source === "self")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// 8. No model-written text in her context except her own turns.

describe("no model-written text in her context", () => {
  it("no model-written text in her context except her own turns", async () => {
    const canary = ["a", "phrase", "the", "checker", "made", "up"].join(" ");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      reply({
        content: JSON.stringify({
          contradicts: true,
          claim_quote: "I work at the lighthouse",
          record_quote: "I work at the bakery",
          claim: canary,
          record: canary,
        }),
      }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, cli } = await open(model, { config: HONEST });
    await entity.start();
    await entity.notebook.write("self/life.md", "# Life\n\n## Work\n\nI work at the bakery.\n", "test fixture", "self");

    cli.send("Where do you work?");
    await entity.idle();

    // The checker's own words are not kept, and its paraphrase never reaches a later call. The receipt quotes the
    // message and the record exactly as their sources spell them.
    const receipt = allRows(entity).find((row) => row.kind === "receipt" && row.data?.["tool"] === "say");
    expect(JSON.stringify(receipt)).toContain("I work at the lighthouse");
    expect(JSON.stringify(receipt)).toContain("I work at the bakery");
    expect(JSON.stringify(allRows(entity))).not.toContain(canary);
    expect(JSON.stringify(model.requests.slice(2))).not.toContain(canary);

    // A later turn starts with the body's facts and the river only: no assistant history is carried over.
    cli.send("Tell me again.");
    await entity.idle();
    const later = model.requests.at(-1);
    expect(later?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(later?.messages)).not.toContain(canary);
  });
});

// ---------------------------------------------------------------------------------------------------
// The doc must list every invariant and name a test that exists.

describe("docs/one-mind.md", () => {
  const expected: Array<{ number: number; title: string; mentions?: string[] }> = [
    { number: 1, title: "one river writer" },
    { number: 2, title: "l1" },
    {
      number: 3,
      title: "lar folder lock",
      mentions: ["run", "forget", "restore", "notebook-restore", "import --apply", "vault --keep", "vault queue"],
    },
    { number: 4, title: "copy guard" },
    { number: 5, title: "say-hold per place" },
    { number: 6, title: "no new riverkind" },
    { number: 7, title: "body notices" },
    { number: 8, title: "no model-written text" },
  ];

  it("docs/one-mind.md lists every invariant and names an existing test", () => {
    const path = join(REPO, "docs", "one-mind.md");
    expect(existsSync(path), "docs/one-mind.md is missing").toBe(true);
    const doc = readFileSync(path, "utf8").replace(/\r\n/g, "\n");

    const headings = [...doc.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)];
    expect(headings.map((match) => Number(match[1]))).toEqual(expected.map((entry) => entry.number));

    for (const [index, heading] of headings.entries()) {
      const number = Number(heading[1]);
      const start = heading.index ?? 0;
      const end = headings[index + 1]?.index ?? doc.length;
      const section = doc.slice(start, end);
      const item = expected.find((entry) => entry.number === number);
      expect(item, `unexpected invariant ${number}`).toBeDefined();
      expect(section.toLowerCase(), `invariant ${number} does not say "${item?.title}"`).toContain(item?.title ?? "");
      for (const word of item?.mentions ?? []) {
        expect(section, `invariant ${number} does not mention ${word}`).toContain(word);
      }

      const guardLines = section.split("\n").filter((line) => line.trimStart().startsWith("Guarded by"));
      expect(guardLines.length, `invariant ${number} has no "Guarded by" line`).toBeGreaterThan(0);
      const pairs = [...guardLines.join(" ").matchAll(/`([^`]+\.test\.ts)`\s*[—–-]\s*"([^"]+)"/g)].map((match) => ({
        file: match[1] ?? "",
        name: match[2] ?? "",
      }));
      expect(pairs.length, `invariant ${number} names no test`).toBeGreaterThan(0);

      for (const pair of pairs) {
        const testPath = join(REPO, pair.file);
        expect(existsSync(testPath), `invariant ${number} names a missing file: ${pair.file}`).toBe(true);
        const source = readFileSync(testPath, "utf8").replace(/\r\n/g, "\n");
        const line = source.split("\n").find((text) => text.includes(`"${pair.name}"`));
        expect(line, `invariant ${number} names a test not in ${pair.file}: "${pair.name}"`).toBeDefined();
        expect(line).toMatch(/^\s*it[.(]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Local world helpers.

/** A world the test drives directly: it sends outside text in. */
function sourceWorld(id: string): { world: World; push(place: string, text: string): void } {
  let emit: ((event: WorldEvent) => void) | undefined;
  const world: World = {
    id,
    async start(next) {
      emit = next;
    },
    async stop() {
      emit = undefined;
    },
    async say(): Promise<Receipt> {
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [],
    now: () => `${id} is open.`,
  };
  return {
    world,
    push(place, text) {
      if (emit === undefined) throw new Error("the fake world is not started");
      emit({ world: id, place, actor: "mara", source: "outside", text });
    },
  };
}
