import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "./config.js";
import type { ModelRequest, RiverRow, Tool, ToolContext } from "../contracts.js";
import { derivedStores, derivedTableNames } from "../river/derived.js";
import { OBSERVATIONS_TABLE, openObservations, type ObservationStore } from "../river/observations.js";
import { openRiver, type SqliteRiver } from "../river/sqlite-river.js";
import { createCliWorld } from "../worlds/cli.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { observationsTools } from "../tools/observations-tools.js";
import { openEntity, type Entity } from "./runtime.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

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
let river: SqliteRiver;
let observations: ObservationStore;
const opened: Entity[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-observations-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  river = openRiver(join(dir, "river.db"));
  observations = openObservations(join(dir, "river.db"));
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  observations.close();
  river.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function tools(): Tool[] {
  return observationsTools(observations, { visible: () => true });
}

function toolNamed(name: string): Tool {
  const tool = tools().find((candidate) => candidate.spec.name === name);
  if (tool === undefined) throw new Error(`no observation tool named ${name}`);
  return tool;
}

function context(thread = "self", nowMs = NOW): ToolContext {
  return { thread, turnId: "t-observations", nowMs, river, notebook: undefined as never };
}

function addRow(thread = "self", text = "The north gate opens at dawn."): RiverRow {
  return river.append({ thread, kind: "event", source: "outside", actor: "mara", text });
}

type RawObservation = {
  id: number;
  at_ms: number;
  thread: string;
  text: string | null;
  start_seq: number | null;
  end_seq: number | null;
  forgotten: number;
  forgotten_why: string | null;
};

function observationRows(atDir = dir): RawObservation[] {
  const db = new DatabaseSync(join(atDir, "river.db"), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${OBSERVATIONS_TABLE} ORDER BY id`).all() as unknown as RawObservation[];
  } finally {
    db.close();
  }
}

function userText(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

function schedulerOf(entity: Entity): { reflectTurn(thread: string): Promise<void>; takeTurn(thread: string): Promise<void> } {
  return entity as unknown as { reflectTurn(thread: string): Promise<void>; takeTurn(thread: string): Promise<void> };
}

function toolsFor(entity: Entity): (thread: string, purpose?: string) => Tool[] {
  return (entity as unknown as { toolsFor(thread: string, purpose?: string): Tool[] }).toolsFor.bind(entity);
}

describe("U11: observations in her own words", () => {
  it("a reflect turn may write observations in her words keyed by seq range", async () => {
    const runtimeDir = join(root, "reflect");
    const model = new ScriptedModel([
      reply({
        toolCalls: [
          call("record_observation", {
            text: "The two quiet days at the quay were the calmest I have had in a month.",
            start_seq: 1,
            end_seq: 2,
          }),
        ],
      }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const entity = await openEntity({
      dir: runtimeDir,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    opened.push(entity);
    entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A quiet morning at the quay." });
    entity.river.append({ thread: "self", kind: "event", source: "outside", text: "The market filled by noon." });

    await schedulerOf(entity).reflectTurn("self");

    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toContain("record_observation");
    const rows = observationRows(runtimeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      thread: "self",
      text: "The two quiet days at the quay were the calmest I have had in a month.",
      start_seq: 1,
      end_seq: 2,
      forgotten: 0,
    });
    const receipt = entity.river
      .read({ kinds: ["receipt"], limit: 100 })
      .find((row) => row.data?.["tool"] === "record_observation");
    expect(receipt?.data?.["ok"]).toBe(true);
    expect(receipt?.data?.["dataJson"]).toContain('"id"');
  });

  it("nothing is written by the body", async () => {
    const runtimeDir = join(root, "quiet");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const entity = await openEntity({
      dir: runtimeDir,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    opened.push(entity);
    entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A quiet morning at the quay." });

    await schedulerOf(entity).reflectTurn("self");

    expect(observationRows(runtimeDir)).toHaveLength(0);
    const db = new DatabaseSync(join(dir, "river.db"), { readOnly: true });
    try {
      const columns = (db.prepare(`PRAGMA table_info(${OBSERVATIONS_TABLE})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      // No field for body-composed text: an observation row holds only her words and the two row numbers.
      expect(columns).not.toContain("candidate");
      expect(columns).not.toContain("summary");
      expect(columns).not.toContain("author");
    } finally {
      db.close();
    }
  });

  it("only a reflect turn is offered the observation tool", async () => {
    const model = new ScriptedModel([]);
    const entity = await openEntity({
      dir: join(root, "offer"),
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    opened.push(entity);
    const names = toolsFor(entity);
    expect(names("self").map((tool) => tool.spec.name)).not.toContain("record_observation");
    expect(names("self", "reflect").map((tool) => tool.spec.name)).toContain("record_observation");
  });

  it("record_observation checks the span before it writes anything", async () => {
    expect(toolNamed("record_observation").spec.parameters["properties"]).toEqual({
      text: expect.anything(),
      start_seq: expect.anything(),
      end_seq: expect.anything(),
    });

    const first = addRow("self", "A dry line.");
    const missing = await toolNamed("record_observation").run(
      { text: "A span whose end is not there.", start_seq: first.seq, end_seq: 99 },
      context(),
    );
    expect(missing.ok).toBe(false);
    expect(missing.refused?.code).toBe("not_found");

    const backwards = await toolNamed("record_observation").run(
      { text: "A span that runs backwards.", start_seq: first.seq + 2, end_seq: first.seq },
      context(),
    );
    expect(backwards.ok).toBe(false);
    expect(backwards.refused?.code).toBe("bad_arguments");

    const before = addRow("self", "A line before the gap.");
    const inner = addRow("self", "A line in the gap.");
    const after = addRow("self", "A line after the gap.");
    river.forget({ seqs: [inner.seq] }, "self", "The inner line is gone");
    const gap = await toolNamed("record_observation").run(
      { text: "A span over a forgotten line in the middle.", start_seq: before.seq, end_seq: after.seq },
      context(),
    );
    expect(gap.ok).toBe(false);
    expect(gap.refused?.code).toBe("forgotten");

    const gone = addRow("self", "A forgotten line.");
    river.forget({ seqs: [gone.seq] }, "self", "The line is gone");
    const forgotten = await toolNamed("record_observation").run(
      { text: "A span over a forgotten line.", start_seq: gone.seq, end_seq: gone.seq },
      context(),
    );
    expect(forgotten.ok).toBe(false);
    expect(forgotten.refused?.code).toBe("forgotten");

    expect(observationRows()).toHaveLength(0);
  });
});

