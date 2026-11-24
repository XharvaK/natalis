import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, Receipt, RiverRow, Tool, World, WorldEvent } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { HOW_YOU_ACT, openEntity, type Entity, type OpenEntityOptions } from "./runtime.js";

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

// Seeding a notebook is one git commit per default folder; the tests copy one seeded notebook instead.
let templateRoot: string;
let templateNotebook: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-refs-template-"));
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
  root = mkdtempSync(join(tmpdir(), "natalis-refs-"));
  dir = join(root, "iris");
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function open(
  model: ModelPort,
  extra: Partial<OpenEntityOptions> = {},
  worlds: World[] = [],
): Promise<{ entity: Entity; cli: ReturnType<typeof createCliWorld> }> {
  if (!existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(templateNotebook, join(dir, "notebook"), { recursive: true });
  }
  const cli = createCliWorld({ onSay: () => {} });
  const entity = await openEntity({ dir, config: CONFIG, model, worlds: [cli, ...worlds], ...extra });
  opened.push(entity);
  return { entity, cli };
}

function allRows(entity: Entity): RiverRow[] {
  return entity.river.read({ limit: 100_000 });
}

/** An event row written straight to the river, so no world wakes a turn and a test's own turn takes it. */
function appendEvent(entity: Entity, thread: string, text: string): RiverRow {
  return entity.river.append({ kind: "event", thread, place: thread, source: "body", text, atMs: Date.now() });
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

/** The receipts a model was shown in one request: the tool results, as JSON objects. */
function receiptsShownIn(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  return (request?.messages ?? []).flatMap((message) => {
    if (message.role !== "tool") return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });
}

/**
 * A Discord world whose says answer with the refs given here, and which records the turns it is told about.
 * Its `turnRunning` may be made to throw, and `withTurnRunning` set false leaves the method out.
 */
function discordWorld(options: {
  refs?: string[];
  turnRunningThrows?: boolean;
  withTurnRunning?: boolean;
  extraData?: Record<string, unknown>;
} = {}): {
  world: World;
  said: Array<{ place: string; text: string }>;
  turns: Array<[string, boolean]>;
  push(place: string, text: string, data?: Record<string, unknown>): void;
} {
  let emit: ((event: WorldEvent) => void) | undefined;
  const said: Array<{ place: string; text: string }> = [];
  const turns: Array<[string, boolean]> = [];
  const world: World = {
    id: "discord",
    async start(next) {
      emit = next;
    },
    async stop() {
      emit = undefined;
    },
    async say(place, text): Promise<Receipt> {
      said.push({ place, text });
      const data = {
        ...(options.refs === undefined ? {} : { refs: options.refs }),
        ...(options.extraData ?? {}),
      };
      return { ok: true, summary: "Delivered.", ...(Object.keys(data).length === 0 ? {} : { data }) };
    },
    tools: () => [],
    now: () => "discord is open.",
  };
  if (options.withTurnRunning !== false) {
    world.turnRunning = (place, running) => {
      turns.push([place, running]);
      if (options.turnRunningThrows === true) throw new Error("the world cannot show typing");
    };
  }
  return {
    world,
    said,
    turns,
    push(place, text, data) {
      if (emit === undefined) throw new Error("the discord world is not started");
      emit({ world: "discord", place, actor: "mara", source: "outside", text, ...(data === undefined ? {} : { data }) });
    },
  };
}

/** The say tool, as the turn was offered it. */
function sayTool(entity: Entity): Tool {
  const tools = (entity as unknown as { tools: Tool[] }).tools;
  const tool = tools.find((entry) => entry.spec.name === "say");
  if (tool === undefined) throw new Error("no built tool named say");
  return tool;
}

describe("a river line's head", () => {
  it("names the row number, the refs and the message a Discord line answers", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:dm:mara", "see you there", { messageRefs: ["m41", "m42"], replyToRef: "m39" });
    await entity.idle();

    const row = allRows(entity).find((item) => item.kind === "event" && item.text === "see you there");
    expect(row).toBeDefined();
    const line = eventTextOf(model.requests[0])
      .split("\n")
      .find((item) => item.includes("see you there"));
    expect(line).toMatch(new RegExp(`^\\[#${row?.seq} \\d{2}:\\d{2} mara \\(outside\\) m41 m42, replying to m39\\] see you there$`));
  });

  it("adds ', mentioned you' in a room but not in a DM", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "hang on", { messageRefs: ["m7"], mentionsHer: true });
    await entity.idle();
    discord.push("discord:dm:mara", "hang on", { messageRefs: ["m8"], mentionsHer: true });
    await entity.idle();

    const roomLine = eventTextOf(model.requests[0])
      .split("\n")
      .find((item) => item.includes("hang on"));
    const dmLine = eventTextOf(model.requests[1])
      .split("\n")
      .find((item) => item.includes("hang on"));
    expect(roomLine).toContain("mara (outside) m7, mentioned you] hang on");
    expect(dmLine).toContain("mara (outside) m8] hang on");
    expect(dmLine).not.toContain("mentioned you");
  });

  it("shows only the row number for a row with no Discord data", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "just words");
    await entity.idle();

    const row = allRows(entity).find((item) => item.kind === "event" && item.text === "just words");
    const line = eventTextOf(model.requests[0])
      .split("\n")
      .find((item) => item.includes("just words"));
    expect(line).toMatch(new RegExp(`^\\[#${row?.seq} \\d{2}:\\d{2} mara \\(outside\\)\\] just words$`));
  });
});

