import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelRequest, Receipt, SayFile, World, WorldBody, WorldEvent } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { openEntity, type Entity } from "./runtime.js";

/** A model address that is never called: the tests use a scripted model. Built from parts, as the other fixtures are. */
const MODEL_URL = ["http://", ["127", "0", "0", "1"].join("."), ":9/v1"].join("");
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: MODEL_URL, model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
};
const PLACE = "fake:room";
const FROM = { world: "fake", place: PLACE };

/** A tiny PNG built from bytes: the signature and a few more. */
function png(extra: number[] = [1, 2, 3]): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
}

let root: string;
let dir: string;
const opened: Entity[] = [];

// Seeding a notebook is one git commit per folder, which is slow on some hosts: the tests copy one seeded notebook.
let templateRoot: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-pictures-template-"));
  const seeded = join(templateRoot, "seeded");
  const entity = await openEntity({ dir: seeded, config: CONFIG, model: new ScriptedModel([]), worlds: [createCliWorld({ onSay: () => {} })] });
  await entity.stop();
}, 60_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-pictures-"));
  dir = join(root, "iris");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A world that keeps the body it was started with, and records every say with its files. */
function pictureWorld(carriesFiles: boolean): {
  world: World;
  body: () => WorldBody;
  sent: Array<{ place: string; text: string; files: SayFile[] }>;
} {
  let bodyRef: WorldBody | undefined;
  let emit: ((event: WorldEvent) => void) | undefined;
  const sent: Array<{ place: string; text: string; files: SayFile[] }> = [];
  const world: World = {
    id: "fake",
    async start(next, body) {
      emit = next;
      bodyRef = body;
    },
    async stop() {
      emit = undefined;
    },
    async say(place, text, sayOptions): Promise<Receipt> {
      const files = sayOptions?.files ?? [];
      if (files.length > 0 && !carriesFiles) {
        return { ok: false, summary: "This place cannot carry pictures.", refused: { code: "no_pictures", reason: "this place cannot carry pictures" } };
      }
      sent.push({ place, text, files });
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [],
    now: () => "fake is open.",
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
  model: ScriptedModel,
  worlds: World[],
  config: EntityConfig = CONFIG,
): Promise<{ entity: Entity; send: (text: string) => void; said: string[] }> {
  if (!existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(templateRoot, "seeded", "notebook"), join(dir, "notebook"), { recursive: true });
  }
  const said: string[] = [];
  const cli = createCliWorld({ onSay: (_place, text) => said.push(text) });
  const entity = await openEntity({ dir, config, model, worlds: [cli, ...worlds] });
  opened.push(entity);
  return { entity, send: (text) => cli.send(text), said };
}

/** The tool messages a request carried: the receipts the Lar read. */
function receiptsIn(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => (message.role === "tool" ? [message.content] : []));
}

describe("say with attach", () => {
  it("sends the shelf pictures with the words, and the river keeps which pictures went", async () => {
    const fake = pictureWorld(true);
    let picture = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("say", { place: PLACE, text: "Here is the cat.", attach: [picture] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world]);
    await entity.start();
    picture = fake.body().keepPicture({ bytes: png(), name: "cat.png", from: FROM }).id;

    send("Send the cat.");
    await entity.idle();

    expect(fake.sent).toEqual([
      {
        place: PLACE,
        text: "Here is the cat.",
        files: [{ path: join(dir, "media", `${picture}.png`), name: "cat.png", mime: "image/png" }],
      },
    ]);
    expect(existsSync(join(dir, "media", `${picture}.png`))).toBe(true);
    const sayRow = entity.river.read({ thread: PLACE, kinds: ["say"], limit: 1 })[0];
    expect(sayRow?.text).toBe(`Here is the cat.\n[picture ${picture}: cat.png]`);
    expect(sayRow?.data).toEqual({ pictures: [picture] });
    expect(receiptsIn(model.requests[1]).join("\n")).toContain(`Said to ${PLACE} with 1 picture(s).`);
  });

  it("refuses the whole say, and names the newest shelf ids, when a picture is not on the shelf", async () => {
    const fake = pictureWorld(true);
    let kept = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("say", { place: PLACE, text: "Look.", attach: ["m-AAAAAAAA"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world]);
    await entity.start();
    kept = fake.body().keepPicture({ bytes: png(), name: "dog.png", from: FROM }).id;

    send("Send a picture.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain(`There is no picture m-AAAAAAAA on your shelf, so nothing was sent. The newest on your shelf are: ${kept}.`);
    expect(entity.river.read({ thread: PLACE, kinds: ["say"], limit: 10 })).toEqual([]);
  });

  it("refuses the say when the world cannot carry pictures, and the river says nothing was sent", async () => {
    const fake = pictureWorld(false);
    let picture = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("say", { place: PLACE, text: "Look.", attach: [picture] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world]);
    await entity.start();
    picture = fake.body().keepPicture({ bytes: png(), name: "dog.png", from: FROM }).id;

    send("Send it.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("this place cannot carry pictures");
    expect(entity.river.read({ thread: PLACE, kinds: ["say"], limit: 10 })).toEqual([]);
  });

  it("refuses more than four pictures, and the same picture twice", async () => {
    const fake = pictureWorld(true);
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("say", { place: PLACE, text: "A.", attach: ["m-AAAAAAAA", "m-AAAAAAAA"] })] }),
      () => reply({ toolCalls: [call("say", { place: PLACE, text: "B.", attach: ["m-A", "m-B", "m-C", "m-D", "m-E"] })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world]);
    await entity.start();
    fake.body().keepPicture({ bytes: png(), name: "one.png", from: FROM });

    send("Two sends.");
    await entity.idle();

    expect(fake.sent).toEqual([]);
    expect(receiptsIn(model.requests[1]).join("\n")).toContain("Each picture can go with a say once.");
    expect(receiptsIn(model.requests[2]).join("\n")).toContain("attach is a list of up to 4 picture ids from your shelf.");
  });

  it("shows the shelf's count and size on the now board", async () => {
    const fake = pictureWorld(true);
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, send } = await open(model, [fake.world]);
    await entity.start();
    send("First.");
    await entity.idle();
    expect(String(model.requests[0]?.messages[0]?.content)).toContain("Your shelf of pictures: none kept.");

    fake.body().keepPicture({ bytes: png(), name: "a.png", from: FROM });
    send("Second.");
    await entity.idle();
    const later = String(model.requests[1]?.messages[0]?.content);
    expect(later).toContain("Your shelf of pictures: 1 kept, 1 KB.");
  });
});

