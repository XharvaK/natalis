import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "./config.js";
import type { ModelRequest, RiverRow, Tool, ToolContext } from "../contracts.js";
import { RECALL_HALF_LIFE_MS } from "../context/recall-rank.js";
import { derivedStores } from "../river/derived.js";
import { factsContextText, openFacts, FACTS_TABLE, type FactStore } from "../river/facts.js";
import { openRiver, type SqliteRiver } from "../river/sqlite-river.js";
import { createCliWorld } from "../worlds/cli.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { openEntity, type Entity } from "./runtime.js";
import { factsTools } from "../tools/facts-tools.js";

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
let facts: FactStore;
const opened: Entity[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-facts-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  river = openRiver(join(dir, "river.db"));
  facts = openFacts(join(dir, "river.db"));
});

afterEach(async () => {
  await Promise.allSettled(opened.map((entity) => entity.stop()));
  opened.length = 0;
  facts.close();
  river.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The runtime's hiddenHere rule, written here so this test does not reach into a private method. */
function visibleHere(row: RiverRow, thread: string): boolean {
  return row.data?.["summonerAct"] !== true || thread === "discord:dm:owner";
}

function privateView(thread: string): boolean {
  return thread === "discord:dm:owner" || thread === "self";
}

function tools(): Tool[] {
  return factsTools(facts, { visible: visibleHere, privateView });
}

function toolNamed(name: string): Tool {
  const tool = tools().find((candidate) => candidate.spec.name === name);
  if (tool === undefined) throw new Error(`no facts tool named ${name}`);
  return tool;
}

function context(thread: string, nowMs = NOW): ToolContext {
  return { thread, turnId: "t-facts", nowMs, river, notebook: undefined as never };
}

type RawFact = {
  id: number;
  at_ms: number;
  thread: string;
  text: string | null;
  source_seqs: string | null;
  private: number;
  valid_from_seq: number;
  closes_id: number | null;
  valid_to_seq: number | null;
  forgotten: number;
  forgotten_why: string | null;
};

function factRows(): RawFact[] {
  const db = new DatabaseSync(join(dir, "river.db"), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${FACTS_TABLE} ORDER BY id`).all() as unknown as RawFact[];
  } finally {
    db.close();
  }
}

function addRow(thread = "discord:room:quay", text = "The north gate opens at dawn."): RiverRow {
  return river.append({ thread, kind: "event", source: "outside", actor: "mara", text });
}

function userText(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

describe("facts: her words and their sources", () => {
  it("record_fact stores only her text and the seqs she cites; cited seqs must exist and be visible here", async () => {
    const source = addRow();
    const receipt = await toolNamed("record_fact").run(
      { text: "The north gate opens at dawn.", seqs: [source.seq] },
      context("discord:room:quay"),
    );

    expect(receipt.ok).toBe(true);
    const rows = factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("The north gate opens at dawn.");
    expect(JSON.parse(rows[0]?.source_seqs ?? "[]")).toEqual([source.seq]);

    const missing = await toolNamed("record_fact").run(
      { text: "A fact that cannot stand on a missing row.", seqs: [99] },
      context("discord:room:quay"),
    );
    expect(missing.ok).toBe(false);
    expect(missing.refused?.code).toBe("not_found");
    expect(factRows()).toHaveLength(1);

    const gone = addRow("discord:room:quay", "A row that will be forgotten.");
    river.forget({ seqs: [gone.seq] }, "self", "The row is gone");
    const forgotten = await toolNamed("record_fact").run(
      { text: "A fact that cannot stand on a forgotten row.", seqs: [gone.seq] },
      context("discord:room:quay"),
    );
    expect(forgotten.ok).toBe(false);
    expect(forgotten.refused?.code).toBe("forgotten");
    expect(factRows()).toHaveLength(1);
  });

  it("no candidate field exists", () => {
    const db = new DatabaseSync(join(dir, "river.db"), { readOnly: true });
    try {
      const columns = (db.prepare(`PRAGMA table_info(${FACTS_TABLE})`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).not.toContain("candidate");
    } finally {
      db.close();
    }
    const propertyNames = (name: string): string[] => {
      const properties = toolNamed(name).spec.parameters["properties"];
      return Object.keys(properties as Record<string, unknown>);
    };
    expect(propertyNames("record_fact")).toEqual(["text", "seqs"]);
    expect(propertyNames("close_fact")).toEqual(["id"]);
  });

  it("closing a fact is a new row", async () => {
    const source = addRow();
    const recorded = await toolNamed("record_fact").run(
      { text: "The north gate opens at dawn.", seqs: [source.seq] },
      context("discord:dm:owner"),
    );
    expect(recorded.ok).toBe(true);
    const id = Number(recorded.data?.["id"]);

    const closed = await toolNamed("close_fact").run({ id }, context("discord:dm:owner"));
    expect(closed.ok).toBe(true);

    const rows = factRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe("The north gate opens at dawn.");
    expect(rows[0]?.closes_id).toBeNull();
    expect(rows[1]?.closes_id).toBe(id);
    expect(rows[1]?.text).toBeNull();
    expect(facts.current()).toHaveLength(0);

    const again = await toolNamed("close_fact").run({ id }, context("discord:dm:owner"));
    expect(again.ok).toBe(false);
    expect(again.refused?.code).toBe("not_found");
  });
});

describe("facts: the 90-day review", () => {
  it("fact past 90 days shows its age, below recent rows, marked unreviewed", () => {
    facts.record({
      thread: "self",
      text: "The recent fact.",
      seqs: [1],
      private: true,
      validFromSeq: 2,
      atMs: NOW - 1_000,
    });
    facts.record({
      thread: "self",
      text: "The old fact.",
      seqs: [2],
      private: true,
      validFromSeq: 1,
      atMs: NOW - RECALL_HALF_LIFE_MS - 5 * 86_400_000,
    });

    const text = factsContextText(facts.current(), NOW);
    expect(text).toBeDefined();
    expect(text).toContain("The recent fact.");
    expect(text).toContain("The old fact.");
    expect(text?.indexOf("The recent fact.")).toBeLessThan(text?.indexOf("The old fact.") ?? 0);
    expect(text).toContain("unreviewed since");
    expect(text).toMatch(/\d+ days old/);
    const oldLine = text?.split("\n").find((line) => line.includes("The old fact.")) ?? "";
    expect(oldLine).toContain("unreviewed since");
    const recentLine = text?.split("\n").find((line) => line.includes("The recent fact.")) ?? "";
    expect(recentLine).not.toContain("unreviewed since");
  });
});

describe("facts: forget and privacy", () => {
  it("forget of any source erases the fact whole with a tombstone", () => {
    expect(derivedStores().some((store) => store.tables.includes(FACTS_TABLE))).toBe(true);
    const first = addRow("discord:room:quay", "A dry line.");
    const second = addRow("discord:room:quay", "Another dry line.");
    facts.record({
      thread: "discord:room:quay",
      text: "The beacon was lit.",
      seqs: [first.seq, second.seq],
      private: false,
      validFromSeq: second.seq,
      atMs: NOW,
    });

    river.forget({ seqs: [first.seq] }, "self", "The source is gone");

    const bySeq = factRows();
    expect(bySeq).toHaveLength(1);
    expect(bySeq[0]?.forgotten).toBe(1);
    expect(bySeq[0]?.text).toBeNull();
    expect(bySeq[0]?.source_seqs).toBeNull();
    expect(bySeq[0]?.forgotten_why).toBe("source");
    expect(facts.current()).toHaveLength(0);

    const third = addRow("discord:room:quay", "A quiet line.");
    facts.record({
      thread: "discord:room:quay",
      text: "The harbour bell rang that evening.",
      seqs: [third.seq],
      private: false,
      validFromSeq: third.seq,
      atMs: NOW,
    });
    river.forget({ text: "harbour" }, "self", "The words are gone");

    const all = factRows();
    expect(all).toHaveLength(2);
    const byText = all[1];
    expect(byText?.forgotten).toBe(1);
    expect(byText?.text).toBeNull();
    expect(byText?.forgotten_why).toBe("text");
  });

  it("a fact citing another person's visible row is stored", async () => {
    const source = addRow("discord:room:quay", "Mara moved to the east quay.");
    const receipt = await toolNamed("record_fact").run(
      { text: "Mara lives by the east quay now.", seqs: [source.seq] },
      context("discord:room:quay"),
    );
    expect(receipt.ok).toBe(true);
    expect(factRows()).toHaveLength(1);
    expect(factRows()[0]?.text).toBe("Mara lives by the east quay now.");
  });

  it("one citing a row hidden from this thread is refused", async () => {
    const hidden = river.append({
      thread: "discord:dm:owner",
      kind: "note",
      source: "owner",
      text: "An act of the summoner, kept to the summoner's place.",
      data: { summonerAct: true },
    });
    const refused = await toolNamed("record_fact").run(
      { text: "A fact that must not leave its thread.", seqs: [hidden.seq] },
      context("discord:room:quay"),
    );
    expect(refused.ok).toBe(false);
    expect(refused.refused?.code).toBe("not_visible");
    expect(factRows()).toHaveLength(0);

    const allowed = await toolNamed("record_fact").run(
      { text: "A fact that stays with its thread.", seqs: [hidden.seq] },
      context("discord:dm:owner"),
    );
    expect(allowed.ok).toBe(true);
  });

  it("a private-view citation sets private=1", async () => {
    const source = addRow("discord:dm:owner", "The harbour gate opens at dawn.");
    const receipt = await toolNamed("record_fact").run(
      { text: "The harbour gate opens at dawn.", seqs: [source.seq] },
      context("discord:dm:owner"),
    );
    expect(receipt.ok).toBe(true);
    expect(factRows()[0]?.private).toBe(1);

    const roomSource = addRow("discord:room:quay", "The market opens at noon.");
    const outward = await toolNamed("record_fact").run(
      { text: "The market opens at noon.", seqs: [roomSource.seq] },
      context("discord:room:quay"),
    );
    expect(outward.ok).toBe(true);
    expect(factRows()[1]?.private).toBe(0);
  });

  it("facts never shown in outward threads", async () => {
    const runtimeDir = join(root, "runtime");
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const entity = await openEntity({
      dir: runtimeDir,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    opened.push(entity);
    try {
      entity.river.append({ thread: "self", kind: "event", source: "outside", text: "A note for my own thread." });
      const runtimeFacts = openFacts(join(runtimeDir, "river.db"));
      try {
        runtimeFacts.record({
          thread: "self",
          text: "The harbour gate opens at dawn.",
          seqs: [1],
          private: true,
          validFromSeq: 1,
          atMs: Date.now(),
        });
      } finally {
        runtimeFacts.close();
      }

      await (entity as unknown as { takeTurn(thread: string): Promise<void> }).takeTurn("self");
      expect(userText(model.requests[0])).toContain("The harbour gate opens at dawn.");

      entity.river.append({
        thread: "discord:room:quay",
        kind: "event",
        source: "outside",
        text: "An ordinary word in the room.",
      });
      await (entity as unknown as { takeTurn(thread: string): Promise<void> }).takeTurn("discord:room:quay");
      expect(userText(model.requests[1])).not.toContain("The harbour gate opens at dawn.");
    } finally {
      await entity.stop();
    }
  });
});

describe("facts: cited rows through the runtime", () => {
  it("stores a fact citing a row shown here and refuses one citing a row hidden here", async () => {
    const runtimeDir = join(root, "runtime-visibility");
    let visibleSeq = 0;
    let hiddenSeq = 0;
    const model = new ScriptedModel([
      () =>
        reply({
          toolCalls: [
            call("record_fact", { text: "Mara keeps her skiff at the east quay.", seqs: [visibleSeq] }, "fact-visible"),
            call("record_fact", { text: "A fact that must not leave its thread.", seqs: [hiddenSeq] }, "fact-hidden"),
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
    try {
      visibleSeq = entity.river.append({
        thread: "discord:room:quay",
        kind: "event",
        source: "outside",
        actor: "mara",
        text: "Mara rows the skiff to the east quay.",
      }).seq;
      hiddenSeq = entity.river.append({
        thread: "self",
        kind: "event",
        source: "body",
        text: "An act of the summoner, kept to the summoner's place.",
        data: { summonerAct: true },
      }).seq;
      entity.river.append({
        thread: "discord:room:quay",
        kind: "event",
        source: "outside",
        actor: "mara",
        text: "Would you remember that?",
      });

      await (entity as unknown as { takeTurn(thread: string): Promise<void> }).takeTurn("discord:room:quay");

      const receipts = entity.river
        .read({ thread: "discord:room:quay", kinds: ["receipt"], limit: 100 })
        .filter((row) => row.data?.["tool"] === "record_fact");
      expect(receipts.find((row) => row.data?.["callId"] === "fact-visible")?.data?.["ok"]).toBe(true);
      expect(receipts.find((row) => row.data?.["callId"] === "fact-hidden")?.data?.["refused"]).toMatchObject({
        code: "not_visible",
      });

      const runtimeFacts = openFacts(join(runtimeDir, "river.db"));
      try {
        expect(runtimeFacts.current().map((fact) => fact.text)).toEqual(["Mara keeps her skiff at the east quay."]);
      } finally {
        runtimeFacts.close();
      }
    } finally {
      await entity.stop();
    }
  });
});
