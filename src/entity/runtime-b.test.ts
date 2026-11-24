import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig, ModelPort, ModelRequest, Receipt, RiverRow, World, WorldEvent } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld, type CliWorld } from "../worlds/cli.js";
import { ftsAvailable } from "../river/sqlite-river.js";
import type { LinkStore } from "../river/links.js";
import { openEntity, type Entity, type OpenEntityOptions } from "./runtime.js";

// Invented people and places only.
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};

let root: string;
let dir: string;
const opened: Entity[] = [];
let templateRoot: string;
let templateNotebook: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-b-template-"));
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
  root = mkdtempSync(join(tmpdir(), "natalis-entity-b-"));
  dir = join(root, "iris");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

type Opened = { entity: Entity; cli: CliWorld; said: Array<{ place: string; text: string }> };

async function open(model: ModelPort, extra: Partial<OpenEntityOptions> = {}, worlds: World[] = []): Promise<Opened> {
  // Copy the template only into a folder that has no notebook yet: a reopened folder keeps its own.
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

/** A world that only emits events (a room). */
function fakeWorld(id: string): { world: World; push(place: string, text: string): void } {
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
  return {
    world,
    push(place, text) {
      if (next === undefined) throw new Error("the fake world is not started");
      next({ world: id, place, actor: "mara", source: "outside", text });
    },
  };
}

function allRows(entity: Entity): RiverRow[] {
  return entity.river.read({ limit: 100_000 });
}

function appendEventRow(entity: Entity, thread: string, text: string): void {
  entity.river.append({ kind: "event", thread, place: thread, source: "outside", text, atMs: Date.now() });
}

function userTextOf(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

function systemTextOf(request: ModelRequest | undefined): string {
  const message = request?.messages[0];
  return message?.role === "system" ? message.content : "";
}

/** The receipt summaries a model was shown in one request. */
function summariesShownIn(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    if (message.role !== "tool") return [];
    const receipt = JSON.parse(message.content) as Record<string, unknown>;
    return [String(receipt["summary"] ?? "")];
  });
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

function recallOf(user: string): string {
  const at = user.indexOf("## recall");
  return at === -1 ? "" : user.slice(at);
}

describe("Q19: recall searches the rare words", () => {
  it("recalls the soundtrack row from a message whose first words are all common", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    room.push("fake:room", "We talked about the soundtrack for the harbour film.");
    await entity.idle();
    cli.send("That would have been really cool when we talked about the soundtrack.");
    await entity.idle();

    const user = userTextOf(model.requests[1]);
    expect(user).toContain("## recall");
    expect(recallOf(user)).toContain("the soundtrack for the harbour film");
  });

  it("finds nothing from stop words or the Lar's own name alone", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    // The room row holds every word of the summoner's message, so a stop word or her name left in would recall it.
    room.push("fake:room", "Iris really good think would have been.");
    await entity.idle();
    cli.send("That would have been really good, Iris. I think so.");
    await entity.idle();

    expect(userTextOf(model.requests[1])).not.toContain("## recall");
  });

  it.runIf(ftsAvailable())("with more than 8 candidate words, searches the 8 rarest", async () => {
    const room = fakeWorld("fake");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    // One word a row: the five harbour rows make it the commonest word, and each of the other eight is rarest.
    for (let i = 0; i < 5; i += 1) appendEventRow(entity, "fake:room", "harbour");
    for (const word of ["sextant", "lantern", "compass", "buoy", "anchor", "trawler", "mast", "gull"]) {
      appendEventRow(entity, "fake:room", word);
    }
    room.push("fake:room", "The kettle is on.");
    await entity.idle();
    cli.send("That would have been really cool to talk about the harbour, sextant, lantern, compass, buoy, anchor, trawler, mast, and gull.");
    await entity.idle();

    const recall = recallOf(userTextOf(model.requests[1]));
    expect(recall).toContain("] sextant");
    expect(recall).toContain("] trawler");
    expect(recall).not.toContain("] harbour");
  });
});

