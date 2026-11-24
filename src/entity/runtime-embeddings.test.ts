import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, RiverRow, World } from "../contracts.js";
import type { EmbeddingsClient } from "../model/embeddings.js";
import { openEmbeddings, type EmbeddingStore } from "../river/embeddings.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld, type CliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { openEntity, type Entity } from "./runtime.js";

// Every name, place and note here is invented. Nothing reads a real Lar folder and nothing reaches a network.

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};

const EMBED_MODEL = "small-embed";

let root: string;
let dir: string;
let templateNotebook: string;
let templateRoot: string;
const opened: Entity[] = [];
const stores: EmbeddingStore[] = [];

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-embeddings-template-"));
  const seeded = join(templateRoot, "seeded");
  const entity = await openEntity({
    dir: seeded,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  await entity.stop();
  templateNotebook = join(seeded, "notebook");
}, 180_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-embeddings-"));
  dir = join(root, "lar");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A fake client that records every batch of texts it was asked to embed. */
function fakeClient(answer: (text: string, index: number) => Float32Array | Error): {
  client: EmbeddingsClient;
  calls: string[][];
} {
  const calls: string[][] = [];
  let seen = 0;
  const client: EmbeddingsClient = {
    model: EMBED_MODEL,
    async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
      if (signal?.aborted) throw new Error("the request was aborted");
      calls.push([...texts]);
      return texts.map((text, index) => {
        const result = answer(text, seen + index);
        seen += 1;
        if (result instanceof Error) throw result;
        return result;
      });
    },
  };
  return { client, calls };
}

function store(): EmbeddingStore {
  // The river file's folder: openEmbeddings does not create it, and the runtime opens the river under the same path.
  mkdirSync(dir, { recursive: true });
  const openedStore = openEmbeddings(join(dir, "river.db"));
  stores.push(openedStore);
  return openedStore;
}

type Opened = { entity: Entity; cli: CliWorld };

async function open(model: ModelPort, extras: { embeddings?: { client: EmbeddingsClient; store: EmbeddingStore }; worlds?: World[] } = {}): Promise<Opened> {
  if (!existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(templateNotebook, join(dir, "notebook"), { recursive: true });
  }
  const cli = createCliWorld({ onSay: () => {} });
  const entity = await openEntity({
    dir,
    config: CONFIG,
    model,
    worlds: [cli, ...(extras.worlds ?? [])],
    ...(extras.embeddings === undefined ? {} : { embeddings: extras.embeddings }),
  });
  opened.push(entity);
  return { entity, cli };
}

/** The index pass's private entry point, reached as the other runtime tests reach one. */
type IndexSeam = {
  runIndexPass(embeddings: { client: EmbeddingsClient; store: EmbeddingStore }, signal: AbortSignal): Promise<void>;
  startIndexPass(): void;
  indexPass: Promise<void> | undefined;
};

function indexerOf(entity: Entity): IndexSeam {
  return entity as unknown as IndexSeam;
}

/** Waits until no index pass is running anywhere, so a test never races the background one a turn end starts. */
async function settleIndex(entity: Entity): Promise<void> {
  for (;;) {
    const running = indexerOf(entity).indexPass;
    if (running === undefined) return;
    await running.catch(() => undefined);
  }
}

/** Runs one pass to its end, after any background pass has finished, so the test needs no timing. */
async function runPass(entity: Entity, embeddings: { client: EmbeddingsClient; store: EmbeddingStore }): Promise<void> {
  await settleIndex(entity);
  await indexerOf(entity).runIndexPass(embeddings, new AbortController().signal);
}

