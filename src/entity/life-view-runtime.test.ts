import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityConfig, ModelRequest, RiverRow } from "../contracts.js";
import { ScriptedModel, call, reply, type ScriptStep } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { openEntity, type Entity } from "./runtime.js";

// Invented people and places only.
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 200_000 },
  ceiling: { maxModelCalls: 30, maxToolCalls: 60 },
  owner: { alias: "owner" },
  rhythm: [],
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 5 })));

const LIFE_HEAD =
  "# Life\n\nMy brief: I live by the harbour.\n\n## Work\n\nI work at the bakery on Quay Street.\n\n## Notes\n\n";

/** A life file of exactly `total` characters: a small first part, a short Work section, and a long Notes section. */
function lifeOf(total: number): string {
  return LIFE_HEAD + "n".repeat(Math.max(0, total - LIFE_HEAD.length));
}

function systemTextOf(request: ModelRequest | undefined): string {
  const message = request?.messages[0];
  return message?.role === "system" ? message.content : "";
}

function userTextOf(request: ModelRequest | undefined): string {
  const message = [...(request?.messages ?? [])].reverse().find((item) => item.role === "user");
  return message?.role === "user" ? message.content : "";
}

function receiptsShownIn(request: ModelRequest | undefined): Array<Record<string, unknown>> {
  return (request?.messages ?? []).flatMap((message) => {
    if (message.role !== "tool") return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });
}

function lifeViewNotes(entity: Entity): RiverRow[] {
  return entity.river
    .read({ limit: 100_000 })
    .filter((row) => row.kind === "note" && row.data?.["bodyNote"] === "life_view");
}

function honestyReply(contradicts: boolean, claimQuote = "", recordQuote = "") {
  return reply({ content: JSON.stringify({ contradicts, claim_quote: claimQuote, record_quote: recordQuote }) });
}

async function startWithLife(config: EntityConfig, life: string, steps?: ScriptStep[]) {
  const root = mkdtempSync(join(tmpdir(), "natalis-life-view-"));
  roots.push(root);
  const model = new ScriptedModel(
    steps ?? Array.from({ length: 8 }, () => reply({ toolCalls: [call("end_turn")] })),
  );
  const said: Array<{ place: string; text: string }> = [];
  const cli = createCliWorld({ onSay: (place, text) => said.push({ place, text }) });
  const entity = await openEntity({ dir: join(root, "lar"), config, model, worlds: [cli] });
  await entity.notebook.write("self/life.md", life, "test", "self");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await entity.start();
  } finally {
    log.mockRestore();
  }
  return { entity, model, cli, said };
}

