import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelPort, Receipt, RiverRow, Tool, ToolContext, World, WorldEvent } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { CLI_PLACE, createCliWorld, type CliWorld } from "../worlds/cli.js";
import type { EntityConfig } from "./config.js";
import { ANYWHERE, grantsPath, openGrants, type GrantRow, type Grants } from "./grants.js";
import { openEntity, type Entity } from "./runtime.js";

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};

const BASE = 1_760_000_000_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 5 })));

type Harness = {
  entity: Entity;
  dir: string;
  cli: CliWorld;
  said: Array<{ place: string; text: string }>;
  now(): number;
  advance(ms: number): void;
  tool(name: string, thread?: string): Tool;
  context(thread?: string, turnId?: string): ToolContext;
  invoke(name: string, args: Record<string, unknown>, options?: { thread?: string; turnId?: string }): Promise<Receipt>;
  ownerRow(text?: string, place?: string): RiverRow;
  seedRequest(options?: {
    tool?: string;
    scope?: string;
    argsHmac?: string;
    askingThread?: string;
    text?: string;
  }): { row: RiverRow; id: number };
  grants(): Grants;
  listGrants(): GrantRow[];
  readbacks(): ReadbackRecord[];
  requests(): RequestRecord[];
  grantLog(): Array<{ seq: number; at: number; grant_id: number | null; event: string }>;
};

type ReadbackRecord = {
  id: number;
  items: Array<{ requestId: number; kind: string; scope: string }>;
  posted_seq: number;
  status: string;
  created_at: number;
  closed_at: number | null;
};

type RequestRecord = {
  id: number;
  tool: string;
  scope_key: string;
  args_hmac: string;
  posted_seq: number;
  place: string;
  asking_thread: string;
  status: string;
};

let harness: Harness | undefined;

async function openHarness(
  options: { tools?: Record<string, string>; worlds?: World[]; model?: ModelPort; purpose?: "live" | "eval" | "replay" } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "natalis-permissions-"));
  roots.push(root);
  const dir = join(root, "lar");
  let now = BASE;
  const said: Array<{ place: string; text: string }> = [];
  const cli = createCliWorld({ onSay: (place, text) => said.push({ place, text }) });
  const model =
    options.model ??
    new ScriptedModel(Array.from({ length: 100 }, () => () => reply({ toolCalls: [call("end_turn")] })));
  const config = options.tools === undefined ? CONFIG : { ...CONFIG, tools: options.tools };
  const entity = await openEntity({
    dir,
    config,
    model,
    worlds: [cli, ...(options.worlds ?? [])],
    nowMs: () => now,
    stopPollMs: 1e9,
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  });
  await entity.start();
  cli.send("Hello.");
  await entity.idle();

  const tool = (name: string, thread = CLI_PLACE): Tool => {
    const tools = (entity as unknown as { toolsFor(value: string): Tool[] }).toolsFor(thread);
    const found = tools.find((item) => item.spec.name === name);
    if (found === undefined) throw new Error(`no tool named ${name} in ${thread}`);
    return found;
  };
  const context = (thread = CLI_PLACE, turnId = "turn-1"): ToolContext => ({
    thread,
    turnId,
    nowMs: now,
    river: entity.river,
    notebook: entity.notebook,
  });
  const grants = (): Grants => openGrants(dir);
  const listGrants = (): GrantRow[] => {
    const opened = openGrants(dir);
    try {
      return opened.listGrants();
    } finally {
      opened.close();
    }
  };
  const readbacks = (): ReadbackRecord[] => {
    const db = new DatabaseSync(grantsPath(dir));
    try {
      const rows = db.prepare("SELECT * FROM readbacks ORDER BY id").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row["id"]),
        items: JSON.parse(String(row["items"])) as ReadbackRecord["items"],
        posted_seq: Number(row["posted_seq"]),
        status: String(row["status"]),
        created_at: Number(row["created_at"]),
        closed_at: row["closed_at"] === null ? null : Number(row["closed_at"]),
      }));
    } finally {
      db.close();
    }
  };
  const requests = (): RequestRecord[] => {
    const db = new DatabaseSync(grantsPath(dir));
    try {
      const rows = db.prepare("SELECT * FROM requests ORDER BY id").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row["id"]),
        tool: String(row["tool"]),
        scope_key: String(row["scope_key"]),
        args_hmac: String(row["args_hmac"]),
        posted_seq: Number(row["posted_seq"]),
        place: String(row["place"]),
        asking_thread: String(row["asking_thread"]),
        status: String(row["status"]),
      }));
    } finally {
      db.close();
    }
  };
  const grantLog = (): Array<{ seq: number; at: number; grant_id: number | null; event: string }> => {
    const db = new DatabaseSync(grantsPath(dir));
    try {
      const rows = db.prepare("SELECT seq, at, grant_id, event FROM grant_log ORDER BY seq").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        seq: Number(row["seq"]),
        at: Number(row["at"]),
        grant_id: row["grant_id"] === null ? null : Number(row["grant_id"]),
        event: String(row["event"]),
      }));
    } finally {
      db.close();
    }
  };
  const hmac = (args: Record<string, unknown>): string => {
    const opened = openGrants(dir);
    try {
      return opened.hmac(args);
    } finally {
      opened.close();
    }
  };
  const seedRequest: Harness["seedRequest"] = (seed = {}) => {
    const toolName = seed.tool ?? "write_note";
    const scope = seed.scope ?? ANYWHERE;
    const askingThread = seed.askingThread ?? CLI_PLACE;
    const row = entity.river.append({
      thread: CLI_PLACE,
      place: CLI_PLACE,
      kind: "say",
      source: "body",
      text: seed.text ?? `[natalis] Iris asks to use ${toolName}.`,
      data: { permissionRequest: true, tool: toolName, scope },
      atMs: now,
    });
    const opened = openGrants(dir);
    try {
      const id = opened.request({
        tool: toolName,
        scopeKey: scope,
        argsHmac: seed.argsHmac ?? hmac({ path: "character.md" }),
        postedSeq: row.seq,
        place: CLI_PLACE,
        askingThread,
        nowMs: now,
      });
      return { row, id };
    } finally {
      opened.close();
    }
  };
  const ownerRow = (text = "Yes, go ahead.", place = CLI_PLACE): RiverRow =>
    entity.river.append({ thread: place, place, kind: "event", source: "owner", actor: "owner", text, atMs: now });

  harness = {
    entity,
    dir,
    cli,
    said,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    tool,
    context,
    invoke: (name, args, options = {}) =>
      tool(name, options.thread).run(args, context(options.thread, options.turnId)),
    ownerRow,
    seedRequest,
    grants,
    listGrants,
    readbacks,
    requests,
    grantLog,
  };
  return harness;
}

