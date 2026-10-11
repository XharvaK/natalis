import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ModelRequest, type ModelResponse, type ToolContext, type WorldEvent } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { replayModel } from "./model.js";
import { REPLAY_CANCEL_WAKE, REPLAY_WAKE, ReplayRecorder, ReplayWorld } from "./world.js";

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-replay-world-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function context(thread = "cli:owner"): ToolContext {
  return {
    thread,
    turnId: "turn-1",
    nowMs: T0,
    river: undefined as unknown as ToolContext["river"],
    notebook: undefined as unknown as ToolContext["notebook"],
  };
}

function transcriptRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ReplayWorld", () => {
  it("records a say and gives back an ok receipt, delivering nothing", async () => {
    const recorder = new ReplayRecorder(join(root, "transcript.jsonl"), T0);
    const world = new ReplayWorld("cli", recorder);
    const receipt = await world.say("cli:owner", "Hello, Mara.", { replyTo: "m-7" });
    expect(receipt).toMatchObject({ ok: true, summary: "Said to cli:owner.", data: { place: "cli:owner", chars: 12 } });
    await world.say("cli:owner", "Still here.");
    expect(transcriptRows(join(root, "transcript.jsonl"))).toEqual([
      { atMs: T0, place: "cli:owner", text: "Hello, Mara.", replyTo: "m-7" },
      { atMs: T0, place: "cli:owner", text: "Still here." },
    ]);
    expect(recorder.counts()).toEqual({ says: 2, wakes: 0 });
    expect(world.now()).toBe("replay");
  });

  it("refuses to feed an event before it is started, and feeds through the emit it was given", async () => {
    const recorder = new ReplayRecorder(join(root, "transcript.jsonl"), T0);
    const world = new ReplayWorld("cli", recorder);
    const event: WorldEvent = { world: "cli", place: "cli:owner", source: "owner", text: "hi", atMs: T0 };
    expect(() => world.feed(event)).toThrow(/was not started/);
    const got: WorldEvent[] = [];
    await world.start((item) => got.push(item));
    world.feed(event);
    expect(got).toEqual([event]);
    await world.stop();
    expect(() => world.feed(event)).toThrow(/was not started/);
  });

  it("offers the replay wake tools, and no others", () => {
    const offering = new ReplayWorld("cli", new ReplayRecorder(join(root, "t.jsonl"), T0), true);
    expect(offering.tools().map((tool) => tool.spec.name)).toEqual([REPLAY_WAKE, REPLAY_CANCEL_WAKE]);
    const plain = new ReplayWorld("discord", new ReplayRecorder(join(root, "u.jsonl"), T0));
    expect(plain.tools()).toEqual([]);
  });
});

describe("replay wake tools", () => {
  it("records a wake with minutes and gives the same kind of receipt as a real one", async () => {
    const path = join(root, "transcript.jsonl");
    const recorder = new ReplayRecorder(path, T0);
    const [wake] = new ReplayWorld("cli", recorder, true).tools();
    const receipt = await wake!.run({ in_minutes: 30, why: "look at the harbour" }, context("room:harbour"));
    expect(receipt.ok).toBe(true);
    const id = String(receipt.data?.["id"]);
    expect(receipt.summary).toBe(`Wake ${id} set for ${new Date(T0 + 30 * 60_000).toISOString()}.`);
    expect(transcriptRows(path)).toEqual([
      { wake: { id, atMs: T0 + 30 * 60_000, why: "look at the harbour", scheduledIn: "room:harbour" } },
    ]);
    expect(recorder.openWakes().has(id)).toBe(true);
  });

  it("accepts at_iso and refuses bad arguments with plain reasons", async () => {
    const recorder = new ReplayRecorder(join(root, "transcript.jsonl"), T0);
    const [wake] = new ReplayWorld("cli", recorder, true).tools();
    const later = await wake!.run({ at_iso: "2026-07-02T09:00:00Z", why: "morning" }, context());
    expect(later.ok).toBe(true);
    expect(await wake!.run({ why: "no time" }, context())).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await wake!.run({ in_minutes: 1, at_iso: "2026-07-02T09:00:00Z", why: "both" }, context())).toMatchObject({ ok: false });
    expect(await wake!.run({ in_minutes: -5, why: "past" }, context())).toMatchObject({ ok: false });
    expect(await wake!.run({ at_iso: "not a date", why: "x" }, context())).toMatchObject({ ok: false });
    expect(await wake!.run({ in_minutes: 1 }, context())).toMatchObject({ ok: false });
  });

  it("cancels a recorded wake by id, and refuses an unknown id", async () => {
    const path = join(root, "transcript.jsonl");
    const recorder = new ReplayRecorder(path, T0);
    const [wake, cancel] = new ReplayWorld("cli", recorder, true).tools();
    const id = String((await wake!.run({ in_minutes: 5, why: "later" }, context())).data?.["id"]);
    expect(await cancel!.run({ id: "nope" }, context())).toMatchObject({ ok: false, refused: { code: "not_found" } });
    const receipt = await cancel!.run({ id }, context());
    expect(receipt).toMatchObject({ ok: true, summary: `Cancelled wake ${id}: later` });
    expect(recorder.openWakes().size).toBe(0);
    expect(transcriptRows(path).at(-1)).toEqual({ wake_cancelled: { id } });
  });
});

describe("replayModel", () => {
  function requestWith(names: string[]): ModelRequest {
    return {
      messages: [{ role: "user", content: "hi" }],
      tools: names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
    };
  }

  it("hides the replay's own wake tools from the model and renames the wake calls back to them", async () => {
    const inner = new ScriptedModel([
      reply({ toolCalls: [call("schedule_wake", { why: "x", in_minutes: 1 }), call("cancel_wake", { id: "a" }), call("say", {})] }),
    ]);
    const model = replayModel(inner, () => undefined);
    const response: ModelResponse = await model.complete(requestWith(["say", "schedule_wake", REPLAY_WAKE, REPLAY_CANCEL_WAKE]));
    expect(inner.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["say", "schedule_wake"]);
    expect(response.toolCalls.map((item) => item.name)).toEqual([REPLAY_WAKE, REPLAY_CANCEL_WAKE, "say"]);
    expect(response.toolCalls[0]?.arguments).toBe(JSON.stringify({ why: "x", in_minutes: 1 }));
  });

  it("counts failed calls, passes the error on, and keeps the model's info", async () => {
    const failures: string[] = [];
    const inner = new ScriptedModel([new ModelError("provider is down", "unavailable", 2)]);
    const model = replayModel(inner, (message) => failures.push(message));
    expect(model.info).toBe(inner.info);
    await expect(model.complete(requestWith([]))).rejects.toThrow(/provider is down/);
    expect(failures).toEqual(["provider is down"]);
  });
});