function userTextOf(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

function eventRow(entity: Entity, thread: string, text: string, data?: Record<string, unknown>): RiverRow {
  return entity.river.append({ kind: "event", thread, place: thread, source: "outside", text, ...(data === undefined ? {} : { data }), atMs: Date.now() });
}

function sayRow(entity: Entity, thread: string, text: string): RiverRow {
  return entity.river.append({ kind: "say", thread, place: thread, source: "self", text, atMs: Date.now() });
}

function bodyNoteRow(entity: Entity, text: string): RiverRow {
  return entity.river.append({ kind: "note", thread: "self", source: "body", text, data: { bodyNote: "start" }, atMs: Date.now() });
}

describe("the index pass", () => {
  it("embeds event and say rows, and never a view row, a summoner act, a body note or a private note", async () => {
    const { client, calls } = fakeClient(() => new Float32Array([1, 0]));
    const embeddings = { client, store: store() };
    const { entity } = await open(new ScriptedModel([]), { embeddings });
    await entity.start();

    await entity.notebook.write("notes/garden.md", "# Garden\n\nThe plum tree is in flower.\n", "A note", "body");
    await entity.notebook.write("private/diary.md", "# Diary\n\nA private line.\n", "A private note", "body");
    eventRow(entity, "cli:summoner", "The lighthouse at the point is my favourite place.");
    sayRow(entity, "cli:summoner", "I will go there at dusk.");
    eventRow(entity, "game:slot1", "A view of the game.", { view: "domus", brief: "The game." });
    entity.river.append({ kind: "event", thread: "self", source: "body", text: "Your summoner answered a request: yes.", data: { summonerAct: true }, atMs: Date.now() });
    bodyNoteRow(entity, "The host restarted.");
    entity.river.append({ kind: "event", thread: "self", source: "body", text: "Your background job j1 ended.", atMs: Date.now() });

    await runPass(entity, embeddings);

    const sent = calls.flat();
    expect(sent).toContain("The lighthouse at the point is my favourite place.");
    expect(sent).toContain("I will go there at dusk.");
    expect(sent.some((text) => text.includes("The plum tree is in flower."))).toBe(true);
    expect(sent.join("\n")).not.toContain("A view of the game.");
    expect(sent.join("\n")).not.toContain("Your summoner answered a request");
    expect(sent.join("\n")).not.toContain("The host restarted.");
    expect(sent.join("\n")).not.toContain("A private line.");
    expect(sent.some((text) => text.includes("Your background job j1 ended."))).toBe(false);
    expect(embeddings.store.search(new Float32Array([1, 0]), { model: EMBED_MODEL, includePrivate: true, limit: 100 })).not.toHaveLength(0);
  });

  it("embeds nothing new on a second pass", async () => {
    const { client, calls } = fakeClient(() => new Float32Array([1, 0]));
    const embeddings = { client, store: store() };
    const { entity } = await open(new ScriptedModel([]), { embeddings });
    await entity.start();

    eventRow(entity, "cli:summoner", "Only one interesting thing happened.");
    // Two sections of one heading share a key, and must not be embedded in turn on every pass.
    await entity.notebook.write("notes/twice.md", "# Log\n\nMonday.\n\n# Log\n\nTuesday.\n", "A note", "body");
    await runPass(entity, embeddings);
    const afterFirst = calls.flat().length;
    await runPass(entity, embeddings);

    expect(calls.flat()).toHaveLength(afterFirst);
  });

  it("removes the entries of a note that was trashed", async () => {
    const { client } = fakeClient(() => new Float32Array([1, 0]));
    const embeddings = { client, store: store() };
    const { entity } = await open(new ScriptedModel([]), { embeddings });
    await entity.start();

    await entity.notebook.write("notes/old.md", "# Old\n\nA retiring thing.\n", "A note", "body");
    await runPass(entity, embeddings);
    expect(embeddings.store.hashes("note", EMBED_MODEL).has("notes/old.md#Old")).toBe(true);
    await entity.notebook.remove("notes/old.md", "Retire it", "body");
    await runPass(entity, embeddings);

    expect([...embeddings.store.hashes("note", EMBED_MODEL).keys()].some((key) => key.startsWith("notes/old.md#"))).toBe(false);
  });

  it("writes one body note when the service fails, and none on a second failure within the hour", async () => {
    const { client } = fakeClient(() => new Error("embeddings: the service answered 500"));
    const embeddings = { client, store: store() };
    const { entity } = await open(new ScriptedModel([]), { embeddings });
    await entity.start();

    eventRow(entity, "cli:summoner", "Something to embed.");
    await runPass(entity, embeddings);
    const first = entity.river.read({ thread: "self", kinds: ["note"], limit: 100 }).filter((row) => row.data?.["bodyNote"] === "recall_by_meaning");
    expect(first).toHaveLength(1);
    expect(first[0]?.source).toBe("body");
    expect(first[0]?.text).toBe("Recall by meaning could not update its index: embeddings: the service answered 500.");

    await runPass(entity, embeddings);
    const second = entity.river.read({ thread: "self", kinds: ["note"], limit: 100 }).filter((row) => row.data?.["bodyNote"] === "recall_by_meaning");
    expect(second).toHaveLength(1);
  });
});

describe("recall by meaning in the turn", () => {
  /** A client that puts the question's direction on `near` texts and the other direction on the rest. */
  function directionClient(near: readonly string[]): { client: EmbeddingsClient; calls: string[][] } {
    return fakeClient((text) => (near.some((part) => text.includes(part)) ? new Float32Array([1, 0]) : new Float32Array([0, 1])));
  }

  it("shows a row with no shared words that the fake client puts close to the question, before a far one", async () => {
    const { client } = directionClient(["Where do you like to walk", "orchard"]);
    const embeddings = { client, store: store() };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, { embeddings });
    await entity.start();

    const near = eventRow(entity, "fake:room", "The orchard beyond the mill is quiet at noon.");
    const far = eventRow(entity, "fake:room", "The harbour gate closes at six in winter.");
    await runPass(entity, embeddings);

    cli.send("Where do you like to walk?");
    await entity.idle();

    const user = userTextOf(model.requests.at(-1));
    expect(user).toContain("## recall");
    const recall = user.slice(user.indexOf("## recall"));
    // Neither row shares a word with the question: both are here by meaning, and the closer one comes first.
    expect(recall).toContain("The orchard beyond the mill is quiet at noon.");
    expect(recall).toContain("The harbour gate closes at six in winter.");
    expect(recall.indexOf("orchard")).toBeLessThan(recall.indexOf("harbour gate"));
    expect(near.seq).toBeLessThan(far.seq);
  });

  it("stays lexical when the client fails, and the turn still runs", async () => {
    // The row's own text indexes fine; only the question's embedding fails, so the store holds rows for the model.
    const { client } = fakeClient((text) =>
      text.includes("Where is the lantern") ? new Error("embeddings: no answer from the service within 5000 ms") : new Float32Array([1, 0]),
    );
    const embeddings = { client, store: store() };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, { embeddings });
    await entity.start();

    eventRow(entity, "fake:room", "The lantern room smells of oil and salt.");
    await runPass(entity, embeddings);
    cli.send("Where is the lantern?");
    await entity.idle();

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("## recall");
    expect(user).toContain("The lantern room smells of oil and salt.");
    const notes = entity.river
      .read({ thread: "self", kinds: ["note"], limit: 100 })
      .filter((row) => row.data?.["bodyNote"] === "recall_by_meaning" && (row.text ?? "").includes("was not used this turn"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toMatch(/^Recall by meaning was not used this turn: .+\.$/);
  });

  it("shows a note hit with its path, heading and the section's current text", async () => {
    // The question and the note both point one way; the section's words change after its vector is made, and recall
    // still shows the note as it stands now.
    const { client } = directionClient(["Where do you keep the seeds", "seeds wait"]);
    const embeddings = { client, store: store() };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, { embeddings });
    await entity.start();

    await entity.notebook.write("notes/seed-box.md", "# The seed box\n\nSunflower seeds wait in the tin by the door.\n", "A note", "body");
    await runPass(entity, embeddings);
    await entity.notebook.write("notes/seed-box.md", "# The seed box\n\nMarigold seeds wait in the tin by the door.\n", "A change", "body");
    // Let the changed section take its own vector, so the store still answers for this note's section.
    await runPass(entity, embeddings);

    cli.send("Where do you keep the seeds?");
    await entity.idle();

    const user = userTextOf(model.requests.at(-1));
    expect(user).toContain("## recall");
    expect(user).toContain("[note notes/seed-box.md, The seed box]");
    // The note as it stands now, not the words its vector was made from.
    expect(user).toContain("Marigold seeds wait in the tin by the door.");
    expect(user).not.toContain("Sunflower seeds");
  });
});

describe("!answer through the runtime", () => {
  it("reaches answerProposal, and the self thread gets the answer event", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    await entity.notebook.write("proposals/paint.md", "# Paint\n\nWhich colour?\n", "A request", "self");

    cli.send("!answer paint.md Blue, please.");
    await entity.idle();

    const row = entity.river.read({ thread: "self", kinds: ["event"], limit: 100 }).find((item) => item.data?.["bodyNote"] === "proposal_answer");
    expect(row?.text).toBe("Your summoner answered proposals/paint.md: Blue, please.");
    expect(row?.data).toMatchObject({ bodyNote: "proposal_answer", file: "paint.md" });
    expect(model.requests.length).toBeGreaterThanOrEqual(1);
  });

  it("answers a missing file with the names that are there, and writes no event", async () => {
    const model = new ScriptedModel([]);
    const { entity, cli } = await open(model);
    await entity.start();
    await entity.notebook.write("proposals/other.md", "# Other\n", "A request", "self");

    cli.send("!answer paint.md Blue, please.");
    await entity.idle();

    expect(entity.river.read({ thread: "self", kinds: ["event"], limit: 100 })).toEqual([]);
  });
});