async function closeHarness(): Promise<void> {
  if (harness === undefined) return;
  await harness.entity.stop();
  harness = undefined;
}

function refusal(receipt: Receipt): { code?: string; reason?: string } {
  return receipt.refused ?? {};
}

function ownerRowArgs(seq: number): { owner_row: number } {
  return { owner_row: seq };
}

function pinSnapshot(h: Harness, turnId: string, seq: number): void {
  (h.entity as unknown as { turnSnapshots: Map<string, number> }).turnSnapshots.set(turnId, seq);
}

/** A world with one tool that always throws, so a call's outcome is a tool error after the gate has allowed it. */
function throwingWorld(): World {
  const tool: Tool = {
    spec: {
      name: "forge_probe",
      description: "A probe that fails.",
      parameters: { type: "object", properties: {} },
    },
    async run(): Promise<Receipt> {
      throw new Error("the probe failed");
    },
  };
  return {
    id: "forge",
    async start() {},
    async stop() {},
    async say(): Promise<Receipt> {
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [tool],
    now: () => "Forge is open.",
  };
}

/** A world whose one tool waits until the test releases it, so a take-back can happen while it runs. */
function slowWorld(): { world: World; started: Promise<void>; release(): void } {
  let start: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const world: World = {
    id: "forge",
    async start() {},
    async stop() {},
    async say(): Promise<Receipt> {
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [
      {
        spec: { name: "slow_probe", description: "A probe that waits.", parameters: { type: "object", properties: {} } },
        async run(): Promise<Receipt> {
          start?.();
          await gate;
          return { ok: true, summary: "The probe finished." };
        },
      },
    ],
    now: () => "Forge is open.",
  };
  return { world, started, release: () => release?.() };
}

/** A world that emits one event the test drives, and offers a read tool that always throws (for the retry test). */
function emitterWithReadTool(): {
  world: World;
  emit(event: Partial<WorldEvent> & { place: string; text: string }): void;
} {
  let push: ((event: WorldEvent) => void) | undefined;
  const world: World = {
    id: "discord",
    async start(emit) {
      push = emit;
    },
    async stop() {
      push = undefined;
    },
    async say(): Promise<Receipt> {
      return { ok: true, summary: "Delivered." };
    },
    tools: () => [
      {
        spec: {
          name: "read_history",
          description: "A read that fails.",
          parameters: { type: "object", properties: { place: { type: "string" } } },
        },
        async run(): Promise<Receipt> {
          throw new Error("the read failed");
        },
      },
    ],
    now: () => "Discord is open.",
  };
  return {
    world,
    emit: (event) => push?.({ world: "discord", source: "outside", ...event } as WorldEvent),
  };
}

describe("her tools and the checks (B4 Q2)", () => {
  beforeEach(() => {
    harness = undefined;
  });
  afterEach(async () => {
    await closeHarness();
  });

  it("offers answer_request, confirm_answer, take_back and permissions in every thread, and keeps the reflect allowlist", async () => {
    const h = await openHarness();
    const names = (thread: string, purpose?: "reflect"): string[] =>
      (h.entity as unknown as { toolsFor(value: string, purpose?: string): Tool[] })
        .toolsFor(thread, purpose)
        .map((item) => item.spec.name);

    for (const thread of [CLI_PLACE, "self", "discord:room:garden"]) {
      expect(names(thread)).toEqual(
        expect.arrayContaining(["answer_request", "confirm_answer", "take_back", "permissions"]),
      );
    }
    expect(names("self", "reflect")).toEqual(["read_note", "list_notes", "recall", "write_note", "edit_note", "append_note"]);
  });

  it("refuses every one of the four tools outside the summoner's place", async () => {
    const h = await openHarness();
    const args: Record<string, Record<string, unknown>> = {
      answer_request: { request: 1, answer: "once", owner_row: 1 },
      confirm_answer: { confirmation: 1, agreed: true, owner_row: 1 },
      take_back: { grant: 1, owner_row: 1 },
      permissions: {},
    };
    for (const [name, callArgs] of Object.entries(args)) {
      const receipt = await h.invoke(name, callArgs, { thread: "discord:room:garden" });
      expect(receipt.ok).toBe(false);
      expect(refusal(receipt).code).toBe("not_summoner_place");
    }
  });

  it("who answered: only an unforgotten owner row in the summoner's place, no newer than this turn counts", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest();
    const outside = h.entity.river.append({
      thread: CLI_PLACE,
      place: CLI_PLACE,
      kind: "event",
      source: "outside",
      actor: "mara",
      text: "I am not the owner.",
      atMs: h.now(),
    });
    const wrongPlace = h.ownerRow("Yes.", "discord:room:garden");
    const forgotten = h.ownerRow("Yes, always.");
    h.entity.river.forget({ seqs: [forgotten.seq] }, "owner", "test");

    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", owner_row: outside.seq })).code).toBe(
      "not_owner_row",
    );
    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", owner_row: wrongPlace.seq })).code).toBe(
      "not_owner_row",
    );
    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", owner_row: forgotten.seq })).code).toBe(
      "owner_row_forgotten",
    );

    const snapshot = h.entity.river.lastSeq();
    pinSnapshot(h, "turn-snapshot", snapshot);
    const duringTurn = h.ownerRow("Yes, during the turn.");
    const receipt = await h.invoke("answer_request", { request: id, answer: "once", owner_row: duringTurn.seq }, {
      turnId: "turn-snapshot",
    });
    expect(refusal(receipt).code).toBe("owner_row_after_snapshot");
    expect(h.readbacks()).toHaveLength(0);
  });

  it("order: an owner row older than the request is refused, and older than the read-back is refused", async () => {
    const h = await openHarness();
    const older = h.ownerRow("Yes, go ahead.");
    const { id } = h.seedRequest();
    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(older.seq) })).code).toBe(
      "owner_row_before_request",
    );

    const first = h.ownerRow("Yes, always.");
    const opened = await h.invoke("answer_request", { request: id, answer: "always", ...ownerRowArgs(first.seq) });
    expect(opened.ok).toBe(false);
    const [readback] = h.readbacks();
    expect(readback).toBeDefined();
    expect(
      refusal(await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(first.seq) })).code,
    ).toBe("owner_row_before_readback");
  });

  it("open: an answered request and an expired read-back are refused", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest();
    const yes = h.ownerRow("No, not this time.");
    expect((await h.invoke("answer_request", { request: id, answer: "no", ...ownerRowArgs(yes.seq) })).ok).toBe(true);
    const later = h.ownerRow("Actually yes.");
    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(later.seq) })).code).toBe(
      "request_not_open",
    );

    const second = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const answer = h.ownerRow("Yes, always.");
    await h.invoke("answer_request", { request: second.id, answer: "always", ...ownerRowArgs(answer.seq) });
    const [readback] = h.readbacks();
    h.advance(FIFTEEN_MINUTES);
    const late = h.ownerRow("Yes.");
    expect(
      refusal(await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(late.seq) })).code,
    ).toBe("readback_expired");
    expect(h.readbacks()[0]?.status).toBe("expired");
  });

  it("a request older than twenty-four hours is refused", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest();
    h.advance(DAY);
    const late = h.ownerRow("Yes.");
    expect(refusal(await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(late.seq) })).code).toBe(
      "request_expired",
    );
  });

  it("once with one request waiting needs no read-back and stores the exact call", async () => {
    const h = await openHarness();
    const args = { path: "character.md" };
    const opened = h.grants();
    let hash = "";
    try {
      hash = opened.hmac(args);
    } finally {
      opened.close();
    }
    const { id } = h.seedRequest({ tool: "write_note", scope: ANYWHERE, argsHmac: hash });
    const yes = h.ownerRow("Yes, once.");
    const receipt = await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(yes.seq) });
    expect(receipt.ok).toBe(true);
    expect(h.readbacks()).toHaveLength(0);
    const grants = h.grants();
    try {
      const [grant] = grants.listGrants();
      expect(grant).toMatchObject({ tool: "write_note", scope: ANYWHERE, kind: "once", argsHmac: hash, requestSeq: id });
      expect(grant?.usedAt).toBeUndefined();
    } finally {
      grants.close();
    }
    expect(h.requests()[0]?.status).toBe("answered");
    expect(h.said.some((line) => line.text === "[natalis] Allowed once: write_note anywhere.")).toBe(true);
    const event = h.entity.river
      .read({ thread: CLI_PLACE, kinds: ["event"], limit: 100 })
      .find((row) => row.source === "body" && String(row.text).includes("allowed write_note anywhere once"));
    expect(event).toBeDefined();
  });

  it("always goes through a read-back whose kind and scope are stored exactly as agreed", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const yes = h.ownerRow("Yes, always for that forum.");
    const opened = await h.invoke("answer_request", { request: id, answer: "always", ...ownerRowArgs(yes.seq) });
    expect(opened.ok).toBe(false);
    expect(refusal(opened).code).toBe("readback_waiting");
    const [readback] = h.readbacks();
    expect(readback?.items).toEqual([{ requestId: id, kind: "always", scope: "forum.example.org" }]);
    expect(h.said.at(-1)?.text).toBe(
      "[natalis] Iris read your answer as: ALWAYS allow web_request on forum.example.org, until you take it back. " +
        "Nothing is stored until you agree. This closes in 15 minutes.",
    );
    expect(h.listGrants()).toEqual([]);

    const agreed = h.ownerRow("Yes, that is right.");
    const stored = await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(agreed.seq) });
    expect(stored.ok).toBe(true);
    const grants = h.grants();
    try {
      expect(grants.listGrants()).toEqual([
        expect.objectContaining({ tool: "web_request", scope: "forum.example.org", kind: "always", requestSeq: id }),
      ]);
    } finally {
      grants.close();
    }
    expect(h.said.some((line) => line.text === "[natalis] Stored: always allow web_request on forum.example.org. Tell Iris any time to take it back.")).toBe(true);
    expect(h.requests()[0]?.status).toBe("answered");
  });

  it("anywhere goes through a read-back that says ANYWHERE and stores the whole tool scope", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const yes = h.ownerRow("Yes, anywhere.");
    await h.invoke("answer_request", { request: id, answer: "always", where: "anywhere", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    expect(readback?.items).toEqual([{ requestId: id, kind: "always", scope: ANYWHERE }]);
    expect(h.said.at(-1)?.text).toContain("ANYWHERE");
    const agreed = h.ownerRow("Yes.");
    await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(agreed.seq) });
    expect(h.listGrants()).toEqual([expect.objectContaining({ scope: ANYWHERE, kind: "always" })]);
  });

  it("no never needs a read-back, stores nothing and closes only the request named", async () => {
    const h = await openHarness();
    const one = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const two = h.seedRequest({ tool: "write_note", scope: ANYWHERE });
    const no = h.ownerRow("No, not this time.");
    const receipt = await h.invoke("answer_request", { request: one.id, answer: "no", ...ownerRowArgs(no.seq) });
    expect(receipt.ok).toBe(true);
    expect(h.readbacks()).toHaveLength(0);
    expect(h.listGrants()).toEqual([]);
    expect(h.requests().map((row) => [row.id, row.status])).toEqual([
      [one.id, "answered"],
      [two.id, "open"],
    ]);
    expect(h.said.some((line) => line.text === "[natalis] Not stored.")).toBe(true);
    const event = h.entity.river
      .read({ thread: CLI_PLACE, kinds: ["event"], limit: 100 })
      .find((row) => row.source === "body" && String(row.text).includes("said no to web_request on forum.example.org"));
    expect(event).toBeDefined();
  });

  it("several requests waiting: one read-back lists them by number and a single yes stores each", async () => {
    const h = await openHarness();
    const one = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const two = h.seedRequest({ tool: "say", scope: "discord:room:garden" });
    const yes = h.ownerRow("Yes, all of them once.");
    await h.invoke("answer_request", { request: one.id, answer: "once", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    expect(readback?.items).toEqual([
      { requestId: one.id, kind: "once", scope: "forum.example.org" },
      { requestId: two.id, kind: "once", scope: "discord:room:garden" },
    ]);
    expect(h.said.at(-1)?.text).toContain("ONCE for: 1 ");
    expect(h.said.at(-1)?.text).toContain("2 ");
    expect(h.said.at(-1)?.text).toContain("web_request on forum.example.org");
    expect(h.said.at(-1)?.text).toContain("say on discord:room:garden");

    const agreed = h.ownerRow("Yes, that is right.");
    const stored = await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(agreed.seq) });
    expect(stored.ok).toBe(true);
    const grants = h.grants();
    try {
      expect(grants.listGrants().map((grant) => [grant.tool, grant.scope, grant.kind])).toEqual([
        ["web_request", "forum.example.org", "once"],
        ["say", "discord:room:garden", "once"],
      ]);
    } finally {
      grants.close();
    }
    expect(h.requests().map((row) => row.status)).toEqual(["answered", "answered"]);
  });

  it("one read-back lists at most five requests", async () => {
    const h = await openHarness();
    const seeded = Array.from({ length: 6 }, (_, index) =>
      h.seedRequest({ tool: `tool_${index + 1}`, scope: `place_${index + 1}.example.org` }),
    );
    const yes = h.ownerRow("Yes, all of them once.");
    await h.invoke("answer_request", { request: seeded[0]!.id, answer: "once", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    expect(readback?.items).toHaveLength(5);
    expect(readback?.items.map((item) => item.requestId)).toEqual(seeded.slice(0, 5).map((item) => item.id));
  });

  it("a second answer that needs a read-back is refused while one is open", async () => {
    const h = await openHarness();
    const one = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const two = h.seedRequest({ tool: "write_note", scope: ANYWHERE });
    const first = h.ownerRow("Yes, always.");
    await h.invoke("answer_request", { request: one.id, answer: "always", ...ownerRowArgs(first.seq) });
    const second = h.ownerRow("Yes, always for this one too.");
    const receipt = await h.invoke("answer_request", { request: two.id, answer: "always", ...ownerRowArgs(second.seq) });
    expect(refusal(receipt).code).toBe("readback_waiting");
    expect(String(refusal(receipt).reason).toLowerCase()).toContain("one read-back is waiting");
    expect(h.readbacks()).toHaveLength(1);
  });

  it("a read-back closes after fifteen minutes and a yes must be newer than it", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const yes = h.ownerRow("Yes, always.");
    await h.invoke("answer_request", { request: id, answer: "always", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    h.advance(FIFTEEN_MINUTES);
    const late = h.ownerRow("Yes.");
    const receipt = await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(late.seq) });
    expect(refusal(receipt).code).toBe("readback_expired");
    expect(h.readbacks()[0]?.status).toBe("expired");
    expect(h.listGrants()).toEqual([]);
  });

  it("take_back revokes a standing grant at once, needs no read-back and fails safe", async () => {
    const h = await openHarness({ tools: { write_note: "ask" } });
    const opened = h.grants();
    let grantId = 0;
    try {
      grantId = opened.addGrant({ tool: "write_note", scope: ANYWHERE, kind: "always", createdBy: "owner", nowMs: h.now() });
    } finally {
      opened.close();
    }
    const yes = h.ownerRow("Take that back.");
    const receipt = await h.invoke("take_back", { grant: grantId, ...ownerRowArgs(yes.seq) });
    expect(receipt.ok).toBe(true);
    expect(h.readbacks()).toHaveLength(0);
    const grants = h.grants();
    try {
      expect(grants.listGrants()[0]?.revokedAt).toBe(h.now());
    } finally {
      grants.close();
    }
    const again = h.ownerRow("Take that back.");
    expect(refusal(await h.invoke("take_back", { grant: grantId, ...ownerRowArgs(again.seq) })).code).toBe("grant_not_found");
  });

  it("a take-back between two calls in one turn makes the second ask", async () => {
    const h = await openHarness({ tools: { write_note: "ask" } });
    const opened = h.grants();
    let grantId = 0;
    try {
      grantId = opened.addGrant({ tool: "write_note", scope: ANYWHERE, kind: "always", createdBy: "owner", nowMs: h.now() });
    } finally {
      opened.close();
    }
    const args = { path: "notes/first.md", text: "First.", why: "test" };
    const first = await h.invoke("write_note", args, { turnId: "one-turn" });
    expect(first.ok).toBe(true);
    const owner = h.ownerRow("Take that back.");
    expect((await h.invoke("take_back", { grant: grantId, ...ownerRowArgs(owner.seq) }, { turnId: "one-turn" })).ok).toBe(true);
    const second = await h.invoke("write_note", { path: "notes/second.md", text: "Second.", why: "test" }, { turnId: "one-turn" });
    expect(second.ok).toBe(false);
    expect(refusal(second).code).toBe("ask_summoner");
    expect(h.requests()).toHaveLength(1);
  });

  it("permissions lists standing grants and refusals, open requests and the open read-back, read only", async () => {
    const h = await openHarness();
    const opened = h.grants();
    try {
      opened.addGrant({ tool: "web_request", scope: "forum.example.org", kind: "always", createdBy: "owner", nowMs: h.now() });
      opened.addGrant({ tool: "say", scope: "discord:room:garden", kind: "never", createdBy: "owner", nowMs: h.now() });
    } finally {
      opened.close();
    }
    const { id } = h.seedRequest({ tool: "write_note", scope: ANYWHERE });
    const yes = h.ownerRow("Yes, always.");
    await h.invoke("answer_request", { request: id, answer: "always", ...ownerRowArgs(yes.seq) });
    const before = h.readbacks();

    const listed = await h.invoke("permissions", {});
    expect(listed.ok).toBe(true);
    expect(listed.summary).toContain("web_request on forum.example.org");
    expect(listed.summary).toContain("say on discord:room:garden");
    expect(listed.summary).toContain("Open requests");
    expect(listed.summary).toContain(`Read-back ${before[0]!.id}`);
    expect(listed.summary).toContain("write_note anywhere");
    expect(h.readbacks()).toEqual(before);
    expect(h.listGrants().map((grant) => grant.revokedAt)).toEqual([undefined, undefined]);
  });

  it("permissions also works in her self thread", async () => {
    const h = await openHarness();
    const listed = await h.invoke("permissions", {}, { thread: "self" });
    expect(listed.ok).toBe(true);
  });

  it("a once grant is marked used before the tool runs, so a failing run still consumes it", async () => {
    const h = await openHarness({ tools: { forge_probe: "ask" }, worlds: [throwingWorld()] });
    const opened = h.grants();
    try {
      opened.addGrant({
        tool: "forge_probe",
        scope: ANYWHERE,
        kind: "once",
        argsHmac: opened.hmac({}),
        createdBy: "owner",
        nowMs: h.now(),
      });
    } finally {
      opened.close();
    }
    await expect(h.invoke("forge_probe", {})).rejects.toThrow(/probe failed/);
    const grants = h.grants();
    try {
      expect(grants.listGrants()[0]?.usedAt).toBe(h.now());
    } finally {
      grants.close();
    }
  });

  it("three runs of a read tool in one call count as one use of a once grant", async () => {
    const { world, emit } = emitterWithReadTool();
    const model = new ScriptedModel([
      reply({ toolCalls: [call("read_history", { place: "discord:room:garden" })] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const root = mkdtempSync(join(tmpdir(), "natalis-permissions-"));
    roots.push(root);
    const dir = join(root, "lar");
    let now = BASE;
    const cli = createCliWorld({ onSay: () => {} });
    const entity = await openEntity({
      dir,
      config: { ...CONFIG, tools: { read_history: "ask" } },
      model,
      worlds: [cli, world],
      nowMs: () => now,
      stopPollMs: 1e9,
    });
    try {
      const opened = openGrants(dir);
      try {
        opened.addGrant({
          tool: "read_history",
          scope: "discord:room:garden",
          kind: "once",
          argsHmac: opened.hmac({ place: "discord:room:garden" }),
          createdBy: "owner",
          nowMs: now,
        });
      } finally {
        opened.close();
      }
      await entity.start();
      emit({ place: "discord:room:garden", text: "Read this room." });
      await entity.idle();
      const rows = entity.river.read({ limit: 100_000 });
      const notes = rows.filter((row) => row.kind === "note" && row.data?.["retryOf"] === "read_history");
      expect(notes).toHaveLength(2);
      const log = (() => {
        const db = new DatabaseSync(grantsPath(dir));
        try {
          return db.prepare("SELECT event FROM grant_log ORDER BY seq").all() as Array<{ event: string }>;
        } finally {
          db.close();
        }
      })();
      expect(log.filter((row) => row.event === "used")).toHaveLength(1);
    } finally {
      await entity.stop();
    }
  });

  it("a once-grant event row wakes the asking thread", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "write_note", scope: ANYWHERE, askingThread: "discord:room:garden" });
    const yes = h.ownerRow("Yes, once.");
    await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(yes.seq) });
    await h.entity.idle();
    const event = h.entity.river
      .read({ thread: "discord:room:garden", kinds: ["event"], limit: 100 })
      .find((row) => row.source === "body" && String(row.text).includes("allowed write_note anywhere once"));
    expect(event).toBeDefined();
    const turn = h.entity.river
      .read({ thread: "discord:room:garden", kinds: ["turn"], limit: 100 })
      .find((row) => row.data?.["phase"] === "end");
    expect(turn).toBeDefined();
  });

  it("a read-back declined with no stores nothing and leaves the request waiting", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org" });
    const yes = h.ownerRow("Yes, always.");
    await h.invoke("answer_request", { request: id, answer: "always", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    const no = h.ownerRow("No, that is wrong.");
    const receipt = await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: false, ...ownerRowArgs(no.seq) });
    expect(receipt.ok).toBe(true);
    expect(h.said.some((line) => line.text === "[natalis] Not stored.")).toBe(true);
    expect(h.listGrants()).toEqual([]);
    expect(h.requests()[0]?.status).toBe("open");
    expect(h.readbacks()[0]?.status).toBe("declined");
  });

  it("never stores a standing refusal only after the read-back, and that refusal wins over a grant", async () => {
    const h = await openHarness({ tools: { say: "ask" } });
    const { id } = h.seedRequest({ tool: "say", scope: "discord:room:garden" });
    const yes = h.ownerRow("No, never for that room.");
    await h.invoke("answer_request", { request: id, answer: "never", ...ownerRowArgs(yes.seq) });
    const [readback] = h.readbacks();
    expect(readback?.items).toEqual([{ requestId: id, kind: "never", scope: "discord:room:garden" }]);
    expect(h.said.at(-1)?.text).toBe(
      "[natalis] Iris read your answer as: NEVER allow say on discord:room:garden, until you take it back. " +
        "Nothing is stored until you agree. This closes in 15 minutes.",
    );
    const agreed = h.ownerRow("Yes, that is right.");
    await h.invoke("confirm_answer", { confirmation: readback!.id, agreed: true, ...ownerRowArgs(agreed.seq) });
    expect(h.listGrants()).toEqual([expect.objectContaining({ tool: "say", scope: "discord:room:garden", kind: "never" })]);
    expect(h.said.some((line) => line.text === "[natalis] Stored: never allow say on discord:room:garden. Tell Iris any time to take it back.")).toBe(true);
    const event = h.entity.river
      .read({ thread: CLI_PLACE, kinds: ["event"], limit: 100 })
      .find((row) => row.source === "body" && String(row.text).includes("said never to say on discord:room:garden"));
    expect(event).toBeDefined();

    // A standing grant for the same tool and scope does not beat the refusal.
    const opened = h.grants();
    try {
      opened.addGrant({ tool: "say", scope: "discord:room:garden", kind: "always", createdBy: "owner", nowMs: h.now() });
    } finally {
      opened.close();
    }
    const refused = await h.invoke("say", { place: "discord:room:garden", text: "Hello." });
    expect(refused.ok).toBe(false);
    expect(refusal(refused).code).toBe("refused_by_grant");
  });

  it("a call already running finishes when a take-back lands, and its log row shows it began first", async () => {
    const slow = slowWorld();
    const h = await openHarness({ tools: { slow_probe: "ask" }, worlds: [slow.world] });
    const opened = h.grants();
    let grantId = 0;
    try {
      grantId = opened.addGrant({ tool: "slow_probe", scope: ANYWHERE, kind: "always", createdBy: "owner", nowMs: h.now() });
    } finally {
      opened.close();
    }
    const running = h.invoke("slow_probe", {});
    await slow.started;
    h.advance(1_000);
    const owner = h.ownerRow("Take that back.");
    expect((await h.invoke("take_back", { grant: grantId, ...ownerRowArgs(owner.seq) })).ok).toBe(true);
    slow.release();
    const finished = await running;
    expect(finished.ok).toBe(true);

    const rows = h.grantLog().filter((row) => row.grant_id === grantId);
    const used = rows.find((row) => row.event === "used");
    const revoked = rows.find((row) => row.event === "revoked");
    expect(used).toBeDefined();
    expect(revoked).toBeDefined();
    expect(used!.at).toBeLessThan(revoked!.at);

    const later = await h.invoke("slow_probe", {});
    expect(later.ok).toBe(false);
    expect(refusal(later).code).toBe("ask_summoner");
  });
});

