import { describe, expect, it } from "vitest";
import type { Receipt, RiverRow, Tool } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { notebookTools } from "../tools/notebook-tools.js";
import { effectOf, READ_TOOLS } from "../tools/effects.js";
import { END_TURN, runTurn } from "./run-turn.js";

const NOW = Date.UTC(2026, 9, 26, 12);

function counting(name: string, effect: "read" | "write" | undefined, fail = 0): { tool: Tool; runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    tool: {
      spec: { name, description: name, parameters: { type: "object", properties: {} }, ...(effect === undefined ? {} : { effect }) },
      async run(): Promise<Receipt> {
        runs += 1;
        if (runs <= fail) throw new Error("socket hang up");
        return { ok: true, summary: `${name} ran.` };
      },
    },
  };
}

async function turn(tools: Tool[], names: string[], extra: { dryRun?: boolean } = {}) {
  const river = new MemoryRiver({ nowMs: () => NOW });
  const result = await runTurn({
    model: new ScriptedModel([reply({ toolCalls: names.map((n, i) => call(n, {}, `c${i}`)) }), reply({ toolCalls: [call(END_TURN, {}, "e")] })]),
    tools,
    system: "s",
    history: [],
    event: "e",
    thread: "dm:owner",
    river,
    notebook: new MemoryNotebook({ nowMs: () => NOW }),
    ceiling: { maxModelCalls: 5, maxToolCalls: 10 },
    nowMs: () => NOW,
    turnId: "t1",
    ...extra,
  });
  return { result, rows: river.read({ thread: "dm:owner" }) as RiverRow[] };
}

describe("tool effects", () => {
  it("defaults to write when nothing is declared, and knows the read tools by name", () => {
    expect(effectOf({ name: "mystery", description: "", parameters: {} })).toBe("write");
    expect(effectOf({ name: "recall", description: "", parameters: {} })).toBe("read");
    expect(effectOf({ name: "recall", description: "", parameters: {}, effect: "write" })).toBe("write");
    for (const name of ["recall", "read_note", "list_notes", "look", "read_history", "game_look", "game_snapshot"]) expect(READ_TOOLS.has(name)).toBe(true);
    for (const name of ["say", "game_act", "web_request", "write_note", "schedule_wake", "forget"]) expect(READ_TOOLS.has(name)).toBe(false);
  });

  it("labels every notebook tool, read or write, and only reads as read", () => {
    const effects = Object.fromEntries(notebookTools().map((t) => [t.spec.name, effectOf(t.spec)]));
    expect(effects).toMatchObject({ read_note: "read", list_notes: "read", recall: "read", write_note: "write", edit_note: "write", append_note: "write", trash_note: "write", forget: "write" });
  });
});

describe("dry run", () => {
  it("runs reads, stubs writes with a typed receipt marked stubbed, and still ends the turn", async () => {
    const read = counting("peek", "read");
    const write = counting("poke", undefined);
    const { result, rows } = await turn([read.tool, write.tool], ["peek", "poke"], { dryRun: true });
    expect(read.runs()).toBe(1);
    expect(write.runs()).toBe(0);
    expect(result.endedBy).toBe("end_turn");
    const poke = result.receipts.find((r) => r.tool === "poke")?.receipt;
    expect(poke?.ok).toBe(true);
    expect(poke?.data?.["stubbed"]).toBe(true);
    expect(rows.some((r) => r.kind === "receipt" && r.data?.["tool"] === "poke" && r.data?.["stubbed"] === true)).toBe(true);
  });

  it("runs writes normally when dry run is off", async () => {
    const write = counting("poke", "write");
    await turn([write.tool], ["poke"]);
    expect(write.runs()).toBe(1);
  });
});

describe("read retry", () => {
  it("retries a read that throws, up to 3 runs, and notes each retry in the river", async () => {
    const read = counting("peek", "read", 2);
    const { result, rows } = await turn([read.tool], ["peek"]);
    expect(read.runs()).toBe(3);
    expect(result.receipts.find((r) => r.tool === "peek")?.receipt.ok).toBe(true);
    expect(rows.filter((r) => r.kind === "note" && r.data?.["retryOf"] === "peek")).toHaveLength(2);
  });

  it("never retries a write", async () => {
    const write = counting("poke", "write", 1);
    const { result } = await turn([write.tool], ["poke"]);
    expect(write.runs()).toBe(1);
    expect(result.receipts.find((r) => r.tool === "poke")?.receipt.ok).toBe(false);
  });

  it("gives up after 3 runs of a read that keeps failing", async () => {
    const read = counting("peek", "read", 9);
    const { result } = await turn([read.tool], ["peek"]);
    expect(read.runs()).toBe(3);
    expect(result.receipts.find((r) => r.tool === "peek")?.receipt.refused?.code).toBe("tool_error");
  });
});
