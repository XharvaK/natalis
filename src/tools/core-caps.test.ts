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