describe("U11: the observation log and forget", () => {
  it("forget of a seq in the range drops the observation whole", () => {
    expect(derivedStores().some((store) => store.tables.includes(OBSERVATIONS_TABLE))).toBe(true);
    expect(derivedTableNames()).toContain(OBSERVATIONS_TABLE);

    const first = addRow("self", "The first dry line.");
    const middle = addRow("self", "The middle dry line.");
    const last = addRow("self", "The last dry line.");
    const outside = addRow("self", "A line outside the span.");

    observations.record({
      thread: "self",
      text: "The days between the first and last lines were calm.",
      startSeq: first.seq,
      endSeq: last.seq,
      atMs: NOW,
    });
    expect(observations.current()).toHaveLength(1);

    // A row in the middle of the range is enough: the observation goes whole, with its text and its span blank.
    river.forget({ seqs: [middle.seq] }, "self", "The middle row is gone");

    let rows = observationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      text: null,
      start_seq: null,
      end_seq: null,
      forgotten: 1,
      forgotten_why: "source",
    });
    expect(observations.current()).toHaveLength(0);

    // A row outside the span leaves the observation as it was.
    observations.record({
      thread: "self",
      text: "The last line is still here.",
      startSeq: middle.seq + 1,
      endSeq: last.seq,
      atMs: NOW,
    });
    river.forget({ seqs: [outside.seq] }, "self", "A row outside the span is gone");

    rows = observationRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      text: "The last line is still here.",
      start_seq: middle.seq + 1,
      end_seq: last.seq,
      forgotten: 0,
    });
    expect(observations.current()).toHaveLength(1);
  });

  it("a text forget drops an observation whose own words match", () => {
    const first = addRow("self", "The first dry line.");
    const last = addRow("self", "The last dry line.");
    observations.record({
      thread: "self",
      text: "The harbour bell rang that evening.",
      startSeq: first.seq,
      endSeq: last.seq,
      atMs: NOW,
    });

    // No river row holds the word: the derived store itself is reached by a text forget (U8 cascade).
    river.forget({ text: "harbour" }, "self", "The words are gone");

    const rows = observationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      text: null,
      start_seq: null,
      end_seq: null,
      forgotten: 1,
      forgotten_why: "text",
    });
    expect(observations.current()).toHaveLength(0);
  });
});

describe("U11: observations only in her own thread", () => {
  it("observations only in self thread context", async () => {
    const runtimeDir = join(root, "context");
    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const entity = await openEntity({
      dir: runtimeDir,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    opened.push(entity);
    entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A quiet morning at the quay." });
    const runtimeObservations = openObservations(join(runtimeDir, "river.db"));
    try {
      runtimeObservations.record({
        thread: "self",
        text: "The harbour gate opened at dawn.",
        startSeq: 1,
        endSeq: 1,
        atMs: Date.now(),
      });
    } finally {
      runtimeObservations.close();
    }

    await schedulerOf(entity).takeTurn("self");
    expect(userText(model.requests[0])).toContain("The harbour gate opened at dawn.");

    entity.river.append({ thread: "discord:dm:owner", kind: "event", source: "owner", text: "A word in private." });
    await schedulerOf(entity).takeTurn("discord:dm:owner");
    expect(userText(model.requests[1])).not.toContain("The harbour gate opened at dawn.");

    entity.river.append({ thread: "discord:room:quay", kind: "event", source: "outside", text: "A word in the room." });
    await schedulerOf(entity).takeTurn("discord:room:quay");
    expect(userText(model.requests[2])).not.toContain("The harbour gate opened at dawn.");
  });
});
