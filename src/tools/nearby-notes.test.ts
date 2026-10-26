import { describe, expect, it } from "vitest";
import type { Receipt, ToolContext } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { nearbyNotes, notebookTools } from "./notebook-tools.js";

const NOW = Date.UTC(2026, 9, 27);
async function fixture() {
  const notebook = new MemoryNotebook({ nowMs: () => NOW });
  await notebook.write("people/mara-gardener.md", "Mara the gardener\nLikes tea.", "f", "t");
  await notebook.write("places/harbour.md", "The harbour\nBoats.", "f", "t");
  const context: ToolContext = { thread: "dm:owner", turnId: "t", nowMs: NOW, river: new MemoryRiver({ nowMs: () => NOW }), notebook };
  const run = (name: string, args: Record<string, unknown>): Promise<Receipt> => notebookTools().find((t) => t.spec.name === name)!.run(args, context);
  return { notebook, run };
}

describe("nearby notes before a new note is written", () => {
  it("finds notes that share a word with the new path or its first line", async () => {
    const { notebook } = await fixture();
    expect(nearbyNotes(notebook, "people/mara.md", "Mara\nShe moved.")).toEqual(["people/mara-gardener.md"]);
    expect(nearbyNotes(notebook, "diary/2026-10-27.md", "A quiet day.")).toEqual([]);
  });

  it("shows the nearby notes and writes nothing; new_note: true writes it anyway", async () => {
    const { notebook, run } = await fixture();
    const first = await run("write_note", { path: "people/mara.md", text: "Mara\nShe moved.", why: "news" });
    expect(first.refused?.code).toBe("nearby_notes");
    expect(first.refused?.reason).toContain("people/mara-gardener.md");
    expect(notebook.read("people/mara.md")).toBeNull();
    const second = await run("write_note", { path: "people/mara.md", text: "Mara\nShe moved.", why: "news", new_note: true });
    expect(second.ok).toBe(true);
  });

  it("never asks when the note already exists or nothing is near", async () => {
    const { run } = await fixture();
    expect((await run("write_note", { path: "places/harbour.md", text: "The harbour\nFerries.", why: "update" })).ok).toBe(true);
    expect((await run("write_note", { path: "diary/2026-10-27.md", text: "A quiet day.", why: "diary" })).ok).toBe(true);
  });

  it("NIT-2: common words alone do not count as near", async () => {
    const { notebook, run } = await fixture();
    await notebook.write("memory/that-time.md", "That time with the rain\nWet.", "f", "t");
    expect(nearbyNotes(notebook, "memory/note-about-this.md", "This note is about that thing with them")).toEqual([]);
    expect((await run("write_note", { path: "memory/note-about-this.md", text: "This note is about that thing with them", why: "t" })).ok).toBe(true);
  });
});
