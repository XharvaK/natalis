import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runForget } from "../bin/commands/forget.js";
import type { Tool, ToolContext } from "../contracts.js";
import { openNotebook } from "../notebook/index.js";
import { derivedStores, derivedTableNames } from "../river/derived.js";
import { LINKS_TABLE, openLinks, type LinkStore } from "../river/links.js";
import { openRiver, type SqliteRiver } from "../river/sqlite-river.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { notebookTools } from "../tools/notebook-tools.js";
import { linksTools } from "../tools/links-tools.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

let root: string;
let dir: string;
let river: SqliteRiver;
let links: LinkStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-links-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  river = openRiver(join(dir, "river.db"));
  links = openLinks(join(dir, "river.db"));
});

afterEach(() => {
  links.close();
  river.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function context(notebook: MemoryNotebook, thread = "self"): ToolContext {
  return { thread, turnId: "t-links", nowMs: NOW, river, notebook };
}

function linkTool(): Tool {
  const tool = linksTools(links).find((candidate) => candidate.spec.name === "link_notes");
  if (tool === undefined) throw new Error("no link_notes tool");
  return tool;
}

async function notebookWithNotes(): Promise<MemoryNotebook> {
  const notebook = new MemoryNotebook({ nowMs: () => NOW });
  await notebook.write("people/mara.md", "Mara keeps the quay.\n", "fixture", "test");
  await notebook.write("places/quay.md", "The quay is quiet at dawn.\n", "fixture", "test");
  await notebook.write("places/old-map.md", "The old map is out of date.\n", "fixture", "test");
  return notebook;
}

type RawLink = {
  id: number;
  at_ms: number;
  thread: string;
  from_note: string | null;
  to_note: string | null;
  relation: string | null;
  reason: string | null;
  seq: number;
  author: string;
  forgotten: number;
  forgotten_why: string | null;
};

function linkRows(): RawLink[] {
  const db = new DatabaseSync(join(dir, "river.db"), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${LINKS_TABLE} ORDER BY id`).all() as unknown as RawLink[];
  } finally {
    db.close();
  }
}

function activeLinks(): RawLink[] {
  return linkRows().filter((row) => row.forgotten === 0);
}

describe("U10: links between notes", () => {
  it("link stores note names, relation, her reason and seq", async () => {
    const notebook = await notebookWithNotes();
    river.append({ thread: "self", kind: "event", source: "outside", text: "Mara spoke about the quay." });
    const seq = river.lastSeq();

    const receipt = await linkTool().run(
      { from: "people/mara.md", to: "places/quay.md", relation: "supports", why: "Mara's words fit the quay note." },
      context(notebook),
    );

    expect(receipt.ok).toBe(true);
    const rows = linkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_note: "people/mara.md",
      to_note: "places/quay.md",
      relation: "supports",
      reason: "Mara's words fit the quay note.",
      seq,
      author: "self",
      forgotten: 0,
    });

    // A note that is not there and a relation outside the four are refused, and nothing else is written.
    const missing = await linkTool().run(
      { from: "people/nobody.md", to: "places/quay.md", relation: "supports", why: "A link to nothing." },
      context(notebook),
    );
    expect(missing.ok).toBe(false);
    expect(missing.refused?.code).toBe("not_found");
    const badRelation = await linkTool().run(
      { from: "people/mara.md", to: "places/quay.md", relation: "replaces", why: "Not one of the four." },
      context(notebook),
    );
    expect(badRelation.ok).toBe(false);
    expect(badRelation.refused?.code).toBe("bad_arguments");
    expect(linkRows()).toHaveLength(1);

    // The U8 cascade and the memory rollback read one registered list; the links table is on both.
    expect(derivedStores().some((store) => store.tables.includes(LINKS_TABLE))).toBe(true);
    expect(derivedTableNames()).toContain(LINKS_TABLE);
  });

  it("only she can set supersedes", async () => {
    const notebook = await notebookWithNotes();
    river.append({ thread: "self", kind: "event", source: "outside", text: "Mara spoke about the quay." });

    const receipt = await linkTool().run(
      { from: "people/mara.md", to: "places/quay.md", relation: "supersedes", why: "Mara's note replaces the old map." },
      context(notebook),
    );
    expect(receipt.ok).toBe(true);
    expect(linkRows()).toHaveLength(1);
    expect(linkRows()[0]).toMatchObject({ relation: "supersedes", author: "self" });

    // The body never writes a link, and a supersedes one in particular is hers alone.
    expect(() =>
      links.record({
        thread: "body",
        from: "places/quay.md",
        to: "places/old-map.md",
        relation: "supersedes",
        reason: "A body-written replacement.",
        seq: 1,
        atMs: NOW,
        author: "body",
      }),
    ).toThrow(/only she/i);
    expect(linkRows()).toHaveLength(1);
  });

  it("links to a note moved to trash/ are dropped", async () => {
    const notebook = await notebookWithNotes();
    river.append({ thread: "self", kind: "event", source: "outside", text: "Mara spoke about the quay." });
    const from = await linkTool().run(
      { from: "people/mara.md", to: "places/quay.md", relation: "supports", why: "One." },
      context(notebook),
    );
    const to = await linkTool().run(
      { from: "places/old-map.md", to: "people/mara.md", relation: "elaborates", why: "Two." },
      context(notebook),
    );
    const other = await linkTool().run(
      { from: "places/quay.md", to: "places/old-map.md", relation: "contradicts", why: "Three." },
      context(notebook),
    );
    expect([from.ok, to.ok, other.ok]).toEqual([true, true, true]);

    const trash = notebookTools({ links }).find((tool) => tool.spec.name === "trash_note");
    if (trash === undefined) throw new Error("no trash_note tool");
    const receipt = await trash.run({ path: "people/mara.md", why: "The person asked me to let the note go." }, context(notebook));
    expect(receipt.ok).toBe(true);
    expect(receipt.data?.["linksDropped"]).toBe(2);
    expect(notebook.read("people/mara.md")).toBeNull();

    // Both directions go: no active link names the trashed note; the link between the other two notes stays.
    const active = activeLinks();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      from_note: "places/quay.md",
      to_note: "places/old-map.md",
      relation: "contradicts",
    });
    const dropped = linkRows().filter((row) => row.forgotten === 1);
    expect(dropped).toHaveLength(2);
    expect(dropped.every((row) => row.forgotten_why === "trash")).toBe(true);
  });

  it("a forget of the link's river row drops the link whole", async () => {
    const notebook = await notebookWithNotes();
    river.append({ thread: "self", kind: "event", source: "outside", text: "Mara spoke about the quay." });
    const seq = river.lastSeq();
    const created = await linkTool().run(
      { from: "people/mara.md", to: "places/quay.md", relation: "supports", why: "A link with one source." },
      context(notebook),
    );
    expect(created.ok).toBe(true);

    river.forget({ seqs: [seq] }, "self", "The source row is gone.");

    const rows = linkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_note: null,
      to_note: null,
      relation: null,
      reason: null,
      forgotten: 1,
      forgotten_why: "source",
    });
  });

  it("a forget rename repairs or drops links", async () => {
    const forgetDir = join(root, "mara-lar");
    mkdirSync(forgetDir, { recursive: true });
    writeFileSync(join(forgetDir, "entity.json"), "{}", "utf8");

    const source = openRiver(join(forgetDir, "river.db"));
    source.append({ thread: "self", kind: "event", source: "outside", text: "Mara Vale came to the quay." });
    source.append({ thread: "self", kind: "event", source: "outside", text: "The tide turned at dusk." });
    const keptSeq = source.lastSeq();
    source.close();

    const notebook = await openNotebook(join(forgetDir, "notebook"));
    await notebook.write("people/mara.md", "She keeps the quay.\n", "fixture", "body");
    await notebook.write("places/quay.md", "The quay is quiet at dawn.\n", "fixture", "body");
    await notebook.write("places/old-map.md", "An old map of the vale.\n", "fixture", "body");

    const forgetLinks = openLinks(join(forgetDir, "river.db"));
    try {
      const base = { thread: "self", seq: keptSeq, atMs: NOW, author: "self" as const };
      // This one survives the words (only one of them is in its text) and must be repaired to the new note name.
      forgetLinks.record({
        ...base,
        from: "people/mara.md",
        to: "places/quay.md",
        relation: "supports",
        reason: "She keeps the quay.",
      });
      // This one holds both words, so the text forget drops it whole before the rename.
      forgetLinks.record({
        ...base,
        from: "places/quay.md",
        to: "people/mara.md",
        relation: "elaborates",
        reason: "Mara Vale left the quay.",
      });
      // This one does not name the forgotten note at all and is untouched.
      forgetLinks.record({
        ...base,
        from: "places/old-map.md",
        to: "places/quay.md",
        relation: "contradicts",
        reason: "The map is out of date.",
      });
    } finally {
      forgetLinks.close();
    }

    const counts = await runForget({ dir: forgetDir, query: "mara vale", reason: "The owner asked to forget the name." });
    expect(counts.renamed).toBe(1);
    expect(counts.linkRows).toBe(1);

    expect(notebook.read("people/mara.md")).toBeNull();
    expect(notebook.read("people/forgotten.md")).toBe("She keeps the quay.\n");

    const db = new DatabaseSync(join(forgetDir, "river.db"), { readOnly: true });
    try {
      const rows = db.prepare(`SELECT * FROM ${LINKS_TABLE} ORDER BY id`).all() as unknown as RawLink[];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        from_note: "people/forgotten.md",
        to_note: "places/quay.md",
        relation: "supports",
        reason: "She keeps the quay.",
        forgotten: 0,
      });
      expect(rows[1]).toMatchObject({ from_note: null, to_note: null, reason: null, forgotten: 1, forgotten_why: "text" });
      expect(rows[2]).toMatchObject({
        from_note: "places/old-map.md",
        to_note: "places/quay.md",
        relation: "contradicts",
        forgotten: 0,
      });
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    } finally {
      db.close();
    }
  });
});
