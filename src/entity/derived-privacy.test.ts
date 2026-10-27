import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "./config.js";
import type { ModelRequest } from "../contracts.js";
import { derivedTableNames, derivedTablesToEmpty } from "../river/derived.js";
import { FACTS_TABLE, openFacts } from "../river/facts.js";
import { LINKS_TABLE, openLinks } from "../river/links.js";
import { OBSERVATIONS_TABLE, openObservations } from "../river/observations.js";
import { openRiver, type SqliteRiver } from "../river/sqlite-river.js";
import { CLI_PLACE, createCliWorld } from "../worlds/cli.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { openEntity, type Entity } from "./runtime.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const ROOM = "discord:room:quay";

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};

let root: string;
const opened: Entity[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-derived-privacy-"));
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function open(dirName: string, model: ScriptedModel): Promise<Entity> {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const entity = await openEntity({
    dir,
    config: CONFIG,
    model,
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  opened.push(entity);
  return entity;
}

function takeTurn(entity: Entity, thread: string): Promise<void> {
  return (entity as unknown as { takeTurn(thread: string): Promise<void> }).takeTurn(thread);
}

function reflectTurn(entity: Entity, thread: string): Promise<void> {
  return (entity as unknown as { reflectTurn(thread: string): Promise<void> }).reflectTurn(thread);
}

function requestText(request: ModelRequest | undefined): string {
  const parts: string[] = [];
  for (const message of request?.messages ?? []) {
    if (typeof message.content === "string") parts.push(message.content);
  }
  return parts.join("\n");
}

function userText(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

type RawRow = Record<string, unknown>;

function rowsIn(dir: string, table: string): RawRow[] {
  const db = new DatabaseSync(join(dir, "river.db"), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as unknown as RawRow[];
  } finally {
    db.close();
  }
}

describe("U12: privacy flags on derived rows", () => {
  it("derived rows written in a turn that saw private/ carry private=1", async () => {
    let selfSeq = 0;
    let summonerSeq = 0;
    let roomSeq = 0;
    const model = new ScriptedModel([
      () =>
        reply({
          toolCalls: [
            call("record_fact", { text: "The harbour gate opens at dawn.", seqs: [selfSeq] }),
            call("link_notes", {
              from: "people/mara.md",
              to: "places/quay.md",
              relation: "supports",
              why: "Mara keeps the quay in her own words.",
            }),
          ],
        }),
      reply({ toolCalls: [call("end_turn")] }),
      () =>
        reply({
          toolCalls: [
            call("record_observation", {
              text: "The quiet dawn at the harbour gate stayed with me.",
              start_seq: selfSeq,
              end_seq: selfSeq,
            }),
          ],
        }),
      reply({ toolCalls: [call("end_turn")] }),
      () =>
        reply({
          toolCalls: [
            call("record_fact", { text: "The summoner keeps the east key.", seqs: [summonerSeq] }),
            call("link_notes", {
              from: "people/mara.md",
              to: "places/quay.md",
              relation: "elaborates",
              why: "The summoner's quay note holds the east key.",
            }),
          ],
        }),
      reply({ toolCalls: [call("end_turn")] }),
      () =>
        reply({
          toolCalls: [
            call("record_fact", { text: "The market opens at noon.", seqs: [roomSeq] }),
            call("link_notes", {
              from: "people/mara.md",
              to: "places/quay.md",
              relation: "contradicts",
              why: "The room heard the quay is quiet at noon.",
            }),
          ],
        }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const entity = await open("flags", model);
    await entity.notebook.write("people/mara.md", "Mara keeps the quay.\n", "fixture", "test");
    await entity.notebook.write("places/quay.md", "The quay is quiet at dawn.\n", "fixture", "test");

    selfSeq = entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A quiet dawn." }).seq;
    summonerSeq = entity.river.append({
      thread: CLI_PLACE,
      kind: "event",
      source: "owner",
      text: "The east key is mine.",
    }).seq;
    roomSeq = entity.river.append({ thread: ROOM, kind: "event", source: "outside", text: "The market is busy." }).seq;

    await takeTurn(entity, "self");
    await reflectTurn(entity, "self");
    await takeTurn(entity, CLI_PLACE);
    await takeTurn(entity, ROOM);

    const dir = join(root, "flags");
    const facts = rowsIn(dir, FACTS_TABLE);
    const links = rowsIn(dir, LINKS_TABLE);
    const observations = rowsIn(dir, OBSERVATIONS_TABLE);

    expect(facts.map((row) => [row["thread"], row["private"]])).toEqual([
      ["self", 1],
      [CLI_PLACE, 1],
      [ROOM, 0],
    ]);
    expect(links.map((row) => [row["thread"], row["private"]])).toEqual([
      ["self", 1],
      [CLI_PLACE, 1],
      [ROOM, 0],
    ]);
    expect(observations.map((row) => [row["thread"], row["private"]])).toEqual([["self", 1]]);
  });

  it("outward threads never see private derived rows", async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
      reply({ toolCalls: [call("end_turn")] }),
    ]);
    const entity = await open("outward", model);
    const dir = join(root, "outward");

    const facts = openFacts(join(dir, "river.db"));
    const links = openLinks(join(dir, "river.db"));
    const observations = openObservations(join(dir, "river.db"));
    try {
      facts.record({
        thread: "self",
        text: "The harbour gate opens at dawn.",
        seqs: [1],
        private: true,
        validFromSeq: 1,
        atMs: NOW,
      });
      links.record({
        thread: "self",
        from: "people/mara.md",
        to: "places/quay.md",
        relation: "supports",
        reason: "The lantern stays lit for Mara.",
        seq: 1,
        atMs: NOW,
        author: "self",
        private: true,
      });
      observations.record({
        thread: "self",
        text: "The lantern was still lit when the quay went quiet.",
        startSeq: 1,
        endSeq: 1,
        atMs: NOW,
        private: true,
      });
    } finally {
      facts.close();
      links.close();
      observations.close();
    }

    expect(rowsIn(dir, FACTS_TABLE)[0]?.["private"]).toBe(1);
    expect(rowsIn(dir, LINKS_TABLE)[0]?.["private"]).toBe(1);
    expect(rowsIn(dir, OBSERVATIONS_TABLE)[0]?.["private"]).toBe(1);

    entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A quiet dawn." });
    await takeTurn(entity, "self");
    expect(userText(model.requests[0])).toContain("The harbour gate opens at dawn.");
    expect(userText(model.requests[0])).toContain("The lantern was still lit when the quay went quiet.");

    entity.river.append({ thread: CLI_PLACE, kind: "event", source: "owner", text: "A word at the terminal." });
    await takeTurn(entity, CLI_PLACE);
    expect(userText(model.requests[1])).toContain("The harbour gate opens at dawn.");
    expect(userText(model.requests[1])).not.toContain("The lantern was still lit");

    entity.river.append({ thread: ROOM, kind: "event", source: "outside", text: "A word in the room." });
    await takeTurn(entity, ROOM);
    const outward = requestText(model.requests[2]);
    expect(outward).not.toContain("The harbour gate opens at dawn.");
    expect(outward).not.toContain("The lantern was still lit");
    expect(outward).not.toContain("The lantern stays lit for Mara.");
  });

  it("forget table covers private rows", () => {
    for (const table of [FACTS_TABLE, LINKS_TABLE, OBSERVATIONS_TABLE]) {
      expect(derivedTableNames()).toContain(table);
      expect(derivedTablesToEmpty()).toContain(table);
    }

    const dir = join(root, "forget");
    mkdirSync(dir, { recursive: true });
    const river = openRiver(join(dir, "river.db"));
    const facts = openFacts(join(dir, "river.db"));
    const links = openLinks(join(dir, "river.db"));
    const observations = openObservations(join(dir, "river.db"));
    try {
      const first = river.append({ thread: "self", kind: "event", source: "outside", text: "The first quiet line." });
      const second = river.append({ thread: "self", kind: "event", source: "outside", text: "The second quiet line." });
      const third = river.append({ thread: "self", kind: "event", source: "outside", text: "The third quiet line." });

      facts.record({
        thread: "self",
        text: "The harbour gate opens at dawn.",
        seqs: [first.seq],
        private: true,
        validFromSeq: first.seq,
        atMs: NOW,
      });
      links.record({
        thread: "self",
        from: "people/mara.md",
        to: "places/quay.md",
        relation: "supports",
        reason: "The lantern stays lit for Mara.",
        seq: second.seq,
        atMs: NOW,
        author: "self",
        private: true,
      });
      observations.record({
        thread: "self",
        text: "The lantern was still lit when the quay went quiet.",
        startSeq: first.seq,
        endSeq: third.seq,
        atMs: NOW,
        private: true,
      });

      expect(rowsIn(dir, FACTS_TABLE)[0]?.["private"]).toBe(1);
      expect(rowsIn(dir, LINKS_TABLE)[0]?.["private"]).toBe(1);
      expect(rowsIn(dir, OBSERVATIONS_TABLE)[0]?.["private"]).toBe(1);

      river.forget({ seqs: [first.seq, second.seq] }, "owner", "The owner asked to forget these rows.");

      const fact = rowsIn(dir, FACTS_TABLE)[0];
      const link = rowsIn(dir, LINKS_TABLE)[0];
      const observation = rowsIn(dir, OBSERVATIONS_TABLE)[0];
      expect(fact).toMatchObject({ text: null, source_seqs: null, forgotten: 1, forgotten_why: "source" });
      expect(link).toMatchObject({
        from_note: null,
        to_note: null,
        relation: null,
        reason: null,
        forgotten: 1,
        forgotten_why: "source",
      });
      expect(observation).toMatchObject({
        text: null,
        start_seq: null,
        end_seq: null,
        forgotten: 1,
        forgotten_why: "source",
      });
    } finally {
      observations.close();
      links.close();
      facts.close();
      river.close();
    }
  });
});
