import { describe, expect, it } from "vitest";
import type { RiverRow } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { isLive, purposeOf } from "../river/purpose.js";
import { END_TURN, runTurn } from "./run-turn.js";

const NOW = Date.UTC(2026, 9, 26, 12);

async function turnRows(purpose?: "live" | "eval" | "replay"): Promise<RiverRow[]> {
  const river = new MemoryRiver({ nowMs: () => NOW });
  await runTurn({
    model: new ScriptedModel([reply({ toolCalls: [call(END_TURN, {}, "e")] })]),
    tools: [],
    system: "s",
    history: [],
    event: "e",
    thread: "dm:owner",
    river,
    notebook: new MemoryNotebook({ nowMs: () => NOW }),
    ceiling: { maxModelCalls: 3, maxToolCalls: 3 },
    nowMs: () => NOW,
    turnId: "t1",
    ...(purpose === undefined ? {} : { purpose }),
  });
  return river.read({ thread: "dm:owner" }).filter((row) => row.kind === "turn");
}

describe("turn purpose", () => {
  it("stamps the purpose on the turn's start and end rows", async () => {
    const rows = await turnRows("eval");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.data?.["purpose"] === "eval")).toBe(true);
    expect(rows.every((row) => !isLive(row))).toBe(true);
  });

  it("reads a row with no purpose, an older row, as live", async () => {
    const rows = await turnRows();
    expect(rows.every((row) => purposeOf(row) === "live" && isLive(row))).toBe(true);
  });

  it("reads an unknown purpose value as live, so nothing is left out of a count", () => {
    expect(purposeOf({ data: { purpose: "weird" } })).toBe("live");
    expect(purposeOf({ data: { purpose: "replay" } })).toBe("replay");
  });
});
