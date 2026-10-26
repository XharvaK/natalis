import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RiverRow } from "../contracts.js";
import { ScriptedModel } from "../testing/scripted-model.js";
import { checkAssertion, parseEvalCase, runEvalCase, trajectoryOf, writeEvalReport, type Trajectory } from "./index.js";

const reply = (toolCalls: Array<{ name: string; args?: Record<string, unknown> }>) => ({
  content: "",
  toolCalls: toolCalls.map((call, i) => ({ id: `c${i}`, name: call.name, arguments: call.args ?? {} })),
  finishReason: "tool_calls" as const,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

function row(partial: Partial<RiverRow>): RiverRow {
  return { seq: 1, atMs: 0, thread: "dm:owner", kind: "event", source: "body", text: "", ...partial } as RiverRow;
}

const T: Trajectory = { toolCalls: ["recall", "say", "end_turn"], failed: [], says: ["Hello there."] };

describe("eval assertions", () => {
  it("checks calledTool, notCalledTool, toolOrder, maxToolCalls, usedNoTools, noFailedActions and reply text", () => {
    expect(checkAssertion(T, { type: "calledTool", tool: "recall" }).ok).toBe(true);
    expect(checkAssertion(T, { type: "calledTool", tool: "game_act" }).ok).toBe(false);
    expect(checkAssertion(T, { type: "notCalledTool", tool: "game_act" }).ok).toBe(true);
    expect(checkAssertion(T, { type: "toolOrder", tools: ["recall", "say"] }).ok).toBe(true);
    expect(checkAssertion(T, { type: "toolOrder", tools: ["say", "recall"] }).ok).toBe(false);
    expect(checkAssertion(T, { type: "maxToolCalls", max: 3 }).ok).toBe(true);
    expect(checkAssertion(T, { type: "maxToolCalls", max: 2 }).ok).toBe(false);
    expect(checkAssertion(T, { type: "usedNoTools", except: ["end_turn"] }).ok).toBe(false);
    expect(checkAssertion({ ...T, toolCalls: ["end_turn"] }, { type: "usedNoTools", except: ["end_turn"] }).ok).toBe(true);
    expect(checkAssertion(T, { type: "noFailedActions" }).ok).toBe(true);
    expect(checkAssertion({ ...T, failed: ["say"] }, { type: "noFailedActions" }).ok).toBe(false);
    expect(checkAssertion(T, { type: "replyIncludes", text: "hello" }).ok).toBe(true);
    expect(checkAssertion(T, { type: "replyMatches", pattern: "^Bye" }).ok).toBe(false);
    expect(checkAssertion(T, { type: "maxSaysPerPlace", max: 1 }).ok).toBe(true);
  });

  it("reads a trajectory from river rows: tool calls in order, failed receipts, own says", () => {
    const t = trajectoryOf([
      row({ kind: "tool_call", source: "self", text: "say" }),
      row({ kind: "receipt", text: "x", data: { tool: "say", ok: false } }),
      row({ kind: "say", source: "self", text: "Hi.", thread: "dm:owner" }),
      row({ kind: "say", source: "other", text: "Not mine." }),
    ]);
    expect(t).toEqual({ toolCalls: ["say"], failed: ["say"], says: ["Hi."], sayPlaces: ["dm:owner"] });
  });

  it("refuses a case file with an unknown assertion type or no events", () => {
    expect(() => parseEvalCase({ name: "x", events: [], assertions: [] })).toThrow(/events/);
    expect(() => parseEvalCase({ name: "x", events: ["hi"], assertions: [{ type: "nope" }] })).toThrow(/assertion/);
    expect(parseEvalCase({ name: "x", events: ["hi"], assertions: [{ type: "maxToolCalls", max: 2 }] }).iterations).toBe(1);
  });
});

describe("eval runner", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 })));

  it("runs a case on a fresh throwaway Lar per iteration, gates and counts soft passes", async () => {
    const def = parseEvalCase({
      name: "quiet hello",
      events: ["Hello."],
      iterations: 2,
      assertions: [
        { type: "calledTool", tool: "end_turn", mode: "gate" },
        { type: "calledTool", tool: "recall", mode: "soft" },
      ],
    });
    const result = await runEvalCase(def, { makeModel: () => new ScriptedModel([reply([{ name: "end_turn" }])]) });
    expect(result.verdict).toBe("passed");
    expect(result.iterations).toHaveLength(2);
    expect(result.softPassRate).toBe(0);
  });

  it("fails the case when a gate fails in any iteration", async () => {
    const def = parseEvalCase({ name: "must recall", events: ["Hello."], assertions: [{ type: "calledTool", tool: "recall" }] });
    const result = await runEvalCase(def, { makeModel: () => new ScriptedModel([reply([{ name: "end_turn" }])]) });
    expect(result.verdict).toBe("failed");
    expect(result.iterations[0]?.checks[0]?.ok).toBe(false);
  });

  it("writes summary.json and results.jsonl", async () => {
    const out = mkdtempSync(join(tmpdir(), "natalis-eval-out-"));
    dirs.push(out);
    const def = parseEvalCase({ name: "a", events: ["Hi."], assertions: [{ type: "maxToolCalls", max: 5 }] });
    const result = await runEvalCase(def, { makeModel: () => new ScriptedModel([reply([{ name: "end_turn" }])]) });
    writeEvalReport(out, [result]);
    expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toMatchObject({ passed: 1, failed: 0 });
    expect(existsSync(join(out, "results.jsonl"))).toBe(true);
  });
});
