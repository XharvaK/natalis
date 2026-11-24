import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, Receipt, SayFile, Tool, World, WorldBody } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { HOW_YOU_ACT, openEntity, type Entity } from "./runtime.js";

/** A model address that is never called: the tests use a scripted model. Built from parts, as the other fixtures are. */
const MODEL_URL = ["http://", ["127", "0", "0", "1"].join("."), ":9/v1"].join("");
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: MODEL_URL, model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
};
const DM = "discord:dm:mara";
const ROOM = "discord:room:garden";
const OWNER_DM = "discord:dm:owner";
/** A fake credential, built from parts at run time so no token-shaped literal sits in the source. */
const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

let root: string;
let dir: string;
const opened: Entity[] = [];

// Seeding a notebook is one git commit per folder, which is slow on some hosts: the tests copy one seeded notebook.
let templateRoot: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-files-template-"));
  const seeded = join(templateRoot, "seeded");
  const entity = await openEntity({ dir: seeded, config: CONFIG, model: new ScriptedModel([]), worlds: [createCliWorld({ onSay: () => {} })] });
  await entity.stop();
}, 60_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-files-"));
  dir = join(root, "iris");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

type Sent = { place: string; text: string; files: SayFile[] };

/** A world that keeps the body it was started with, records every say with its files, and knows its owner's places. */
function recordingWorld(id: string, ownerPlaces: readonly string[] = []): { world: World; body: () => WorldBody; sent: Sent[] } {
  let bodyRef: WorldBody | undefined;
  const sent: Sent[] = [];
  const world: World = {
    id,
    async start(_next, body) {
      bodyRef = body;
    },
    async stop() {},
    async say(place, text, options): Promise<Receipt> {
      sent.push({ place, text, files: options?.files ?? [] });
      return { ok: true, summary: "Delivered.", data: { refs: ["m43"] } };
    },
    isOwnerPlace: (place) => ownerPlaces.includes(place),
    tools: () => [],
    now: () => `${id} is open.`,
  };
  return {
    world,
    sent,
    body: () => {
      if (bodyRef === undefined) throw new Error("the fake world was not started");
      return bodyRef;
    },
  };
}

async function open(
  model: ModelPort,
  extras: { worlds?: World[]; config?: EntityConfig; worldModels?: Record<string, ModelPort> } = {},
): Promise<{ entity: Entity; send: (text: string) => void }> {
  if (!existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(templateRoot, "seeded", "notebook"), join(dir, "notebook"), { recursive: true });
  }
  const cli = createCliWorld({ onSay: () => {} });
  const entity = await openEntity({
    dir,
    config: extras.config ?? CONFIG,
    model,
    worlds: [cli, ...(extras.worlds ?? [])],
    ...(extras.worldModels === undefined ? {} : { worldModels: extras.worldModels }),
  });
  opened.push(entity);
  return { entity, send: (text) => cli.send(text) };
}

/** The tool messages a request carried: the receipts the Lar read. */
function receiptsIn(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => (message.role === "tool" ? [message.content] : []));
}

type TurnSeam = { takeTurn(thread: string): Promise<void> };

function turnOf(entity: Entity): TurnSeam {
  return entity as unknown as TurnSeam;
}

/** An event row written straight to the river, so the test's own turn takes it and no world wakes one. */
function appendEventRow(entity: Entity, thread: string): void {
  entity.river.append({ kind: "event", thread, place: thread, source: "outside", text: "A note for this thread.", atMs: Date.now() });
}

/** A tiny PNG built from bytes: the signature and a few more. */
function png(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
}

