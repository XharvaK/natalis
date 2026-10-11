import { describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { notebookTools } from "./notebook-tools.js";

const THREAD = "dm:owner";
const CLOCK_MS = Date.UTC(2026, 9, 11, 11, 5);

// Invented fixtures: a gardener named Mara and a harbour.
const MARA_NOTE = "Mara likes tea.\nShe grows beans by the harbour.";

function tool(name: string): Tool {
  const found = notebookTools().find((t) => t.spec.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function fixture() {
  const river = new MemoryRiver({ nowMs: () => CLOCK_MS });
  const notebook = new MemoryNotebook({ nowMs: () => CLOCK_MS });
  await notebook.write("people/mara.md", MARA_NOTE, "fixture", "test");
  const context: ToolContext = { thread: THREAD, turnId: "turn-1", nowMs: CLOCK_MS, river, notebook };
  const run = (name: string, args: Record<string, unknown>): Promise<Receipt> => tool(name).run(args, context);
  return { river, notebook, context, run };
}

describe("notebookTools", () => {
  it("offers the eight core memory tools, each with an object schema and a plain description", () => {
    const tools = notebookTools();

    expect(tools.map((t) => t.spec.name)).toEqual([
      "read_note",
      "write_note",
      "edit_note",
      "append_note",
      "list_notes",
      "trash_note",
      "recall",
      "forget",
    ]);
    for (const t of tools) {
      expect(t.spec.parameters).toMatchObject({ type: "object" });
      expect(t.spec.description.length).toBeGreaterThan(20);
    }
  });
});

describe("read_note", () => {
  it("reads a note", async () => {
    const { run } = await fixture();

    const receipt = await run("read_note", { path: "people/mara.md" });

    expect(receipt).toMatchObject({ ok: true, summary: "Read people/mara.md.", data: { text: MARA_NOTE, truncated: false } });
  });

  it("refuses a note that is not there", async () => {
    const { run } = await fixture();

    expect(await run("read_note", { path: "people/tomas.md" })).toMatchObject({
      ok: false,
      summary: "There is no note at that path.",
      refused: { code: "not_found" },
    });
  });

  it("cuts a long note at 20 000 characters, with a notice", async () => {
    const { run, notebook } = await fixture();
    await notebook.write("long.md", "a".repeat(25_000), "long", "test");

    const receipt = await run("read_note", { path: "long.md" });
    const text = String(receipt.data?.["text"]);

    expect(receipt.ok).toBe(true);
    expect(receipt.data?.["truncated"]).toBe(true);
    expect(receipt.data?.["chars"]).toBe(25_000);
    expect(text.startsWith("a".repeat(20_000))).toBe(true);
    expect(text).toContain("[Truncated: the note has 25000 characters; the first 20000 are shown.]");
  });

  it("refuses a bad path plainly, and a missing path", async () => {
    const { run } = await fixture();

    expect(await run("read_note", { path: "../outside.md" })).toMatchObject({
      ok: false,
      refused: { code: "bad_path" },
    });
    expect(await run("read_note", {})).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("read_note", { path: "   " })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});

describe("write_note", () => {
  it("writes a whole note and attributes the change to the thread, with the reason", async () => {
    const { run, notebook } = await fixture();

    const receipt = await run("write_note", { path: "people/tomas.md", text: "Tomas fixes boats.", why: "met him today" });

    expect(receipt).toMatchObject({ ok: true, summary: "Wrote people/tomas.md." });
    expect(notebook.read("people/tomas.md")).toBe("Tomas fixes boats.");
    expect(notebook.log.at(-1)).toMatchObject({ op: "write", path: "people/tomas.md", reason: "met him today", author: "thread:dm:owner" });
  });

  it("allows an empty note, but refuses a missing reason", async () => {
    const { run, notebook } = await fixture();

    expect((await run("write_note", { path: "blank.md", text: "", why: "clearing" })).ok).toBe(true);
    expect(notebook.read("blank.md")).toBe("");
    expect(await run("write_note", { path: "x.md", text: "x", why: "  " })).toMatchObject({
      ok: false,
      summary: "The reason cannot be empty.",
      refused: { code: "bad_arguments" },
    });
    expect(await run("write_note", { path: "x.md", text: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});

describe("edit_note", () => {
  it("changes one passage", async () => {
    const { run, notebook } = await fixture();

    const receipt = await run("edit_note", {
      path: "people/mara.md",
      find: "grows beans",
      replace: "grows peas",
      why: "she changed crops",
    });

    expect(receipt).toMatchObject({ ok: true, summary: "Changed one passage in people/mara.md." });
    expect(notebook.read("people/mara.md")).toContain("She grows peas by the harbour.");
    expect(notebook.log.at(-1)).toMatchObject({ op: "edit", reason: "she changed crops" });
  });

  it("refuses text that is not in the note, with advice to read it again", async () => {
    const { run } = await fixture();

    expect(await run("edit_note", { path: "people/mara.md", find: "lemons", replace: "limes", why: "x" })).toMatchObject({
      ok: false,
      summary: "I could not find that text in the note. Read the note again and copy the exact wording.",
      refused: { code: "not_found" },
    });
  });

  it("refuses text that appears more than once", async () => {
    const { run, notebook } = await fixture();
    await notebook.write("twice.md", "tea, tea", "setup", "test");

    expect(await run("edit_note", { path: "twice.md", find: "tea", replace: "coffee", why: "x" })).toMatchObject({
      ok: false,
      summary: "That text appears more than once in the note. Use a longer piece so it is unique.",
      refused: { code: "ambiguous" },
    });
    expect(notebook.read("twice.md")).toBe("tea, tea");
  });

  it("refuses an empty find, and a note that does not exist", async () => {
    const { run } = await fixture();

    expect(await run("edit_note", { path: "people/mara.md", find: "", replace: "x", why: "x" })).toMatchObject({
      ok: false,
      refused: { code: "bad_arguments" },
    });
    expect(await run("edit_note", { path: "nope.md", find: "a", replace: "b", why: "x" })).toMatchObject({
      ok: false,
      summary: "I could not find that text in the note. Read the note again and copy the exact wording.",
    });
  });
});

describe("append_note", () => {
  it("adds to the end, and creates the note when it is not there", async () => {
    const { run, notebook } = await fixture();

    expect(await run("append_note", { path: "people/mara.md", text: "She sends postcards.", why: "new fact" })).toMatchObject({
      ok: true,
      summary: "Added to people/mara.md.",
    });
    expect(notebook.read("people/mara.md")).toBe(`${MARA_NOTE}\nShe sends postcards.`);

    expect((await run("append_note", { path: "diary.md", text: "Day one.", why: "start" })).ok).toBe(true);
    expect(notebook.read("diary.md")).toBe("Day one.");
  });

  it("refuses a missing text", async () => {
    const { run } = await fixture();

    expect(await run("append_note", { path: "diary.md", why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});

describe("list_notes", () => {
  it("lists every note with its size, time and first line", async () => {
    const { run, notebook } = await fixture();
    await notebook.write("places/harbour.md", "The harbour.\nBoats come in.", "setup", "test");

    const receipt = await run("list_notes", {});
    const entries = receipt.data?.["entries"] as Array<Record<string, unknown>>;

    expect(receipt).toMatchObject({ ok: true, summary: "Found 2 note(s)." });
    expect(entries.map((e) => e["path"])).toEqual(["people/mara.md", "places/harbour.md"]);
    expect(entries[1]).toMatchObject({ firstLine: "The harbour.", modified: "2026-10-11T11:05:00.000Z" });
  });

  it("lists one folder, and says so when a folder is empty", async () => {
    const { run } = await fixture();

    expect(await run("list_notes", { dir: "people" })).toMatchObject({ ok: true, summary: "Found 1 note(s) in people." });
    expect(await run("list_notes", { dir: "places" })).toMatchObject({ ok: true, summary: "There are no notes in places." });
    expect(await run("list_notes", { dir: 7 })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});

describe("trash_note", () => {
  it("moves a note to trash, so it can come back", async () => {
    const { run, notebook } = await fixture();

    expect(await run("trash_note", { path: "people/mara.md", why: "wrong person" })).toMatchObject({
      ok: true,
      summary: "Moved people/mara.md to the trash.",
    });
    expect(notebook.read("people/mara.md")).toBeNull();
    expect(notebook.read("trash/people/mara.md")).toBe(MARA_NOTE);
    expect(notebook.log.at(-1)).toMatchObject({ op: "remove", reason: "wrong person" });
  });

  it("refuses a note that is not there, and a missing reason", async () => {
    const { run } = await fixture();

    expect(await run("trash_note", { path: "nope.md", why: "x" })).toMatchObject({ ok: false, refused: { code: "not_found" } });
    expect(await run("trash_note", { path: "people/mara.md" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});

describe("recall", () => {
  it("merges river and notebook hits into one list, newest river rows first", async () => {
    const { run, river, notebook } = await fixture();
    await notebook.write("places/harbour.md", "Beans sell well at the harbour.", "setup", "test");
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Mara's beans are ready." });
    river.append({ thread: "room:garden", kind: "event", source: "outside", actor: "tomas", text: "Tomas asked about beans." });

    const receipt = await run("recall", { query: "BEANS" });
    const hits = receipt.data?.["hits"] as Array<Record<string, unknown>>;

    expect(receipt).toMatchObject({ ok: true, summary: 'Found 4 match(es) for "BEANS".' });
    expect(hits.map((h) => h["from"])).toEqual(["river", "notebook", "river", "notebook"]);
    expect(hits[0]).toMatchObject({ seq: 2, thread: "room:garden", text: "Tomas asked about beans." });
    expect(hits[1]).toMatchObject({ path: "people/mara.md", line: 2, text: "She grows beans by the harbour." });
    expect(hits[2]).toMatchObject({ seq: 1, text: "Mara's beans are ready." });
    expect(hits[3]).toMatchObject({ path: "places/harbour.md", line: 1 });
  });

  it("respects the limit and the cap of 20", async () => {
    const { run, river, notebook } = await fixture();
    for (let i = 0; i < 30; i += 1) {
      river.append({ thread: "dm:owner", kind: "say", source: "self", text: `Seed packet ${i}.` });
    }
    await notebook.write("seeds.md", Array.from({ length: 30 }, (_, i) => `seed line ${i}`).join("\n"), "setup", "test");

    expect((await run("recall", { query: "seed", limit: 3 })).data?.["hits"]).toHaveLength(3);
    expect((await run("recall", { query: "seed" })).data?.["hits"]).toHaveLength(10);
    expect((await run("recall", { query: "seed", limit: 20 })).data?.["hits"]).toHaveLength(20);
  });

  it("refuses a bad limit, and says when nothing matched", async () => {
    const { run } = await fixture();

    expect(await run("recall", { query: "seed", limit: 21 })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { query: "seed", limit: 0 })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { query: "seed", limit: 2.5 })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { query: "  " })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { query: "pumpkins" })).toMatchObject({ ok: true, summary: 'Nothing matched "pumpkins".' });
  });

  it("does not return forgotten rows", async () => {
    const { run, river } = await fixture();
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "A secret about the boat." });
    river.forget({ text: "secret" }, "self", "Not for keeping.");

    expect((await run("recall", { query: "boat" })).data?.["hits"]).toEqual([]);
  });
});

describe("forget", () => {
  it("erases the rows that contain some words, says how many, and leaves a tombstone", async () => {
    const { run, river } = await fixture();
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "The boat leaks." });
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "The boat is fine." });

    const receipt = await run("forget", { query: "boat", why: "I was wrong about it" });

    expect(receipt).toMatchObject({ ok: true, summary: "Forgot 2 row(s) from your river.", data: { erased: 2 } });
    const tombstone = river.read({ kinds: ["tombstone"] });
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]).toMatchObject({ source: "self", data: { erased: 2, by: "self", reason: "I was wrong about it" } });
  });

  it("erases by row number", async () => {
    const { run, river } = await fixture();
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Something to drop." });
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Something else to drop." });

    expect(await run("forget", { seqs: [1, 2], why: "clear the start" })).toMatchObject({ ok: true, data: { erased: 2 } });
    expect(river.read({ kinds: ["say"] }).every((r) => r.text === undefined)).toBe(true);
  });

  it("says nothing matched, and forgets nothing", async () => {
    const { run, river } = await fixture();
    const before = river.lastSeq();

    expect(await run("forget", { query: "pumpkins", why: "check" })).toMatchObject({
      ok: true,
      summary: "Nothing matched, so nothing was forgotten.",
      data: { erased: 0 },
    });
    expect(river.lastSeq()).toBe(before);
  });

  it("refuses when given both or neither of words and row numbers, or a bad list", async () => {
    const { run } = await fixture();

    expect(await run("forget", { query: "boat", seqs: [1], why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("forget", { why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("forget", { seqs: [], why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("forget", { seqs: [0], why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("forget", { seqs: ["1"], why: "x" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("forget", { query: "boat" })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
  });
});
