import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../contracts.js";
import { openLinks, type LinkRelation, type LinkStore } from "../river/links.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { notebookTools, type NotebookToolOptions } from "./notebook-tools.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const PLANS = "# Plans\n\n## Spring\n\nPlant beans.\n";
const MARA = "# Mara\n\nMara keeps the quay.\n";

let dir: string;
let links: LinkStore;
let notebook: MemoryNotebook;
let context: ToolContext;
let seq: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "natalis-notebook-links-"));
  links = openLinks(join(dir, "river.db"));
  notebook = new MemoryNotebook({ nowMs: () => NOW });
  await notebook.write("self/plans.md", PLANS, "fixture", "test");
  await notebook.write("people/mara.md", MARA, "fixture", "test");
  context = {
    thread: "dm:owner",
    turnId: "t-notebook-links",
    nowMs: NOW,
    river: new MemoryRiver({ nowMs: () => NOW }),
    notebook,
  };
  seq = 1;
});

afterEach(() => {
  links.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tool(options: NotebookToolOptions, name: string): Tool {
  const found = notebookTools(options).find((candidate) => candidate.spec.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

function run(options: NotebookToolOptions, name: string, args: Record<string, unknown>): Promise<Receipt> {
  return tool(options, name).run(args, context);
}

function addLink(
  from: string,
  to: string,
  atMs: number,
  options: { private?: boolean; relation?: LinkRelation } = {},
): void {
  links.record({
    thread: "dm:owner",
    from,
    to,
    relation: options.relation ?? "supports",
    reason: "They belong together.",
    private: options.private ?? false,
    seq: seq++,
    atMs,
    author: "self",
  });
}

describe("read_note shows the note's links", () => {
  it("says when another note supersedes it, and gives the link as data", async () => {
    addLink("notes/new-plan.md", "self/plans.md", NOW, {
      relation: "supersedes",
    });

    const receipt = await run({ links }, "read_note", { path: "self/plans.md" });

    expect(receipt).toMatchObject({
      ok: true,
      summary: "Read self/plans.md. Linked: notes/new-plan.md supersedes it.",
      data: {
        links: [
          {
            relation: "supersedes",
            from: "notes/new-plan.md",
            to: "self/plans.md",
            reason: "They belong together.",
          },
        ],
      },
    });
  });

  it("reads links on both sides, newest first, in whole notes and sections alike", async () => {
    addLink("self/plans.md", "people/mara.md", NOW - 1_000);
    addLink("notes/new-plan.md", "self/plans.md", NOW, { relation: "supersedes" });

    const whole = await run({ links }, "read_note", { path: "self/plans.md" });
    expect(whole.summary).toBe(
      "Read self/plans.md. Linked: notes/new-plan.md supersedes it; it supports people/mara.md.",
    );
    expect(whole.data?.["links"]).toHaveLength(2);

    const section = await run({ links }, "read_note", { path: "self/plans.md", section: "## Spring" });
    expect(section.summary).toBe(
      "Read self/plans.md, section ## Spring. Linked: notes/new-plan.md supersedes it; it supports people/mara.md.",
    );
  });

  it("hides a private link unless the thread sees private/", async () => {
    addLink("notes/secret-plan.md", "self/plans.md", NOW, { private: true, relation: "supersedes" });

    const absent = await run({ links }, "read_note", { path: "self/plans.md" });
    expect(absent.summary).toBe("Read self/plans.md.");
    expect(absent.data?.["links"]).toBeUndefined();

    const closed = await run({ links, privateView: () => false }, "read_note", { path: "self/plans.md" });
    expect(closed.summary).toBe("Read self/plans.md.");
    expect(closed.data?.["links"]).toBeUndefined();

    let seen = "";
    const open = await run(
      {
        links,
        privateView: (thread) => {
          seen = thread;
          return true;
        },
      },
      "read_note",
      { path: "self/plans.md" },
    );
    expect(open.summary).toBe("Read self/plans.md. Linked: notes/secret-plan.md supersedes it.");
    expect(seen).toBe("dm:owner");
  });

  it("reads exactly as before when the note has no links or when no link store is given", async () => {
    const none = await run({ links }, "read_note", { path: "self/plans.md" });
    expect(none).toEqual({
      ok: true,
      summary: "Read self/plans.md.",
      data: { path: "self/plans.md", text: PLANS, chars: PLANS.length, truncated: false },
    });

    addLink("notes/new-plan.md", "self/plans.md", NOW, { relation: "supersedes" });
    const noStore = await run({}, "read_note", { path: "self/plans.md" });
    expect(noStore).toEqual({
      ok: true,
      summary: "Read self/plans.md.",
      data: { path: "self/plans.md", text: PLANS, chars: PLANS.length, truncated: false },
    });
  });
});

describe("rename_note", () => {
  it("moves the note, keeps its text, and repoints the links that named it", async () => {
    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");
    addLink("notes/old.md", "people/mara.md", NOW);
    addLink("people/mara.md", "notes/old.md", NOW + 1_000);

    const receipt = await run({ links }, "rename_note", {
      path: "notes/old.md",
      to: "notes/new.md",
      why: "A clearer name.",
    });

    expect(receipt).toEqual({
      ok: true,
      summary: "Renamed notes/old.md to notes/new.md. Repointed 2 link(s).",
      data: { path: "notes/old.md", to: "notes/new.md", linksRepointed: 2, linksDropped: 0 },
    });
    expect(notebook.read("notes/old.md")).toBeNull();
    expect(notebook.read("notes/new.md")).toBe("Old words.\n");
    expect(notebook.log.at(-1)).toMatchObject({
      op: "rename",
      path: "notes/old.md",
      to: "notes/new.md",
      reason: "A clearer name.",
    });
    expect(links.forNote("notes/new.md", false)).toHaveLength(2);
    expect(links.forNote("notes/old.md", false)).toHaveLength(0);
  });

  it("renames plainly when no link store is given", async () => {
    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");

    const receipt = await run({}, "rename_note", {
      path: "notes/old.md",
      to: "notes/new.md",
      why: "A clearer name.",
    });

    expect(receipt).toEqual({
      ok: true,
      summary: "Renamed notes/old.md to notes/new.md.",
      data: { path: "notes/old.md", to: "notes/new.md", linksRepointed: 0, linksDropped: 0 },
    });
  });

  it("says when a rename dropped a link instead of repointing it", async () => {
    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");
    addLink("notes/old.md", "people/mara.md", NOW);
    addLink("notes/new.md", "people/mara.md", NOW + 1_000);

    const receipt = await run({ links }, "rename_note", {
      path: "notes/old.md",
      to: "notes/new.md",
      why: "A clearer name.",
    });

    expect(receipt).toMatchObject({
      ok: true,
      summary: "Renamed notes/old.md to notes/new.md. Dropped 1 link(s).",
      data: { linksRepointed: 0, linksDropped: 1 },
    });
  });

  it("refuses a protected path on either side", async () => {
    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");

    expect(
      await run({ links }, "rename_note", { path: "self/household.md", to: "notes/household.md", why: "Move it." }),
    ).toMatchObject({ ok: false, refused: { code: "protected" } });
    expect(
      await run({ links }, "rename_note", { path: "notes/old.md", to: "self/constitution.md", why: "Move it." }),
    ).toMatchObject({ ok: false, refused: { code: "protected" } });
    expect(notebook.log.some((entry) => entry.op === "rename")).toBe(false);
  });

  it("keeps the character and life notes where the body reads them", async () => {
    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");
    await notebook.write("self/life.md", "# Life\n", "fixture", "test");

    expect(
      await run({ links }, "rename_note", { path: "self/life.md", to: "notes/life.md", why: "Move it." }),
    ).toMatchObject({ ok: false, refused: { code: "fixed_place" } });
    expect(
      await run({ links }, "rename_note", { path: "notes/old.md", to: "SELF/Character.md", why: "Move it." }),
    ).toMatchObject({ ok: false, refused: { code: "fixed_place" } });
    expect(notebook.log.some((entry) => entry.op === "rename")).toBe(false);
  });

  it("refuses a path in trash/ on either side", async () => {
    const out = await run({ links }, "rename_note", { path: "trash/kept.md", to: "notes/kept.md", why: "Bring it back." });
    expect(out).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(out.summary).toBe("Use trash_note to move a note to the trash.");

    await notebook.write("notes/old.md", "Old words.\n", "fixture", "test");
    const into = await run({ links }, "rename_note", { path: "notes/old.md", to: "trash/old.md", why: "Retire it." });
    expect(into).toMatchObject({ ok: false, refused: { code: "bad_arguments" } });
    expect(into.summary).toBe("Use trash_note to move a note to the trash.");
    expect(notebook.read("notes/old.md")).toBe("Old words.\n");
  });

  it("turns a notebook error into a plain refusal", async () => {
    const receipt = await run({ links }, "rename_note", {
      path: "notes/missing.md",
      to: "notes/new.md",
      why: "A clearer name.",
    });

    expect(receipt).toMatchObject({ ok: false, summary: "There is no note at that path.", refused: { code: "not_found" } });
  });
});
