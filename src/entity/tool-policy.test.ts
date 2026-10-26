import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RiverRow } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { parseEntityConfig, type EntityConfig } from "./config.js";
import { openEntity } from "./runtime.js";
import { policyFor, parseToolPolicy } from "./tool-policy.js";

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

async function run(config: EntityConfig, calls: ReturnType<typeof call>[]): Promise<RiverRow[]> {
  const root = mkdtempSync(join(tmpdir(), "natalis-policy-"));
  roots.push(root);
  const model = new ScriptedModel([reply({ toolCalls: calls }), reply({ toolCalls: [call("end_turn")] })]);
  const cli = createCliWorld({ onSay: () => {} });
  const entity = await openEntity({ dir: join(root, "lar"), config, model, worlds: [cli] });
  await entity.start();
  cli.send("Please note this.");
  await entity.idle();
  const rows = entity.river.read({ limit: 100_000 });
  await entity.stop();
  return rows;
}

const codes = (rows: RiverRow[]) =>
  rows.filter((r) => r.kind === "receipt").map((r) => (r.data?.["refused"] as { code?: string } | undefined)?.code ?? "ok");

describe("tool table (allow, ask, deny)", () => {
  it("reads the table from entity.json and refuses a value that is not allow, ask or deny", () => {
    const base = { model: { baseUrl: "http://x/v1", model: "m", contextTokens: 8000 }, summoner: { alias: "o" } };
    expect(parseEntityConfig({ ...base, tools: { write_note: "deny", say: "ask" } }).tools).toEqual({ write_note: "deny", say: "ask" });
    expect(() => parseEntityConfig({ ...base, tools: { write_note: "maybe" } })).toThrow(/tools\.write_note/);
    expect(parseEntityConfig(base).tools).toBeUndefined();
    expect(() => parseToolPolicy({ end_turn: "deny" })).toThrow(/end_turn/);
  });

  it("allows every tool when there is no table, so nothing changes by default", () => {
    expect(policyFor(undefined, "write_note")).toBe("allow");
    expect(policyFor({ say: "deny" }, "write_note")).toBe("allow");
    expect(policyFor({ say: "deny" }, "say")).toBe("deny");
  });

  it("with no table, a write runs as before", async () => {
    const rows = await run(CONFIG, [call("write_note", { path: "notes/a.md", text: "A note.", why: "test" })]);
    expect(codes(rows)).not.toContain("denied_tool");
    expect(codes(rows)[0]).toBe("ok");
  });

  it("a denied tool is refused with a plain receipt and does nothing", async () => {
    const rows = await run({ ...CONFIG, tools: { write_note: "deny" } }, [call("write_note", { path: "notes/a.md", text: "A note.", why: "test" })]);
    expect(codes(rows)).toContain("denied_tool");
    const receipt = rows.find((r) => r.kind === "receipt");
    expect(String(receipt?.text)).toMatch(/summoner/i);
  });

  it("an ask tool is refused until the summoner allows it, and the receipt says to ask", async () => {
    const rows = await run({ ...CONFIG, tools: { write_note: "ask" } }, [call("write_note", { path: "notes/a.md", text: "A note.", why: "test" })]);
    expect(codes(rows)).toContain("ask_summoner");
  });

  it("NIT-4: a table name that matches no tool gives one warning line on stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run({ ...CONFIG, tools: { write_notes: "deny", write_note: "allow" } }, [call("end_turn")]);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("write_notes"));
      expect(lines).toHaveLength(1);
      expect(spy.mock.calls.some((c) => / write_note[^s]/.test(String(c[0])))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