describe("say's refs", () => {
  it("keeps the refs the world gave in the river row and the receipt, and shows them on a later line", async () => {
    const discord = discordWorld({ refs: ["m43"] });
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "discord:room:garden", text: "on my way" })] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "are you coming?");
    await entity.idle();

    const sayRow = allRows(entity).find((row) => row.kind === "say" && row.text === "on my way");
    expect(sayRow?.data).toEqual({ refs: ["m43"] });
    const receipt = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === true);
    expect(receipt?.["summary"]).toBe("Said to discord:room:garden (m43).");
    expect(receipt?.["data"]).toMatchObject({ refs: ["m43"] });

    discord.push("discord:room:garden", "good");
    await entity.idle();

    const later = eventTextOf(model.requests[2])
      .split("\n")
      .find((item) => item.includes("on my way"));
    expect(later).toContain(`[#${sayRow?.seq} `);
    expect(later).toContain("you m43] on my way");
  });

  it("leaves the row data and the summary exactly as before when the world gives no refs", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "discord:room:garden", text: "on my way" })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "are you coming?");
    await entity.idle();

    const sayRow = allRows(entity).find((row) => row.kind === "say" && row.text === "on my way");
    expect(sayRow?.data).toBeUndefined();
    const receipt = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === true);
    expect(receipt?.["summary"]).toBe("Said to discord:room:garden.");
    expect(receipt?.["data"]).not.toHaveProperty("refs");
  });

  it("names two refs in the summary, joined with a comma", async () => {
    const discord = discordWorld({ refs: ["m43", "m44"] });
    const model = new ScriptedModel([
      reply({ toolCalls: [call("say", { place: "discord:room:garden", text: "on my way" })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "are you coming?");
    await entity.idle();

    const receipt = receiptsShownIn(model.requests[1]).find((item) => item["ok"] === true);
    expect(receipt?.["summary"]).toBe("Said to discord:room:garden (m43, m44).");
  });
});

describe("recall and the fixed text", () => {
  it("starts every recall item with the row's number", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity, cli } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "The lighthouse at the point is my favourite place.");
    await entity.idle();
    cli.send("Where is the lighthouse?");
    await entity.idle();

    const row = allRows(entity).find((item) => item.kind === "event" && item.text?.startsWith("The lighthouse"));
    const user = eventTextOf(model.requests[1]);
    expect(user).toContain("## recall");
    expect(user).toContain(`[#${row?.seq} `);
    expect(user).toContain("discord:room:garden mara] The lighthouse at the point is my favourite place.");
  });

  it("says how the row numbers and message names are used, and names the new place rule", async () => {
    const model = new ScriptedModel([]);
    const { entity } = await open(model);
    const sentence =
      "Each line of your river starts with its row number, such as #1234; mark, record_fact and recall take those numbers. A Discord line also names its messages, such as m42; react and say's reply_to take those.";
    const lines = HOW_YOU_ACT.split("\n");
    expect(lines[1]).toBe(sentence);

    const description = sayTool(entity).spec.description;
    expect(description).toContain(
      "a turn woken by a Discord place says only there; any other turn (your own time, a game) may say in one Discord place.",
    );
    expect(description).not.toContain("a Discord say goes only to the place this turn answers.");

    const replyTo = sayTool(entity).spec.parameters;
    const properties = (replyTo as { properties: Record<string, { description: string }> }).properties;
    expect(properties["reply_to"]?.description).toBe(
      "Optional. The message you answer, such as m42 (Discord) or the id another world gives.",
    );
  });
});

describe("a world hears when a turn runs in its place", () => {
  it("tells the world true at the start and false at the end of a live turn", async () => {
    const discord = discordWorld();
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "are you there?");
    await entity.idle();

    expect(discord.turns).toEqual([
      ["discord:room:garden", true],
      ["discord:room:garden", false],
    ]);
  });

  it("lets the turn end normally when the world throws from turnRunning", async () => {
    const discord = discordWorld({ turnRunningThrows: true });
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, {}, [discord.world]);
    await entity.start();

    discord.push("discord:room:garden", "are you there?");
    await entity.idle();

    const ends = allRows(entity).filter((row) => row.kind === "turn" && row.data?.["phase"] === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.data?.["endedBy"]).toBe("end_turn");
    expect(discord.turns).toHaveLength(2);
  });

  it("runs a turn in a thread with no world, and a world without the method, as before", async () => {
    const discord = discordWorld({ withTurnRunning: false });
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const { entity } = await open(model, { stopPollMs: 1e9 }, [discord.world]);
    await entity.start();

    // A live turn the scheduler starts for a thread no world owns: nothing to tell, and the turn runs as usual.
    appendEvent(entity, "self", "A thought.");
    const scheduler = entity as unknown as { due: Set<string>; pump(): void };
    scheduler.due.add("self");
    scheduler.pump();
    await entity.idle();
    expect(model.requests).toHaveLength(1);

    // A world with no turnRunning at all: its turn runs too.
    discord.push("discord:room:garden", "are you there?");
    await entity.idle();

    const selfEnds = allRows(entity).filter((row) => row.kind === "turn" && row.data?.["phase"] === "end" && row.thread === "self");
    expect(selfEnds).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
    expect(discord.turns).toEqual([]);
  });
});