describe("the summoner's pictures", () => {
  it("lists the newest pictures in the summoner's place, and forgets one by its id", async () => {
    const fake = pictureWorld(true);
    const model = new ScriptedModel([]);
    const { entity, send, said } = await open(model, [fake.world]);
    await entity.start();
    const kept = fake.body().keepPicture({ bytes: png(), name: "cat.png", from: FROM }).id;

    send("!media");
    await entity.idle();
    expect(said.at(-1)).toContain(`${kept}: cat.png`);
    expect(said.at(-1)).toContain("from fake:room");

    send(`!media forget ${kept}`);
    await entity.idle();
    expect(said.at(-1)).toBe(`[natalis] Removed the picture ${kept} from your shelf.`);
    expect(existsSync(join(dir, "media", `${kept}.png`))).toBe(false);

    send("!media");
    await entity.idle();
    expect(said.at(-1)).toBe("[natalis] Your shelf of pictures is empty.");

    send(`!media forget ${kept}`);
    await entity.idle();
    expect(said.at(-1)).toBe(`[natalis] There is no picture ${kept} on your shelf. !media lists them.`);
    expect(model.requests).toHaveLength(0);
  });
});

describe("look: a picture the model can see", () => {
  const SEEING: EntityConfig = { ...CONFIG, model: { ...CONFIG.model, vision: true } };

  it("is offered only with vision, and shows the picture on the next call, once", async () => {
    const fake = pictureWorld(true);
    let picture = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("look", { id: picture }, "call_look")] }),
      reply({ content: "I see a cat." }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world], SEEING);
    await entity.start();
    picture = fake.body().keepPicture({ bytes: png(), name: "cat.png", from: FROM }).id;

    send("Look at the picture.");
    await entity.idle();
    send("Anything else?");
    await entity.idle();

    const names = (model.requests[0]?.tools ?? []).map((spec) => spec.name);
    expect(names).toContain("look");
    expect(String(model.requests[0]?.messages[0]?.content)).toContain("You can see pictures");
    const base64 = Buffer.from(png()).toString("base64");
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "user", images: [{ type: "image", mime: "image/png", dataBase64: base64 }] });
    expect(model.requests[2]?.messages.some((m) => m.role === "user" && m.images !== undefined)).toBe(false);
    expect(JSON.stringify(entity.river.read({ limit: 1000 }))).not.toContain(base64);
  });

  it("is not offered without vision, and the Lar is told it cannot see pictures", async () => {
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity, send } = await open(model, []);
    await entity.start();
    send("Hello.");
    await entity.idle();
    const names = (model.requests[0]?.tools ?? []).map((spec) => spec.name);
    expect(names).not.toContain("look");
    expect(String(model.requests[0]?.messages[0]?.content)).toContain("You cannot see pictures with your current model; you can keep and send them.");
  });

  it("refuses a picture that is not on the shelf, and names the newest", async () => {
    const fake = pictureWorld(true);
    let kept = "";
    const model = new ScriptedModel([
      () => reply({ toolCalls: [call("look", { id: "m-AAAAAAAA" }, "call_look")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity, send } = await open(model, [fake.world], SEEING);
    await entity.start();
    kept = fake.body().keepPicture({ bytes: png(), name: "dog.png", from: FROM }).id;
    send("Look.");
    await entity.idle();
    expect(receiptsIn(model.requests[1]).join("\n")).toContain(`There is no picture m-AAAAAAAA on your shelf. The newest on your shelf are: ${kept}.`);
  });
});
