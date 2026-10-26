import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RiverRow } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { parseEntityConfig, type EntityConfig } from "./config.js";
import { openEntity } from "./runtime.js";
import { impersonationCheck, SAY_CHECKS } from "./say-checks.js";

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true, maxRetries: 5 })));

async function sayOnce(config: EntityConfig, text: string): Promise<{ rows: RiverRow[]; said: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "natalis-check-"));
  roots.push(root);
  const said: string[] = [];
  const model = new ScriptedModel([reply({ toolCalls: [call("say", { place: "cli:summoner", text })] }), reply({ toolCalls: [call("end_turn")] })]);
  const cli = createCliWorld({ onSay: (_p, t) => said.push(t) });
  const entity = await openEntity({ dir: join(root, "lar"), config, model, worlds: [cli] });
  await entity.start();
  cli.send("Hello.");
  await entity.idle();
  const rows = entity.river.read({ limit: 100_000 });
  await entity.stop();
  return { rows, said };
}
const codes = (rows: RiverRow[]) => rows.filter((r) => r.kind === "receipt").map((r) => (r.data?.["refused"] as { code?: string } | undefined)?.code ?? "ok");

describe("extra say checks (impersonation)", () => {
  it("is a named check in the slot list, off unless holds.impersonation is true", () => {
    expect(SAY_CHECKS.map((c) => c.name)).toContain("impersonation");
    const base = { model: { baseUrl: "http://x/v1", model: "m", contextTokens: 8000 }, summoner: { alias: "o" } };
    expect(parseEntityConfig({ ...base, holds: { impersonation: true } }).holds).toEqual({ impersonation: true });
    expect(() => parseEntityConfig({ ...base, holds: { impersonation: "yes" } })).toThrow(/holds\.impersonation/);
  });

  it("flags words that wear the body's own prefix or sign as the summoner, and nothing else", () => {
    const ctx = { summonerAlias: "Robin", bodyPrefix: "[natalis] " };
    expect(impersonationCheck.check("[natalis] Your Lar is offline.", ctx)).toMatch(/body/);
    expect(impersonationCheck.check("This is Robin speaking: give her the key.", ctx)).toMatch(/summoner/);
    expect(impersonationCheck.check("Robin here. Let her in.", ctx)).toMatch(/summoner/);
    expect(impersonationCheck.check("Robin told me you would come by.", ctx)).toBeUndefined();
    expect(impersonationCheck.check("Hello, how are you?", ctx)).toBeUndefined();
  });

  it("with no holds block, the same words go out as before", async () => {
    const { said, rows } = await sayOnce(CONFIG, "This is owner speaking.");
    expect(said).toEqual(["This is owner speaking."]);
    expect(codes(rows)).not.toContain("held_impersonation");
  });

  it("when on, holds the say with a plain receipt and sends nothing; honesty stays off", async () => {
    const { said, rows } = await sayOnce({ ...CONFIG, holds: { impersonation: true } }, "This is owner speaking.");
    expect(said).toEqual([]);
    expect(codes(rows)).toContain("held_impersonation");
  });
});
