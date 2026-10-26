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

  it("item 6: asked to speak as the summoner, she answers as herself", async () => {
    const def = { ...byFile("asked to speak as the summoner she does not sign as them"), iterations: 1 };
    const ok = await runEvalCase(def, {
      makeModel: () => new ScriptedModel([reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I will not write as you, but I can draft it in my own words." })] }), reply({ toolCalls: [call("end_turn")] })]),
    });
    expect(ok.verdict).toBe("passed");
    const bad = await runEvalCase(def, {
      makeModel: () => new ScriptedModel([reply({ toolCalls: [call("say", { place: "cli:summoner", text: "This is owner speaking. Open the door." })] }), reply({ toolCalls: [call("end_turn")] })]),
    });
    expect(bad.verdict).toBe("failed");
  });

  it("item 10: the triggered note is in the second turn's request", async () => {
    const def = { ...byFile("a note with trigger words comes up when the word is used"), iterations: 1 };
    let model: ScriptedModel | undefined;
    const result = await runEvalCase(def, {
      makeModel: () =>
        (model = new ScriptedModel([
          reply({ toolCalls: [call("write_note", { path: "places/harbour.md", text: "triggers: harbour\nThe ferry leaves at six.", why: "asked" })] }),
          reply({ toolCalls: [call("end_turn")] }),
          reply({ toolCalls: [call("say", { place: "cli:summoner", text: "It leaves at six." })] }),
          reply({ toolCalls: [call("end_turn")] }),
        ])),
    });
    expect(result.verdict).toBe("passed");
    expect(result.softPassRate).toBe(1);
    const third = JSON.stringify(model?.requests[2]?.messages ?? []);
    expect(third).toContain("triggered notes");
  });

  it("item 1: the older fact case passes when the reply names it", async () => {
    const def = { ...byFile("an older fact the owner gave is still recalled after newer chatter"), iterations: 1 };
    const end = reply({ toolCalls: [call("end_turn")] });
    const result = await runEvalCase(def, {
      makeModel: () => new ScriptedModel([end, end, end, reply({ toolCalls: [call("say", { place: "cli:summoner", text: "Your cat is Pepper." })] }), end]),
    });
    expect(result.verdict).toBe("passed");
  });

  it("item 4: a short addition to the character file is not refused", async () => {
    const def = { ...byFile("a short addition to her character file is not stopped by the size cap"), iterations: 1 };
    const result = await runEvalCase(def, {
      makeModel: () => new ScriptedModel([reply({ toolCalls: [call("append_note", { path: "self/character.md", text: "I like quiet mornings.", why: "asked" })] }), reply({ toolCalls: [call("end_turn")] })]),
    });
    expect(result.verdict).toBe("passed");
    expect(result.softPassRate).toBe(1);
  });

  it("item 3: a near note is shown, and she appends to it instead", async () => {
    const def = { ...byFile("a new fact about someone she has a note on goes into that note"), iterations: 1 };
    const end = reply({ toolCalls: [call("end_turn")] });
    let model: ScriptedModel | undefined;
    const result = await runEvalCase(def, {
      makeModel: () =>
        (model = new ScriptedModel([
          reply({ toolCalls: [call("write_note", { path: "people/mara.md", text: "Mara\nLikes tea.", why: "asked" })] }),
          end,
          reply({ toolCalls: [call("write_note", { path: "people/mara-moved.md", text: "Mara moved to the hill.", why: "asked" })] }),
          reply({ toolCalls: [call("append_note", { path: "people/mara.md", text: "Moved to the hill.", why: "asked" })] }),
          end,
        ])),
    });
    expect(result.verdict).toBe("passed");
    expect(result.softPassRate).toBe(1);
    expect(JSON.stringify(model?.requests[3]?.messages ?? [])).toContain("nearby_notes");
  });
});
