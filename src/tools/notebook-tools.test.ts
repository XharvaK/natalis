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

  it("reports the length in code points, so one emoji is one character", async () => {
    const { run, notebook } = await fixture();

    const receipt = await run("write_note", { path: "diary.md", text: "😀", why: "one face" });

    expect(receipt).toMatchObject({ ok: true, data: { path: "diary.md", chars: 1 } });
    expect(notebook.read("diary.md")).toBe("😀");
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

  it("reports the added length in code points, so one emoji is one character", async () => {
    const { run, notebook } = await fixture();

    const receipt = await run("append_note", { path: "diary.md", text: "😀", why: "one face" });

    expect(receipt).toMatchObject({ ok: true, data: { path: "diary.md", chars: 1 } });
    expect(notebook.read("diary.md")).toBe("😀");
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

  it("finds a note from a few loose words, the line holding most of them first", async () => {
    const { run, notebook } = await fixture();
    await notebook.write("owner.md", "Favourite bird: heron\nCode word: kettle-four", "setup", "test");

    const receipt = await run("recall", { query: "favourite bird heron kettle-four" });
    const notes = (receipt.data?.["hits"] as Array<Record<string, unknown>>).filter((h) => h["from"] === "notebook");

    expect(notes.map((h) => h["line"])).toEqual([1, 2]);
    expect(notes[0]).toMatchObject({ path: "owner.md", text: "Favourite bird: heron" });
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

describe("recall by seqs", () => {
  it("opens the named rows whole, in seq order", async () => {
    const { run, river } = await fixture();
    const longText = "The harbour bell rang at dawn and the boats came in. ".repeat(40).trim();
    const first = river.append({ thread: "room:garden", kind: "event", source: "outside", actor: "mara", text: longText });
    river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Mara counted the nets." });
    const third = river.append({ thread: "room:garden", kind: "event", source: "outside", actor: "tomas", text: "Tomas mended the sail." });

    const receipt = await run("recall", { seqs: [third.seq, first.seq] });
    const hits = receipt.data?.["hits"] as Array<Record<string, unknown>>;

    expect(receipt).toMatchObject({ ok: true, summary: "Read 2 rows." });
    expect(hits.map((hit) => hit["seq"])).toEqual([first.seq, third.seq]);
    expect(hits[0]?.text).toBe(longText);
    expect(hits[1]?.text).toBe("Tomas mended the sail.");
    expect(String(hits[0]?.text).length).toBe(longText.length);
  });

  it("shows a forgotten row as forgotten, never its content", async () => {
    const { run, river } = await fixture();
    const secret = "The blue boat carries the seed money.";
    const row = river.append({ thread: "dm:owner", kind: "say", source: "self", text: secret });
    river.forget({ seqs: [row.seq] }, "self", "Not mine to keep.");

    const receipt = await run("recall", { seqs: [row.seq] });
    const hits = receipt.data?.["hits"] as Array<Record<string, unknown>>;

    expect(receipt.ok).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ seq: row.seq, text: "(forgotten)" });
    expect(JSON.stringify(receipt)).not.toContain("blue boat");
    expect(JSON.stringify(receipt)).not.toContain("seed money");
  });

  it("says a missing row does not exist", async () => {
    const { run } = await fixture();

    expect(await run("recall", { seqs: [999] })).toMatchObject({
      ok: false,
      summary: "There is no row 999.",
      refused: { code: "not_found" },
    });
  });

  it("needs words or row numbers, and keeps row numbers to 1 to 20", async () => {
    const { run } = await fixture();

    expect(await run("recall", {})).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { seqs: [] })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { seqs: [0] })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { seqs: [1.5] })).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(await run("recall", { seqs: Array.from({ length: 21 }, (_, i) => i + 1) })).toMatchObject({
      ok: false,
      refused: { code: "bad_arguments" },
    });
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

describe("the notes only the body writes", () => {
  const HOUSEHOLD = "self/household.md";
  const COMMITMENTS = "self/constitution.md";

  it("refuses write, edit, append and trash on the household and commitments notes, with a plain reason", async () => {
    const { notebook, run } = await fixture();
    await notebook.write(HOUSEHOLD, "# Household\n- Mara grows beans.\n", "fixture", "test");
    await notebook.write(COMMITMENTS, "# My commitments\n", "fixture", "test");

    const refusals = [
      await run("write_note", { path: HOUSEHOLD, text: "Changed.", why: "Try." }),
      await run("edit_note", { path: HOUSEHOLD, find: "Mara", replace: "Tomas", why: "Try." }),
      await run("append_note", { path: COMMITMENTS, text: "Mine.", why: "Try." }),
      await run("trash_note", { path: COMMITMENTS, why: "Try." }),
    ];
    for (const receipt of refusals) {
      expect(receipt.ok).toBe(false);
      expect(receipt.refused?.code).toBe("protected");
    }
    expect(refusals[0]?.refused?.reason).toBe("Your summoner writes your household part.");
    expect(refusals[2]?.refused?.reason).toBe("Your commitments change through propose_commitment.");
    expect(notebook.read(HOUSEHOLD)).toBe("# Household\n- Mara grows beans.\n");
    expect(notebook.read(COMMITMENTS)).toBe("# My commitments\n");
  });

  it("refuses the same notes under another spelling of the path", async () => {
    const { notebook, run } = await fixture();
    await notebook.write(HOUSEHOLD, "# Household\n", "fixture", "test");
    expect(await run("write_note", { path: "./SELF//Household.md", text: "x", why: "Try." })).toMatchObject({
      refused: { code: "protected" },
    });
  });

  it("still lets the Lar read them, and write its other notes", async () => {
    const { notebook, run } = await fixture();
    await notebook.write(HOUSEHOLD, "# Household\n", "fixture", "test");
    expect(await run("read_note", { path: HOUSEHOLD })).toMatchObject({ ok: true });
    expect(await run("write_note", { path: "self/character.md", text: "Quiet.\n", why: "Mine." })).toMatchObject({
      ok: true,
    });
  });
});