describe("N2c: body notes are in the turn part", () => {
  it("keeps the Domus receipt out of the cached life text and puts it after the now board", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();
    const seen = entity.river.append({
      thread: "domus:slot8",
      kind: "event",
      source: "outside",
      text: "A view.\nGame time: Monday 08:00, running (clock speed NORMAL).",
      data: { view: "domus" },
    });

    cli.send("Hello.");
    await entity.idle();

    const system = systemTextOf(model.requests[0]);
    expect(system).not.toContain("Body notes (receipts");
    expect(system).not.toContain(`Domus clock at the last view (seq ${seen.seq})`);

    const user = userTextOf(model.requests[0]);
    expect(user).toContain("Body notes (receipts the host keeps; yours to compare):");
    expect(user).toContain(`Domus clock at the last view (seq ${seen.seq}): Game time: Monday 08:00, running (clock speed NORMAL).`);
    expect(user.indexOf("## now")).toBeLessThan(user.indexOf("## body notes"));
    expect(user.indexOf("## body notes")).toBeLessThan(user.indexOf("## time"));
  });
});

describe("Q21: a life file with one heading over the switch", () => {
  it("writes the needs_headings note and keeps the file whole", async () => {
    const config: EntityConfig = { ...CONFIG, limits: { lifeWarnChars: 100 } };
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, { config });
    const life = `# Life\n\n${"n".repeat(150)}`;
    await entity.notebook.write("self/life.md", life, "test", "self");
    await entity.start();

    cli.send("Hello.");
    await entity.idle();

    const notes = allRows(entity).filter((row) => row.kind === "note" && row.data?.["bodyNote"] === "life_view");
    expect(notes.filter((row) => row.data?.["phase"] === "needs_headings")).toHaveLength(1);
    expect(notes.filter((row) => row.data?.["phase"] === "switched")).toHaveLength(0);
    const system = systemTextOf(model.requests[0]);
    expect(system).toContain("n".repeat(100));
    expect(system).not.toContain("read_note self/life.md section:");
  });
});

describe("the now board names the threads in a turn", () => {
  it("names a thread whose turn is held open while this thread turns", async () => {
    const held = deferred();
    const model = new ScriptedModel([
      async () => {
        await held.promise;
        return reply({ toolCalls: [call("end_turn")] });
      },
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const room = fakeWorld("fake");
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();

    room.push("fake:room", "The kettle is on.");
    await waitFor(() => model.requests.length === 1);
    cli.send("Hello.");
    await waitFor(() => model.requests.length === 2);

    const board = userTextOf(model.requests[1]);
    expect(board).toContain("Threads in a turn right now:");
    expect(board).toContain("- fake:room, started ");

    held.resolve();
    await entity.idle();
  });

  it("adds no such line when nothing else is running", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model);
    await entity.start();

    cli.send("Hello.");
    await entity.idle();

    expect(userTextOf(model.requests[0])).not.toContain("Threads in a turn right now:");
  });
});

describe("read_note sees private links where private is seen", () => {
  it("shows a private link to the summoner and hides it from a room", async () => {
    const steps = [
      reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ];
    const model = new ScriptedModel(steps);
    const room = fakeWorld("fake");
    const { entity, cli } = await open(model, {}, [room.world]);
    await entity.start();
    await entity.notebook.write("people/mara.md", "Mara keeps the lighthouse.\n", "A person", "body");
    const links = (entity as unknown as { links: LinkStore }).links;
    links.record({
      thread: "self",
      from: "private/plans.md",
      to: "people/mara.md",
      relation: "supports",
      reason: "They belong together.",
      private: true,
      seq: Math.max(1, entity.river.lastSeq()),
      atMs: Date.now(),
      author: "self",
    });

    cli.send("Read the note on Mara.");
    await entity.idle();
    expect(summariesShownIn(model.requests[1])).toContain("Read people/mara.md. Linked: private/plans.md supports it.");

    room.push("fake:room", "Read it too, please.");
    await entity.idle();
    const roomSummaries = summariesShownIn(model.requests[3]);
    expect(roomSummaries).toContain("Read people/mara.md.");
    expect(roomSummaries.join("\n")).not.toContain("private/plans.md");
  });
});