describe("the life view at 80% and over the switch", () => {
  it("at 32,000 characters writes one heads-up in her self thread and still shows the whole file", async () => {
    const { entity, model, cli } = await startWithLife(CONFIG, lifeOf(32_000));
    try {
      cli.send("Hello.");
      await entity.idle();

      const notes = lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "heads_up");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.thread).toBe("self");
      expect(notes[0]?.text).toBe(
        "Your life file is about 32,000 characters. At 40,000 you will see its first part and the parts that matter to " +
          "each conversation, not the whole file. The first part is always shown, so put there what you always want in view.",
      );
      expect(lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "switched")).toHaveLength(0);

      const system = systemTextOf(model.requests[0]);
      expect(system).toContain("n".repeat(1_000));
      expect(system).not.toContain("read_note self/life.md section:");

      cli.send("Another line.");
      await entity.idle();
      expect(lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "heads_up")).toHaveLength(1);
    } finally {
      await entity.stop();
    }
  });

  it("at 40,000 shows the first part, the whole sections that matter, and a pointer for the rest, with one note", async () => {
    const { entity, model, cli } = await startWithLife(CONFIG, lifeOf(40_000));
    try {
      cli.send("Where do you work?");
      await entity.idle();
      cli.send("Anything else?");
      await entity.idle();

      const notes = lifeViewNotes(entity);
      expect(notes.filter((row) => row.data?.["phase"] === "switched")).toHaveLength(1);
      expect(notes.filter((row) => row.data?.["phase"] === "back")).toHaveLength(0);

      const system = systemTextOf(model.requests[0]);
      expect(system).toContain("# Life\n\nMy brief: I live by the harbour.");
      expect(system).toContain("## Work\n\nI work at the bakery on Quay Street.");
      expect(system).toContain("read_note self/life.md section: ## Notes");
      expect(system).not.toContain("n".repeat(1_000));
    } finally {
      await entity.stop();
    }
  });

  it("trimmed below the switch shows the whole file again, with one note", async () => {
    const { entity, model, cli } = await startWithLife(CONFIG, lifeOf(40_000));
    try {
      cli.send("One.");
      await entity.idle();
      expect(systemTextOf(model.requests[0])).toContain("read_note self/life.md section: ## Notes");

      await entity.notebook.write("self/life.md", lifeOf(1_000), "test", "self");
      cli.send("Two.");
      await entity.idle();

      const system = systemTextOf(model.requests[1]);
      expect(system).toContain(lifeOf(1_000).trim());
      expect(system).not.toContain("read_note self/life.md section:");
      expect(lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "back")).toHaveLength(1);

      cli.send("Three.");
      await entity.idle();
      expect(lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "back")).toHaveLength(1);
    } finally {
      await entity.stop();
    }
  });

  it("a file with no headings stays whole, with one note that the view needs headings", async () => {
    const plain = `I live by the harbour. ${"n".repeat(40_000)}`;
    const { entity, model, cli } = await startWithLife(CONFIG, plain);
    try {
      cli.send("Hello.");
      await entity.idle();

      const notes = lifeViewNotes(entity);
      expect(notes.filter((row) => row.data?.["phase"] === "needs_headings")).toHaveLength(1);
      expect(notes.filter((row) => row.data?.["phase"] === "switched")).toHaveLength(0);

      const system = systemTextOf(model.requests[0]);
      expect(system).toContain("n".repeat(1_000));
      expect(system).not.toContain("read_note self/life.md section:");

      cli.send("Another line.");
      await entity.idle();
      expect(lifeViewNotes(entity).filter((row) => row.data?.["phase"] === "needs_headings")).toHaveLength(1);
    } finally {
      await entity.stop();
    }
  });
});

describe("a held say under the switched view", () => {
  it("names a heading that is not shown, so she can open that section with read_note", async () => {
    const life = [
      "# Life",
      "",
      "My brief: I live by the harbour.",
      "",
      "## Work",
      "",
      "I work at the bakery on Quay Street.",
      "",
      "## Garden",
      "",
      "I keep the boat at the point.",
      "",
    ].join("\n");
    const config: EntityConfig = {
      ...CONFIG,
      holds: { honesty: true },
      limits: { lifeWarnChars: 100, lifeViewChars: 55 },
    };
    const steps: ScriptStep[] = [
      reply({ toolCalls: [call("say", { place: "cli:summoner", text: "I work at the lighthouse." })] }),
      honestyReply(true, "I work at the lighthouse", "I work at the bakery on Quay Street"),
      reply({ toolCalls: [call("end_turn")] }),
    ];
    const { entity, model, cli, said } = await startWithLife(config, life, steps);
    try {
      cli.send("Where do you work?");
      await entity.idle();

      expect(said).toEqual([]);
      const system = systemTextOf(model.requests[0]);
      expect(system).toContain("My brief: I live by the harbour.");
      expect(system).not.toContain("I work at the bakery on Quay Street.");
      expect(system).toContain("read_note self/life.md section: ## Work");
      // The honesty check still reads the whole record, including the section that was not shown.
      expect(userTextOf(model.requests[1])).toContain("I work at the bakery on Quay Street.");

      const refused = receiptsShownIn(model.requests[2]).find((item) => item["ok"] === false);
      expect(refused).toMatchObject({ refused: { code: "held_honesty" } });
      const reason = String((refused?.["refused"] as Record<string, unknown> | undefined)?.["reason"] ?? "");
      expect(reason).toContain('under the heading "## Work"');
    } finally {
      await entity.stop();
    }
  });
});
