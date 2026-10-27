import { describe, expect, it } from "vitest";
import type { Tool, ToolContext } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { notebookTools } from "./notebook-tools.js";

const NOW = Date.UTC(2026, 9, 27);
const LIFE = [
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
  "I grow beans by the harbour.",
  "",
].join("\n");

async function fixture(note = LIFE) {
  const notebook = new MemoryNotebook({ nowMs: () => NOW });
  await notebook.write("self/life.md", note, "fixture", "test");
  const context: ToolContext = { thread: "dm:owner", turnId: "t", nowMs: NOW, river: new MemoryRiver({ nowMs: () => NOW }), notebook };
  const run = (name: string, args: Record<string, unknown>) => {
    const found: Tool | undefined = notebookTools().find((item) => item.spec.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found.run(args, context);
  };
  return { notebook, run };
}

describe("read_note with a section", () => {
  it("returns that whole section by its heading line or its bare title", async () => {
    const { run } = await fixture();

    const full = await run("read_note", { path: "self/life.md", section: "## Work" });
    expect(full).toMatchObject({
      ok: true,
      summary: "Read self/life.md, section ## Work.",
      data: { path: "self/life.md", section: "## Work", text: "## Work\n\nI work at the bakery on Quay Street.", truncated: false },
    });

    const bare = await run("read_note", { path: "self/life.md", section: "Garden" });
    expect(bare).toMatchObject({ ok: true, data: { text: "## Garden\n\nI grow beans by the harbour." } });
  });

  it("returns a section whole even when it is longer than the whole-note read limit", async () => {
    const long = "g".repeat(25_000);
    const { run } = await fixture(`# Life\n\n## Long\n\n${long}\n`);

    const receipt = await run("read_note", { path: "self/life.md", section: "## Long" });

    expect(receipt.ok).toBe(true);
    expect(receipt.data?.["truncated"]).toBe(false);
    expect(String(receipt.data?.["text"])).toContain(long);
    expect(String(receipt.data?.["text"])).not.toContain("[Truncated:");
  });

  it("refuses a heading the note does not have, and an empty heading, plainly", async () => {
    const { run } = await fixture();

    const missing = await run("read_note", { path: "self/life.md", section: "## Boats" });
    expect(missing).toMatchObject({ ok: false, refused: { code: "section_not_found" } });
    expect(missing.summary).toMatch(/no heading "## Boats"/);
    expect(await run("read_note", { path: "self/life.md", section: "   " })).toMatchObject({
      ok: false,
      refused: { code: "bad_arguments" },
    });
  });
});
