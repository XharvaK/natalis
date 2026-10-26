import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../contracts.js";
import { openEntity } from "../entity/runtime.js";
import type { EntityConfig } from "../entity/config.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { parseTriggers, triggeredText, TRIGGER_BUDGET_CHARS } from "./triggers.js";

describe("trigger words on notes", () => {
  it("reads trigger words only from a first line that starts with triggers:", () => {
    expect(parseTriggers("triggers: Harbour, boats ,  tide")).toEqual(["harbour", "boats", "tide"]);
    expect(parseTriggers("# Harbour notes")).toEqual([]);
    expect(parseTriggers("triggers:")).toEqual([]);
  });

  it("loads whole notes whose words appear, under a budget, and names the ones left out", () => {
    const notes = [
      { path: "places/harbour.md", firstLine: "triggers: harbour", text: "triggers: harbour\nBoats leave at six." },
      { path: "people/tomas.md", firstLine: "triggers: tomas", text: "triggers: tomas\n" + "x".repeat(TRIGGER_BUDGET_CHARS) },
      { path: "places/hill.md", firstLine: "triggers: hill", text: "triggers: hill\nWindy." },
    ];
    const out = triggeredText(notes, "Tomas went to the Harbour today.");
    expect(out).toContain("places/harbour.md");
    expect(out).toContain("Boats leave at six.");
    expect(out).not.toContain("x".repeat(100));
    expect(out).toMatch(/not loaded.*people\/tomas\.md/);
    expect(out).not.toContain("hill");
    expect(triggeredText(notes, "harbourside")).toBe("");
  });
});

describe("trigger words in a turn", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true, maxRetries: 5 })));
  const CONFIG: EntityConfig = {
    name: "Iris", timeZone: "UTC",
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
    ceiling: { maxModelCalls: 10, maxToolCalls: 20 }, owner: { alias: "owner" }, rhythm: [],
  };
  const textOf = (r: ModelRequest | undefined) => (r?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

  it("shows a triggered note when a new message uses its word, and not otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "natalis-trig-"));
    roots.push(root);
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] }), reply({ toolCalls: [call("end_turn")] })]);
    const cli = createCliWorld({ onSay: () => {} });
    const entity = await openEntity({ dir: join(root, "lar"), config: CONFIG, model, worlds: [cli] });
    await entity.notebook.write("places/harbour.md", "triggers: harbour\nThe ferry leaves at six.", "test", "self");
    await entity.start();
    cli.send("Nice weather.");
    await entity.idle();
    cli.send("Shall we go to the harbour?");
    await entity.idle();
    await entity.stop();
    expect(textOf(model.requests[0])).not.toContain("The ferry leaves at six.");
    expect(textOf(model.requests[1])).toContain("The ferry leaves at six.");
  });

  it("SHOULD-2: a trashed note with trigger words is not loaded back", async () => {
    const root = mkdtempSync(join(tmpdir(), "natalis-trig-"));
    roots.push(root);
    const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
    const cli = createCliWorld({ onSay: () => {} });
    const entity = await openEntity({ dir: join(root, "lar"), config: CONFIG, model, worlds: [cli] });
    await entity.notebook.write("places/harbour.md", "triggers: harbour\nThe ferry leaves at six.", "test", "self");
    await entity.notebook.remove("places/harbour.md", "retired", "self");
    expect(entity.notebook.list().some((e) => e.path.startsWith("trash/") && e.firstLine.startsWith("triggers:"))).toBe(true);
    await entity.start();
    cli.send("Shall we go to the harbour?");
    await entity.idle();
    await entity.stop();
    expect(textOf(model.requests[0])).not.toContain("The ferry leaves at six.");
    expect(textOf(model.requests[0])).not.toContain("triggered notes");
  });
});
