import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Receipt, RiverRow, Tool } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel, call, reply } from "../testing/scripted-model.js";
import { notebookTools } from "../tools/notebook-tools.js";
import { effectOf, READ_TOOLS } from "../tools/effects.js";
import { createDiscordWorld, type PlatformClient } from "../worlds/discord/discord-world.js";
import { gameLookTool } from "../worlds/domus/look.js";
import { gameSnapshotTool } from "../worlds/domus/snapshot.js";
import { gameActTool } from "../worlds/domus/game-act.js";
import { gameCatalogTool } from "../worlds/domus/catalog.js";
import { gameMemoryTool } from "../worlds/domus/memory.js";
import { gameListTool } from "../worlds/domus/lists.js";
import { gameOverlaySayTool } from "../worlds/domus/overlay.js";
import { gameAttentionTool } from "../worlds/domus/attention.js";
import { verbTools } from "../worlds/domus/verbs.js";
import { END_TURN, runTurn } from "./run-turn.js";

const NOW = Date.UTC(2026, 9, 26, 12);

/** Mark real tools with the world that offers them, as the runtime does. */
function inWorld(world: string, tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => ({ ...tool, spec: { ...tool.spec, world } }));
}

/** The effect table's key: world, then name. */
function keyOf(spec: { name: string; world?: string }): string {
  return `${spec.world ?? "no-world"}/${spec.name}`;
}

// Built from parts at run time, so no token-shaped literal sits in the source.
const FAKE_DISCORD_TOKEN = ["fake", "discord", "token"].join("-");

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
  it("defaults to write when nothing is declared, and keys the read list by world and name", () => {
    expect(effectOf({ name: "mystery", description: "", parameters: {} })).toBe("write");
    expect(effectOf({ name: "recall", description: "", parameters: {} })).toBe("read");
    expect(effectOf({ name: "recall", description: "", parameters: {}, effect: "write" })).toBe("write");
    expect([...READ_TOOLS].sort()).toEqual(["body/list_notes", "body/look", "body/permissions", "body/read_note", "body/recall", "discord/read_history"]);
    for (const name of ["say", "game_act", "web_request", "write_note", "schedule_wake", "forget"]) {
      expect([...READ_TOOLS].some((key) => key.endsWith(`/${name}`))).toBe(false);
    }
  });

  it("does not read a world tool just because the body has a read tool of that name", () => {
    expect(effectOf({ name: "read_history", description: "", parameters: {}, world: "body" })).toBe("write");
    expect(effectOf({ name: "read_history", description: "", parameters: {}, world: "discord" })).toBe("read");
    expect(effectOf({ name: "look", description: "", parameters: {}, world: "domus" })).toBe("write");
    expect(effectOf({ name: "read_note", description: "", parameters: {}, world: "domus" })).toBe("write");
    expect(effectOf({ name: "read_note", description: "", parameters: {}, world: "body" })).toBe("read");
  });

  it("labels every notebook tool, read or write, and only reads as read", () => {
    const effects = Object.fromEntries(notebookTools().map((t) => [t.spec.name, effectOf(t.spec)]));
    expect(effects).toMatchObject({ read_note: "read", list_notes: "read", recall: "read", write_note: "write", edit_note: "write", append_note: "write", trash_note: "write", forget: "write" });
  });
});

describe("dry run", () => {
  it("runs reads, stubs writes with a typed receipt marked stubbed, and still ends the turn", async () => {
    const read = counting("recall", undefined);
    const write = counting("poke", undefined);
    const { result, rows } = await turn([read.tool, write.tool], ["recall", "poke"], { dryRun: true });
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
    const read = counting("recall", undefined, 2);
    const { result, rows } = await turn([read.tool], ["recall"]);
    expect(read.runs()).toBe(3);
    expect(result.receipts.find((r) => r.tool === "recall")?.receipt.ok).toBe(true);
    expect(rows.filter((r) => r.kind === "note" && r.data?.["retryOf"] === "recall")).toHaveLength(2);
  });

  it("never retries a write", async () => {
    const write = counting("poke", "write", 1);
    const { result } = await turn([write.tool], ["poke"]);
    expect(write.runs()).toBe(1);
    expect(result.receipts.find((r) => r.tool === "poke")?.receipt.ok).toBe(false);
  });

  it("gives up after 3 runs of a read that keeps failing", async () => {
    const read = counting("recall", undefined, 9);
    const { result } = await turn([read.tool], ["recall"]);
    expect(read.runs()).toBe(3);
    expect(result.receipts.find((r) => r.tool === "recall")?.receipt.refused?.code).toBe("tool_error");
  });
});

