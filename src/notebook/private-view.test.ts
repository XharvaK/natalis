import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Notebook, NotebookEntry } from "../contracts.js";
import { openNotebook } from "./git-notebook.js";
import { withoutPrivate } from "./private-view.js";

function fake(): Notebook {
  const files: Record<string, string> = { "self/a.md": "open words", "private/b.md": "close words" };
  const entry = (path: string): NotebookEntry => ({ path, bytes: 1, modifiedMs: 0, firstLine: files[path]! });
  return {
    root: "/nb",
    read: (path) => files[path] ?? null,
    write: async () => {},
    edit: async () => {},
    append: async () => {},
    remove: async () => {},
    list: () => Object.keys(files).map(entry),
    search: (text) => Object.keys(files).filter((p) => files[p]!.includes(text)).map((path) => ({ path, line: 1, text: files[path]! })),
  };
}

describe("withoutPrivate", () => {
  it("leaves private/ out of list, search and read", () => {
    const view = withoutPrivate(fake());
    expect(view.list().map((e) => e.path)).toEqual(["self/a.md"]);
    expect(view.search("words").map((h) => h.path)).toEqual(["self/a.md"]);
    expect(view.read("private/b.md")).toBeNull();
    expect(view.read("self/a.md")).toBe("open words");
  });
});

const hiddenPaths = ["private/diary.md", "./private/diary.md", ".//private/diary.md", "self/../private/a.md", "private"];

describe("withoutPrivate over a real notebook (B-1)", () => {
  let dir: string;
  let nb: Notebook;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "natalis-private-view-"));
    nb = await openNotebook(path.join(dir, "entity"));
    await nb.write("private/diary.md", "Dear diary, close words.\n", "Keep a diary", "body");
    await nb.write("notes/privateer.md", "open words\n", "Keep a note on the privateer", "body");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("reads null for a private path however it is spelled", () => {
    const view = withoutPrivate(nb);
    for (const p of hiddenPaths) expect(view.read(p)).toBeNull();
  });

  it("gives no line times for a private path however it is spelled", () => {
    const view = withoutPrivate(nb);
    if (view.lineTimes) {
      for (const p of hiddenPaths) expect(view.lineTimes(p)).toBeNull();
    }
  });

  it("still reads an open note spelled with ./", () => {
    const view = withoutPrivate(nb);
    expect(view.read("notes/privateer.md")).toContain("open words");
    expect(view.read("./notes/privateer.md")).toContain("open words");
  });

  it("lists no path that starts with private", () => {
    const view = withoutPrivate(nb);
    const paths = view.list().map((entry) => entry.path);
    expect(paths.some((p) => p.startsWith("private"))).toBe(false);
  });

  it("refuses to rename a private note out, as if it were not there", async () => {
    const view = withoutPrivate(nb);
    let error: unknown;
    try {
      await view.rename("private/diary.md", "notes/leak.md", "Move it out", "body");
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      name: "NotebookError",
      kind: "not_found",
      message: "private/diary.md does not exist.",
    });
    expect(nb.read("private/diary.md")).toContain("Dear diary");
    expect(nb.read("notes/leak.md")).toBeNull();
  });

  it("still lets a thread keep an open note by moving it into private/", async () => {
    const view = withoutPrivate(nb);

    await view.rename("notes/privateer.md", "private/kept.md", "Keep it close", "body");

    expect(nb.read("notes/privateer.md")).toBeNull();
    expect(nb.read("private/kept.md")).toContain("open words");
  });
});
