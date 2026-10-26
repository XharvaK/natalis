import { describe, expect, it } from "vitest";
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
  it("caps character and life, and nothing else", () => {
    expect(Object.keys(CORE_NOTE_CAPS).sort()).toEqual(["self/character.md", "self/life.md"]);
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

  it("lets a note already over its cap be edited when the edit does not make it longer", async () => {
    const { notebook, run } = await fixture();
    await notebook.write("self/life.md", "z".repeat(CAP + 100), "old", "self");
    expect((await run("edit_note", { path: "self/life.md", find: "zzzzzzzzzz", replace: "y", why: "trim" })).ok).toBe(true);
    expect((await run("write_note", { path: "self/life.md", text: "short", why: "trim" })).ok).toBe(true);
  });
});
