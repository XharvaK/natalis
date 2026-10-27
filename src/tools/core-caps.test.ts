import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openNotebook } from "../notebook/git-notebook.js";
import type { Receipt, ToolContext } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { CORE_NOTE_CAPS, notebookTools } from "./notebook-tools.js";

const NOW = Date.UTC(2026, 9, 27);
async function fixture() {
  const notebook = new MemoryNotebook({ nowMs: () => NOW });
  const context: ToolContext = { thread: "dm:owner", turnId: "t", nowMs: NOW, river: new MemoryRiver({ nowMs: () => NOW }), notebook };
  const run = (name: string, args: Record<string, unknown>): Promise<Receipt> => notebookTools().find((t) => t.spec.name === name)!.run(args, context);
  return { notebook, run };
}
const CAP = CORE_NOTE_CAPS["self/character.md"] as number;

describe("size caps on core self notes", () => {
  it("caps character only, and nothing else", () => {
    expect(Object.keys(CORE_NOTE_CAPS)).toEqual(["self/character.md"]);
  });

  it("refuses a write, edit or append that would take a core note past its cap, and writes nothing", async () => {
    const { notebook, run } = await fixture();
    const big = "a".repeat(CAP + 1);
    expect((await run("write_note", { path: "self/character.md", text: big, why: "t" })).refused?.code).toBe("core_note_full");
    expect(notebook.read("self/character.md")).toBeNull();
    await run("write_note", { path: "self/character.md", text: "a".repeat(CAP - 5), why: "t" });
    expect((await run("append_note", { path: "self/character.md", text: "bbbbbbbbbb", why: "t" })).refused?.code).toBe("core_note_full");
    expect((await run("edit_note", { path: "self/character.md", find: "aaaa", replace: "c".repeat(20), why: "t" })).refused?.code).toBe("core_note_full");
    expect((await run("write_note", { path: "memory/long.md", text: big, why: "t" })).ok).toBe(true);
  });

  it("lets life.md grow past 8000 characters (no cap), while character.md stays capped", async () => {
    const { notebook, run } = await fixture();
    expect((await run("write_note", { path: "self/life.md", text: "l".repeat(9000), why: "t" })).ok).toBe(true);
    expect((await run("append_note", { path: "self/life.md", text: "more", why: "t" })).ok).toBe(true);
    expect(notebook.read("self/life.md")?.length).toBeGreaterThan(9000);
    expect((await run("write_note", { path: "self/character.md", text: "c".repeat(9000), why: "t" })).refused?.code).toBe("core_note_full");
  });

  it("lets a note already over its cap be edited when the edit does not make it longer", async () => {
    const { notebook, run } = await fixture();
    await notebook.write("self/character.md", "MARK " + "z".repeat(CAP + 100), "old", "self");
    expect((await run("edit_note", { path: "self/character.md", find: "MARK ", replace: "y", why: "trim" })).ok).toBe(true);
    expect((await run("write_note", { path: "self/character.md", text: "short", why: "trim" })).ok).toBe(true);
  });

  it("SHOULD-1: caps the note under any spelling of its path (./self/, self//, case)", async () => {
    for (const spelling of ["./self/character.md", "self//character.md", "self/./character.md", "Self/Character.md"]) {
      const { notebook, run } = await fixture();
      await notebook.write("self/character.md", "a".repeat(CAP - 5), "f", "self");
      expect((await run("append_note", { path: spelling, text: "bbbbbbbbbb", why: "t" })).refused?.code).toBe("core_note_full");
      expect((await run("write_note", { path: spelling, text: "a".repeat(CAP + 1), why: "t" })).refused?.code).toBe("core_note_full");
      expect((await run("edit_note", { path: spelling, find: "aaaaa", replace: "c".repeat(20), why: "t" })).refused?.code).toBe("core_note_full");
      expect(notebook.read("self/character.md")?.length).toBe(CAP - 5);
    }
  });

  it("counts characters as Unicode code points, not bytes or UTF-16 units", async () => {
    const { notebook, run } = await fixture();
    // An emoji is 1 code point, 2 UTF-16 units, 4 bytes; an accented letter is 1 code point, 2 bytes.
    const full = "\u{1F600}".repeat(CAP / 2) + "\u00e9".repeat(CAP / 2);
    expect((await run("write_note", { path: "self/character.md", text: full, why: "t" })).ok).toBe(true);
    expect([...(notebook.read("self/character.md") ?? "")].length).toBe(CAP);
    expect((await run("append_note", { path: "self/character.md", text: "\u{1F600}", why: "t" })).refused?.code).toBe("core_note_full");
    expect((await run("write_note", { path: "self/character.md", text: "\u{1F600}".repeat(CAP + 1), why: "t" })).refused?.code).toBe("core_note_full");
  });
});

describe("NIT-1: the cap holds under concurrent appends", () => {
  it("two appends that together cross the cap, on a git notebook: one is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "natalis-cap-race-"));
    try {
      const notebook = await openNotebook(join(root, "nb"));
      await notebook.write("self/character.md", "a".repeat(CAP - 10), "f", "self");
      const context: ToolContext = { thread: "dm:owner", turnId: "t", nowMs: NOW, river: new MemoryRiver({ nowMs: () => NOW }), notebook };
      const run = (args: Record<string, unknown>) => notebookTools().find((t) => t.spec.name === "append_note")!.run(args, context);
      const [one, two] = await Promise.all([
        run({ path: "self/character.md", text: "b".repeat(6), why: "t" }),
        run({ path: "self/character.md", text: "c".repeat(6), why: "t" }),
      ]);
      expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
      expect([...(notebook.read("self/character.md") ?? "")].length).toBeLessThanOrEqual(CAP);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("NIT-A: the cap queue is per notebook", () => {
  const BOUND_MS = 1000;

  it("a hung write on one Lar's character.md does not delay another Lar's append", async () => {
    const larA = new MemoryNotebook({ root: "memory://lar-a", nowMs: () => NOW });
    const larB = new MemoryNotebook({ root: "memory://lar-b", nowMs: () => NOW });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    larA.write = () => {
      markEntered();
      return new Promise<void>(() => {});
    };
    const contextOf = (notebook: MemoryNotebook): ToolContext => ({
      thread: "dm:owner",
      turnId: "t",
      nowMs: NOW,
      river: new MemoryRiver({ nowMs: () => NOW }),
      notebook,
    });
    const run = (context: ToolContext, name: string, args: Record<string, unknown>): Promise<Receipt> =>
      notebookTools().find((t) => t.spec.name === name)!.run(args, context);

    const hung = run(contextOf(larA), "write_note", { path: "self/character.md", text: "a", why: "t" });
    await entered; // Lar A's write holds its notebook's cap queue.

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Lar B waited on Lar A's hung write")), BOUND_MS);
    });
    try {
      const receipt = await Promise.race([
        run(contextOf(larB), "append_note", { path: "self/character.md", text: "b", why: "t" }),
        bound,
      ]);
      expect(receipt.ok).toBe(true);
      expect(larB.read("self/character.md")).toBe("b");
    } finally {
      clearTimeout(timer);
      void hung.catch(() => {});
    }
  });
});
