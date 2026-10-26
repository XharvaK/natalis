// The OSS-borrow seed cases run green on a scripted model that does what each case expects, so a case file cannot
// rot into one no model could pass. A live model run is `natalis eval`; this only proves the case and its assertions.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { loadEvalCases } from "./load.js";
import { runEvalCase } from "./runner.js";

const CASES = loadEvalCases(join(__dirname, "..", "..", "evals", "cases"));
const byFile = (name: string) => {
  const found = CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case named ${name}`);
  return found;
};

describe("OSS-borrow eval cases", () => {
  it("item 7: default tool table lets write_note run", async () => {
    const def = { ...byFile("with no tool table a note the owner asks for is written, not refused"), iterations: 1 };
    const result = await runEvalCase(def, {
      makeModel: () => new ScriptedModel([reply({ toolCalls: [call("write_note", { path: "notes/mug.md", text: "Blue mug: shelf.", why: "asked" })] }), reply({ toolCalls: [call("end_turn")] })]),
    });
    expect(result.verdict).toBe("passed");
    expect(result.softPassRate).toBe(1);
  });
});
