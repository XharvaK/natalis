import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RiverRow, ToolCall } from "../contracts.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { CLI_PLACE, createCliWorld } from "../worlds/cli.js";
import { parseEntityConfig, type EntityConfig } from "./config.js";
import { ANYWHERE, openGrants } from "./grants.js";
import { openEntity, type Entity } from "./runtime.js";
import { permissionRequestText, policyFor, parseToolPolicy, scopeFor, summaryFor } from "./tool-policy.js";

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

type AskTurn = {
  entity: Entity;
  said: Array<{ place: string; text: string }>;
  dir: string;
  turn(text: string): Promise<void>;
};

/** Opens one Lar and gives each owner message the model calls it needs: one tool reply, then end_turn. */
async function withAsk(
  config: EntityConfig,
  callsPerTurn: ToolCall[][],
  body: (run: AskTurn) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "natalis-policy-"));
  roots.push(root);
  const dir = join(root, "lar");
  const said: Array<{ place: string; text: string }> = [];
  const steps = callsPerTurn.flatMap((calls) => [reply({ toolCalls: calls }), reply({ toolCalls: [call("end_turn")] })]);
  const cli = createCliWorld({ onSay: (place, text) => said.push({ place, text }) });
  const entity = await openEntity({ dir, config, model: new ScriptedModel(steps), worlds: [cli] });
  try {
    await entity.start();
    await body({
      entity,
      said,
      dir,
      turn: async (text) => {
        cli.send(text);
        await entity.idle();
      },
    });
  } finally {
    await entity.stop();
  }
}

const NOTE_ARGS = { path: "notes/a.md", text: "A note.", why: "test" };

describe("permission requests (B4 Q1)", () => {
  it("a request states what once, always, never and no cover", () => {
    const text = permissionRequestText({
      name: "Iris",
      tool: "web_request",
      scope: "forum.example.org",
      summary: summaryFor("web_request", { url: "https://forum.example.org/threads/42", method: "POST" }),
    });
    expect(text).toBe(
      "[natalis] Iris asks to use web_request on forum.example.org: POST forum.example.org/threads/42. " +
        "Answer in your own words. Once: this one call. " +
        "Always: web_request on forum.example.org until you take it back. " +
        "Never: no web_request on forum.example.org until you take it back. No: not this time.",
    );
  });

  it("a tool with no extractor says anywhere", () => {
    const scope = scopeFor("write_note", { path: "notes/a.md" });
    expect(scope).toBe(ANYWHERE);
    const text = permissionRequestText({
      name: "Iris",
      tool: "write_note",
      scope,
      summary: summaryFor("write_note", { path: "notes/a.md" }),
    });
    expect(text).toContain("Always: write_note anywhere until you take it back.");
    expect(text).toContain("Never: no write_note anywhere until you take it back.");
  });

  it("the summary holds no model text, only code-made facts from the arguments", () => {
    const summary = summaryFor("web_request", {
      url: "https://forum.example.org/t/1",
      method: "POST",
      body: "MODEL-ONLY-BODY",
      why: "MODEL-ONLY-WHY",
    });
    expect(summary).toContain("POST");
    expect(summary).toContain("forum.example.org");
    expect(summary).not.toContain("MODEL-ONLY-BODY");
    expect(summary).not.toContain("MODEL-ONLY-WHY");

    const generic = summaryFor("write_note", { path: "notes/a.md", text: "MODEL-ONLY-BODY", why: "MODEL-ONLY-WHY" });
    expect(generic).not.toContain("MODEL-ONLY");
  });

  it("the body posts an ask in the summoner's place and records the request", async () => {
    await withAsk({ ...CONFIG, tools: { write_note: "ask" } }, [[call("write_note", NOTE_ARGS)]], async ({ entity, said, dir, turn }) => {
      await turn("Please note this.");
      expect(said).toHaveLength(1);
      const posted = said[0]!;
      expect(posted.place).toBe(CLI_PLACE);
      expect(posted.text.startsWith("[natalis] Iris asks to use write_note: ")).toBe(true);

      const row = entity.river.read({ limit: 100_000 }).find((item) => item.kind === "say" && String(item.text).startsWith("[natalis] "));
      expect(row).toBeDefined();
      expect(row?.thread).toBe(CLI_PLACE);
      expect(row?.place).toBe(CLI_PLACE);

      const grants = openGrants(dir);
      try {
        const [request] = grants.openRequests();
        expect(request).toBeDefined();
        expect(request?.tool).toBe("write_note");
        expect(request?.scopeKey).toBe(ANYWHERE);
        expect(request?.postedSeq).toBe(row?.seq);
        expect(request?.place).toBe(CLI_PLACE);
        expect(request?.askingThread).toBe(CLI_PLACE);
        expect(request?.argsHmac).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        grants.close();
      }
    });
  });

  it("at call start a standing grant lets the tool run, and a refusal wins over it", async () => {
    await withAsk(
      { ...CONFIG, tools: { write_note: "ask" } },
      [[call("write_note", NOTE_ARGS)], [call("write_note", NOTE_ARGS)], [call("write_note", { ...NOTE_ARGS, text: "B note." })]],
      async ({ entity, dir, turn }) => {
        await turn("First.");
        expect(existsSync(join(dir, "notebook", "notes", "a.md"))).toBe(false);

        const allowed = openGrants(dir);
        try {
          allowed.addGrant({ tool: "write_note", scope: ANYWHERE, kind: "always", createdBy: "owner", nowMs: Date.now() });
        } finally {
          allowed.close();
        }
        await turn("Second.");
        expect(readFileSync(join(dir, "notebook", "notes", "a.md"), "utf8")).toBe("A note.");

        const refused = openGrants(dir);
        try {
          refused.addGrant({ tool: "write_note", scope: ANYWHERE, kind: "never", createdBy: "owner", nowMs: Date.now() });
        } finally {
          refused.close();
        }
        await turn("Third.");
        expect(readFileSync(join(dir, "notebook", "notes", "a.md"), "utf8")).toBe("A note.");
        const codes = entity.river
          .read({ limit: 100_000 })
          .filter((row) => row.kind === "receipt")
          .map((row) => (row.data?.["refused"] as { code?: string } | undefined)?.code ?? "ok");
        expect(codes).toContain("refused_by_grant");
      },
    );
  });

  it("a once grant runs one matching call at call start, then the gate asks again", async () => {
    await withAsk(
      { ...CONFIG, tools: { write_note: "ask" } },
      [[call("write_note", NOTE_ARGS)], [call("write_note", NOTE_ARGS)], [call("write_note", NOTE_ARGS)]],
      async ({ entity, said, dir, turn }) => {
        await turn("First.");
        expect(said).toHaveLength(1);

        const grants = openGrants(dir);
        try {
          const [request] = grants.openRequests();
          expect(request).toBeDefined();
          grants.addGrant({
            tool: "write_note",
            scope: request!.scopeKey,
            kind: "once",
            argsHmac: request!.argsHmac,
            createdBy: "owner",
            nowMs: Date.now(),
          });
        } finally {
          grants.close();
        }

        await turn("Second.");
        expect(readFileSync(join(dir, "notebook", "notes", "a.md"), "utf8")).toBe("A note.");
        expect(said).toHaveLength(1);

        await turn("Third.");
        expect(said).toHaveLength(2);
        expect(entity.river.read({ limit: 100_000 }).some((row) => row.kind === "receipt")).toBe(true);
      },
    );
  });
});