describe("permission lifetime and copies (B4 Q3)", () => {
  beforeEach(() => {
    harness = undefined;
  });
  afterEach(async () => {
    await closeHarness();
  });

  it("a request unanswered for a day closes with one line to him and one row to her asking thread", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org", askingThread: "discord:room:garden" });
    h.advance(DAY + 1);
    h.cli.send("A day later.");
    await h.entity.idle();

    expect(h.requests().find((request) => request.id === id)?.status).toBe("expired");
    expect(h.said).toContainEqual({
      place: CLI_PLACE,
      text: "[natalis] Closed without an answer: web_request on forum.example.org.",
    });
    const event = h.entity.river
      .read({ thread: "discord:room:garden", kinds: ["event"], limit: 100 })
      .find((row) => row.data?.["permissionClosed"] === "expired" && row.data?.["request"] === id);
    expect(event).toBeDefined();
    expect(event?.source).toBe("body");
    expect(String(event?.text)).toContain("closed without an answer");
  });

  it("an unused once grant closes after a day and her asking thread is told, without a 'without an answer' line", async () => {
    const h = await openHarness();
    const { id } = h.seedRequest({ tool: "web_request", scope: "forum.example.org", askingThread: "discord:room:garden" });
    const yes = h.ownerRow("Yes, once.");
    expect((await h.invoke("answer_request", { request: id, answer: "once", ...ownerRowArgs(yes.seq) })).ok).toBe(true);
    const [grant] = h.listGrants();
    expect(grant).toBeDefined();

    h.advance(DAY + 1);
    h.cli.send("A day later.");
    await h.entity.idle();

    expect(h.listGrants().find((item) => item.id === grant!.id)?.revokedAt).toBe(h.now());
    expect(h.grantLog()).toContainEqual(expect.objectContaining({ grant_id: grant!.id, event: "dropped" }));
    const event = h.entity.river
      .read({ thread: "discord:room:garden", kinds: ["event"], limit: 100 })
      .find((row) => row.data?.["permissionClosed"] === "dropped" && row.data?.["grant"] === grant!.id);
    expect(event).toBeDefined();
    expect(String(event?.text)).toContain("closed unused");
    expect(h.said.some((line) => line.text.includes("Closed without an answer"))).toBe(false);
  });

  it("an eval Lar starts with an empty grants.db, so an ask tool asks there", async () => {
    const h = await openHarness({ tools: { write_note: "ask" }, purpose: "eval" });
    const receipt = await h.invoke("write_note", { path: "notes/a.md", text: "A note.", why: "test" });
    expect(receipt.ok).toBe(false);
    expect(refusal(receipt).code).toBe("ask_summoner");
    expect(h.requests()).toHaveLength(1);
    expect(h.listGrants()).toEqual([]);
  });
});