describe("every tool's effect (SHOULD-2 table)", () => {
  const never = () => {
    throw new Error("not opened in this test");
  };
  const worldTools: Tool[] = inWorld("domus", [
    gameLookTool(never as never),
    gameSnapshotTool(never as never),
    gameActTool(never as never),
    gameCatalogTool(never as never),
    gameMemoryTool(never as never),
    gameListTool(never as never),
    gameOverlaySayTool(never as never),
    gameAttentionTool(never as never),
    ...verbTools(never as never),
  ]);
  const EXPECTED: Record<string, "read" | "write" | "idempotent"> = {
    read_note: "read", list_notes: "read", recall: "read", write_note: "write", edit_note: "write", append_note: "write", trash_note: "write", forget: "write",
    game_look: "idempotent", game_snapshot: "idempotent", game_act: "write", game_catalog: "write", game_memory: "write", game_list: "write",
    game_overlay_say: "write", game_attention: "write",
  };
  it("matches the table for every notebook and Domus tool; any other Domus tool is a write", () => {
    for (const tool of [...notebookTools(), ...worldTools]) {
      expect([tool.spec.name, effectOf(tool.spec)]).toEqual([tool.spec.name, EXPECTED[tool.spec.name] ?? "write"]);
    }
  });
  it("the body and other world tools, each under its own world", () => {
    const byName = (world: string, name: string) => effectOf({ name, description: "", parameters: {}, world });
    const table: Array<[world: string, name: string]> = [
      ["body", "look"], ["body", "say"], ["body", "schedule_wake"], ["body", "cancel_wake"], ["body", "set_mood"],
      ["body", "let_go"], ["body", "propose_commitment"], ["discord", "read_history"], ["discord", "react"],
      ["web", "web_request"], ["sandbox", "run"],
    ];
    const effects = Object.fromEntries(table.map(([world, name]) => [name, byName(world, name)]));
    expect(effects).toEqual({
      look: "read", read_history: "read", say: "write", schedule_wake: "write", cancel_wake: "write", set_mood: "write", let_go: "write",
      propose_commitment: "write", react: "write", web_request: "write", run: "write",
    });
  });
  it("NIT-2/NIT-B: a tool that declares read or idempotent for itself, but is not on its allowlist, is a write", () => {
    expect(effectOf({ name: "sneaky", description: "", parameters: {}, effect: "read" })).toBe("write");
    expect(effectOf({ name: "sneaky", description: "", parameters: {}, effect: "idempotent" })).toBe("write");
    expect(effectOf({ name: "game_look", description: "", parameters: {}, effect: "idempotent" })).toBe("write");
    expect(effectOf({ name: "game_look", description: "", parameters: {}, world: "domus", effect: "idempotent" })).toBe("idempotent");
    expect(effectOf({ ...gameActTool(never as never).spec, effect: "idempotent", world: "domus" })).toBe("write");
  });
});

describe("NIT-A: the effect table over real tool specs", () => {
  it("classifies every Discord tool from the world's own specs", () => {
    const root = mkdtempSync(join(tmpdir(), "natalis-effects-"));
    try {
      const world = createDiscordWorld({
        token: FAKE_DISCORD_TOKEN,
        ownerUserId: "owner-1",
        rooms: [],
        aliasesPath: join(root, "aliases.json"),
        client: {} as PlatformClient,
      });
      const tools = inWorld(world.id, world.tools());
      expect(tools.map((tool) => tool.spec.name).sort()).toEqual(["react", "read_history"]);
      expect(Object.fromEntries(tools.map((tool) => [keyOf(tool.spec), effectOf(tool.spec)]))).toEqual({
        "discord/react": "write",
        "discord/read_history": "read",
      });
      // The same real spec under another world is not a read.
      const readHistory = tools.find((tool) => tool.spec.name === "read_history")!;
      expect(effectOf({ ...readHistory.spec, world: "domus" })).toBe("write");
      expect(effectOf({ ...readHistory.spec, world: "discord" })).toBe("read");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("dry run with game requests (SHOULD-1)", () => {
  it("stubs game_look and game_snapshot in a dry run: their run is never called", async () => {
    let opened = 0;
    const open = () => {
      opened += 1;
      throw new Error("must not run");
    };
    const { result } = await turn([gameLookTool(open as never), gameSnapshotTool(open as never)], ["game_look", "game_snapshot"], { dryRun: true });
    expect(opened).toBe(0);
    expect(result.receipts.filter((r) => r.receipt.data?.["stubbed"] === true).map((r) => r.tool)).toEqual(["game_look", "game_snapshot"]);
  });
});

describe("retryable refusals (NIT-1)", () => {
  function refusing(name: string, times: number, world = "body") {
    let runs = 0;
    const tool: Tool = {
      spec: { name, description: name, parameters: { type: "object", properties: {} }, world },
      async run(): Promise<Receipt> {
        runs += 1;
        return runs <= times ? { ok: false, summary: "Could not read.", refused: { code: "history_failed", reason: "x" }, retryable: true } : { ok: true, summary: "ok" };
      },
    };
    return { tool, runs: () => runs };
  }
  it("retries a read whose receipt is a retryable refusal", async () => {
    const t = refusing("read_history", 1, "discord");
    const { result, rows } = await turn([t.tool], ["read_history"]);
    expect(t.runs()).toBe(2);
    expect(result.receipts.find((r) => r.tool === "read_history")?.receipt.ok).toBe(true);
    expect(rows.filter((r) => r.kind === "note" && r.data?.["retryOf"] === "read_history")).toHaveLength(1);
  });
  it("never retries a write's retryable refusal", async () => {
    const t = refusing("poke", 1);
    await turn([t.tool], ["poke"]);
    expect(t.runs()).toBe(1);
  });
});
