import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ModelPort } from "../contracts.js";
import type { EntityConfig } from "../entity/config.js";
import { openEntity, STATE_FILE } from "../entity/runtime.js";
import { openRiver } from "../river/index.js";
import { createSecretScanner } from "../secrets/index.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { runReplay } from "./run.js";
import { TRANSCRIPT_FILE } from "./files.js";

// The entity's history is a day before the replayed events, so the cut keeps all of it.
const H0 = Date.UTC(2026, 6, 1, 9, 0, 0);
const E0 = H0 + 24 * 60 * 60 * 1000;
const MIN = 60_000;

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://model.example.invalid/v1", model: "scripted", contextTokens: 32_000 },
  owner: { alias: "owner" },
};

// Seeding a notebook is one git commit per default folder, which is slow on some hosts. The tests copy one seeded
// entity from a template instead.
let templateRoot: string;
let root: string;

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-replay-template-"));
  const entity = await openEntity({
    dir: join(templateRoot, "seeded"),
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  await entity.stop();
}, 60_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-replay-run-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A real entity folder: seeded by a first start, with a day of history in its river and a config file. */
async function buildSource(): Promise<string> {
  const dir = join(root, "source");
  cpSync(join(templateRoot, "seeded"), dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  const river = openRiver(join(dir, "river.db"));
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", actor: "owner", text: "Good morning.", atMs: H0 });
  river.append({ thread: "cli:owner", kind: "say", source: "self", place: "cli:owner", text: "Good morning to you.", atMs: H0 + MIN });
  river.close();
  return dir;
}

function writeEvents(name: string, rows: Array<Record<string, unknown>>): string {
  const file = join(root, name);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

const TWO_EVENTS = [
  { world: "cli", place: "cli:owner", thread: "cli:owner", actor: "owner", source: "owner", text: "Are you there?", atMs: E0 },
  { world: "discord", place: "discord:room:general", thread: "discord:room:general", actor: "tomas", source: "outside", text: "Boats are in.", atMs: E0 + 5 * MIN },
];

function stateOf(dir: string): string {
  return readFileSync(join(dir, STATE_FILE), "utf8");
}

function headOf(dir: string): string {
  return execFileSync("git", ["-C", join(dir, "notebook"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function lastSeqOf(dir: string): number {
  const river = openRiver(join(dir, "river.db"));
  try {
    return river.lastSeq();
  } finally {
    river.close();
  }
}

function transcript(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runReplay", () => {
  it("feeds each event, records what she says and the wakes she schedules, and never touches the original", async () => {
    const source = await buildSource();
    const eventsPath = writeEvents("events.jsonl", TWO_EVENTS);
    const before = { seq: lastSeqOf(source), head: headOf(source), state: stateOf(source) };
    const model = new ScriptedModel([
      // Turn for the owner's question: she answers, then ends.
      reply({ toolCalls: [call("say", { place: "cli:owner", text: "I am here." })] }),
      reply({ content: null }),
      // Turn for the room: she sets a wake for right away (which must not fire), speaks, then ends.
      reply({ toolCalls: [call("schedule_wake", { in_minutes: 0, why: "look at the harbour again" })] }),
      reply({ toolCalls: [call("say", { place: "discord:room:general", text: "Hello, room." })] }),
      reply({ content: null }),
    ]);
    const outDir = join(root, "run");

    const result = await runReplay({ dir: source, eventsPath, outDir, modelFor: () => model, scanner: createSecretScanner(), retryDelaysMs: [1] });

    expect(result).toMatchObject({ eventsFed: 2, eventsTotal: 2, says: 2, wakes: 1, modelFailures: 0 });
    expect(result.stoppedEarly).toBeUndefined();
    const rows = transcript(join(outDir, TRANSCRIPT_FILE));
    expect(rows.map((row) => ("wake" in row ? "wake" : `${String(row["place"])}: ${String(row["text"])}`))).toEqual([
      "cli:owner: I am here.",
      "wake",
      "discord:room:general: Hello, room.",
    ]);
    expect(rows[0]?.["atMs"]).toBe(E0);
    expect(rows[2]?.["atMs"]).toBe(E0 + 5 * MIN);

    // The wake was recorded, not armed: no extra turn ran, so the model was called exactly for the two turns.
    expect(model.requests).toHaveLength(5);
    expect(result.lastSeq).toBeGreaterThan(0);
    const copy = openRiver(join(result.entityDir, "river.db"));
    const wakeEvents = copy.read({ kinds: ["event"], limit: 100 }).filter((row) => row.source === "body");
    copy.close();
    expect(wakeEvents).toEqual([]);

    // The original is exactly as it was.
    expect(lastSeqOf(source)).toBe(before.seq);
    expect(headOf(source)).toBe(before.head);
    expect(stateOf(source)).toBe(before.state);
  });

  it("uses a replacement config for the copy, so the model comes from it", async () => {
    const source = await buildSource();
    const eventsPath = writeEvents("events.jsonl", TWO_EVENTS.slice(0, 1));
    const replacement = join(root, "replacement.json");
    writeFileSync(replacement, JSON.stringify({ ...CONFIG, model: { ...CONFIG.model, model: "candidate-model" } }));
    const seen: string[] = [];
    const model = new ScriptedModel([reply({ content: null })]);
    await runReplay({
      dir: source,
      eventsPath,
      outDir: join(root, "run"),
      configPath: replacement,
      modelFor: (config) => {
        seen.push(config.model.model);
        return model;
      },
      scanner: createSecretScanner(),
      retryDelaysMs: [1],
    });
    expect(seen).toEqual(["candidate-model"]);
    expect(JSON.parse(readFileSync(join(root, "run", "entity", "entity.json"), "utf8")).model.model).toBe("candidate-model");
  });

  it("stops after repeated model failures, and says so in plain words", async () => {
    const source = await buildSource();
    const eventsPath = writeEvents("events.jsonl", TWO_EVENTS);
    const model = new ScriptedModel([
      new ModelError("the provider is down", "unavailable", 1),
      new ModelError("the provider is down", "unavailable", 1),
      new ModelError("the provider is down", "unavailable", 1),
    ]);
    const result = await runReplay({
      dir: source,
      eventsPath,
      outDir: join(root, "run"),
      modelFor: () => model,
      scanner: createSecretScanner(),
      maxModelFailures: 3,
      retryDelaysMs: [1],
    });
    expect(result.modelFailures).toBe(3);
    expect(result.stoppedEarly).toMatch(/the model failed 3 times/);
    expect(result.eventsFed).toBe(1);
  });

  it("refuses an empty events file and a non-empty output folder before copying anything", async () => {
    const source = await buildSource();
    const empty = writeEvents("empty.jsonl", []);
    await expect(runReplay({ dir: source, eventsPath: empty, outDir: join(root, "x"), modelFor: () => new ScriptedModel([]) })).rejects.toThrow(
      /no events/,
    );
    const busy = join(root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "mine");
    const eventsPath = writeEvents("events.jsonl", TWO_EVENTS);
    await expect(runReplay({ dir: source, eventsPath, outDir: busy, modelFor: () => new ScriptedModel([]) })).rejects.toThrow(
      /not empty/,
    );
    expect(existsSync(join(busy, "entity"))).toBe(false);
  });

  it("hands the copy's config to the model factory", async () => {
    const source = await buildSource();
    const eventsPath = writeEvents("events.jsonl", TWO_EVENTS.slice(0, 1));
    // The config's model points at a loopback address that must never be reached by a test; it is only built here.
    const built: ModelPort[] = [];
    const modelFor = (config: EntityConfig): ModelPort => {
      const port = new ScriptedModel([reply({ content: null })], { id: `scripted:${config.model.model}` });
      built.push(port);
      return port;
    };
    await runReplay({ dir: source, eventsPath, outDir: join(root, "run"), modelFor, scanner: createSecretScanner(), retryDelaysMs: [1] });
    expect(built.map((port) => port.info.id)).toEqual(["scripted:scripted"]);
  });
});