/** Writes a file into her home folder, on the path the sandbox shows, and returns its real path. */
function homeFile(relative: string, content: string): string {
  const path = join(dir, "home", ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

describe("threadEffort", () => {
  it("uses a kind's own effort, and the entity's effort for a kind left out", async () => {
    const fake = recordingWorld("discord", [OWNER_DM]);
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {
      worlds: [fake.world],
      config: { ...CONFIG, effort: "xhigh", threadEffort: { summoner: "high" } },
    });
    await entity.start();

    appendEventRow(entity, OWNER_DM);
    await turnOf(entity).takeTurn(OWNER_DM);
    appendEventRow(entity, "self");
    await turnOf(entity).takeTurn("self");

    expect(model.requests[0]?.effort).toBe("high");
    expect(model.requests[1]?.effort).toBe("xhigh");
    const ended = entity.river.read({ kinds: ["turn"], limit: 1_000 }).filter((row) => row.data?.["phase"] === "end");
    expect(ended.map((row) => row.data?.["effort"])).toEqual(["high", "xhigh"]);
  });

  it("still gives a world model's own effort the last word for its world", async () => {
    const fake = recordingWorld("game");
    const main = new ScriptedModel([]);
    const gameModel = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(main, {
      worlds: [fake.world],
      config: {
        ...CONFIG,
        effort: "xhigh",
        threadEffort: { game: "low" },
        worldModels: { game: { model: "fast", effort: "high" } },
      },
      worldModels: { game: gameModel },
    });
    await entity.start();

    appendEventRow(entity, "game:slot1");
    await turnOf(entity).takeTurn("game:slot1");

    expect(gameModel.requests[0]?.effort).toBe("high");
    expect(main.requests).toHaveLength(0);
  });
});

describe("say with files from her home folder", () => {
  it("sends a markdown file with the words, and the river and receipt name it", async () => {
    const fake = recordingWorld("discord");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: DM, text: "Read this.", files: ["notes/essay.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    const file = homeFile("notes/essay.md", "A short essay.\n");

    send("Send your essay.");
    await entity.idle();

    expect(fake.sent).toEqual([
      {
        place: DM,
        text: "Read this.",
        files: [{ path: realpathSync(file), name: "essay.md", mime: "text/markdown", bytes: Buffer.from("A short essay.\n") }],
      },
    ]);
    const row = entity.river.read({ thread: DM, kinds: ["say"], limit: 1 })[0];
    expect(row?.text).toBe("Read this.\n[file notes/essay.md, 1 KB]");
    expect(row?.data).toEqual({ files: ["notes/essay.md"], refs: ["m43"] });
    expect(receiptsIn(model.requests[1]).join("\n")).toContain(`Said to ${DM} with 1 file(s) (m43).`);
  });

  it("puts the shelf pictures first and says how many pictures and files went", async () => {
    const fake = recordingWorld("discord");
    let picture = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("say", { place: DM, text: "Both.", attach: [picture], files: ["notes/a.md", "notes/b.txt"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    picture = fake.body().keepPicture({ bytes: png(), name: "cat.png", from: { world: "discord", place: DM } }).id;
    homeFile("notes/a.md", "a".repeat(1025));
    homeFile("notes/b.txt", "hi");

    send("Send both.");
    await entity.idle();

    expect(fake.sent[0]?.files).toEqual([
      { path: join(dir, "media", `${picture}.png`), name: "cat.png", mime: "image/png" },
      {
        path: realpathSync(join(dir, "home", "notes", "a.md")),
        name: "a.md",
        mime: "text/markdown",
        bytes: Buffer.from("a".repeat(1025)),
      },
      {
        path: realpathSync(join(dir, "home", "notes", "b.txt")),
        name: "b.txt",
        mime: "text/plain",
        bytes: Buffer.from("hi"),
      },
    ]);
    const row = entity.river.read({ thread: DM, kinds: ["say"], limit: 1 })[0];
    expect(row?.text).toBe(`Both.\n[picture ${picture}: cat.png]\n[file notes/a.md, 2 KB]\n[file notes/b.txt, 1 KB]`);
    expect(row?.data).toEqual({ pictures: [picture], files: ["notes/a.md", "notes/b.txt"], refs: ["m43"] });
    expect(receiptsIn(model.requests[1]).join("\n")).toContain(`Said to ${DM} with 1 picture(s) and 2 file(s) (m43).`);
  });

  it("holds the whole say when a text file carries a secret", async () => {
    const fake = recordingWorld("discord");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: DM, text: "The key.", files: ["notes/key.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    homeFile("notes/key.md", `Here is the key: ${FAKE_KEY}\n`);

    send("Send the key.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(entity.river.read({ thread: DM, kinds: ["say"], limit: 10 })).toEqual([]);
    const receipts = receiptsIn(model.requests[1]).join("\n");
    expect(receipts).toContain('"held_secret"');
    expect(receipts).not.toContain(FAKE_KEY);
  });

  it("holds the whole say when a file's name is on the privacy list in a room", async () => {
    const fake = recordingWorld("discord");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: ROOM, text: "The note.", files: ["notes/Lantern Yard.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }), "utf8");
    homeFile("notes/Lantern Yard.md", "The gate is green.\n");

    send("Send the note.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    const receipts = receiptsIn(model.requests[1]).join("\n");
    expect(receipts).toContain('"held_privacy"');
    expect(receipts).toContain("(home)");
  });

  it("refuses an env file by name and sends nothing", async () => {
    const fake = recordingWorld("discord");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: DM, text: "The settings.", files: ["notes/.env"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    homeFile("notes/.env", "PLACE=somewhere\n");

    send("Send it.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("notes/.env looks like a file of secrets; it stays home.");
  });

  it("refuses files outside Discord places", async () => {
    const fake = recordingWorld("fake");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "fake:room", text: "The note.", files: ["notes/essay.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    homeFile("notes/essay.md", "A short essay.\n");

    send("Send it here.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("Files go only to Discord places.");
  });

  it("refuses two pictures and three files together", async () => {
    const fake = recordingWorld("discord");
    let first = "";
    let second = "";
    const model = new ScriptedModel([
      () =>
        reply({
          toolCalls: [
            call("say", {
              place: DM,
              text: "Too much.",
              attach: [first, second],
              files: ["notes/a.md", "notes/b.md", "notes/c.md"],
            }),
          ],
        }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();
    first = fake.body().keepPicture({ bytes: png(), name: "one.png", from: { world: "discord", place: DM } }).id;
    second = fake.body().keepPicture({ bytes: png(), name: "two.png", from: { world: "discord", place: DM } }).id;
    homeFile("notes/a.md", "a");
    homeFile("notes/b.md", "b");
    homeFile("notes/c.md", "c");

    send("Send too much.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("A say carries at most 4 pictures and files together.");
  });

  it("refuses files with a voice message", async () => {
    const fake = recordingWorld("discord");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: DM, text: "Out loud.", as_voice: true, files: ["notes/essay.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [fake.world] });
    await entity.start();

    send("Say it out loud.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("A voice message carries nothing else: leave out files, or leave out as_voice.");
  });

  it("sends the bytes it checked, even when the file changes on disk before the world sends it", async () => {
    // A background job of hers rewrites the file after the body read and checked it, but before the world reads anything.
    const sent: SayFile[][] = [];
    const racing: World = {
      id: "discord",
      async start() {},
      async stop() {},
      async say(_place, _text, options): Promise<Receipt> {
        homeFile("notes/essay.md", "Something else entirely.\n");
        sent.push(options?.files ?? []);
        return { ok: true, summary: "Delivered.", data: { refs: ["m43"] } };
      },
      tools: () => [],
      now: () => "discord is open.",
    };
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: DM, text: "Read this.", files: ["notes/essay.md"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, { worlds: [racing] });
    await entity.start();
    homeFile("notes/essay.md", "The checked essay.\n");

    send("Send your essay.");
    await entity.idle();

    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0]?.[0]?.bytes ?? new Uint8Array()).toString("utf8")).toBe("The checked essay.\n");
  });
});

describe("how she acts with what she makes", () => {
  it("names files from her home folder in HOW_YOU_ACT and in the say tool", async () => {
    const model = new ScriptedModel([]);
    const { entity } = await open(model);

    expect(HOW_YOU_ACT.split("\n").at(-1)).toBe(
      "What you make in your home folder can reach people: keep_picture puts a picture on your shelf, and say's files sends a file to a Discord place.",
    );

    const tools = (entity as unknown as { tools: Tool[] }).tools;
    const say = tools.find((tool) => tool.spec.name === "say");
    const properties = (say?.spec.parameters as { properties: Record<string, { description?: string; maxItems?: number }> }).properties;
    expect(properties["files"]?.description).toBe(
      "Optional. Up to 4 files from your home folder to send with the words, such as notes/essay.md. Text files are checked like your words.",
    );
    expect(properties["files"]?.maxItems).toBe(4);
  });
});
