import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { parseEntityConfig, type EntityConfig, DEFAULT_LIFE_WARN_CHARS } from "./config.js";
import { openEntity } from "./runtime.js";

const CONFIG: EntityConfig = {
  name: "Iris", timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 200_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 }, owner: { alias: "owner" }, rhythm: [],
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true, maxRetries: 5 })));

async function startWithLife(config: EntityConfig, life: string) {
  const root = mkdtempSync(join(tmpdir(), "natalis-life-"));
  roots.push(root);
  const model = new ScriptedModel([reply({ toolCalls: [call("end_turn")] })]);
  const cli = createCliWorld({ onSay: () => {} });
  const entity = await openEntity({ dir: join(root, "lar"), config, model, worlds: [cli] });
  await entity.notebook.write("self/life.md", life, "test", "self");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await entity.start();
    cli.send("Hello.");
    await entity.idle();
  } finally {
    await entity.stop();
  }
  const lines = log.mock.calls.map((c) => String(c[0]));
  log.mockRestore();
  const notes = entity.river.read({ limit: 100_000 }).filter((r) => r.kind === "note" && r.data?.["bodyNote"] === "life_size");
  return { lines, notes, entity, model };
}

describe("NIT-5: size warning for self/life.md (never trimmed)", () => {
  it("defaults to 40000 characters, read from limits.lifeWarnChars and validated", () => {
    expect(DEFAULT_LIFE_WARN_CHARS).toBe(40_000);
    const base = { model: { baseUrl: "http://x/v1", model: "m", contextTokens: 8000 }, summoner: { alias: "o" } };
    expect(parseEntityConfig({ ...base, limits: { lifeWarnChars: 500 } }).limits).toEqual({ lifeWarnChars: 500 });
    expect(() => parseEntityConfig({ ...base, limits: { lifeWarnChars: 0 } })).toThrow(/lifeWarnChars/);
    expect(() => parseEntityConfig({ ...base, limits: { lifeWarnChars: "big" } })).toThrow(/lifeWarnChars/);
  });

  it("over the threshold: one river note and one startup log line; the note is shown whole, never cut", async () => {
    const life = "\u00e9".repeat(150) + " END-OF-LIFE";
    const { lines, notes, model } = await startWithLife({ ...CONFIG, limits: { lifeWarnChars: 100 } }, life);
    expect(notes).toHaveLength(1);
    expect(String(notes[0]?.text)).toMatch(/162 characters/);
    expect(lines.filter((l) => l.includes("life.md"))).toHaveLength(1);
    expect(JSON.stringify(model.requests[0]?.messages)).toContain(life);
  });

  it("under the threshold: no note and no line", async () => {
    const { lines, notes } = await startWithLife(CONFIG, "A short life.");
    expect(notes).toHaveLength(0);
    expect(lines.filter((l) => l.includes("life.md"))).toHaveLength(0);
  });
});
