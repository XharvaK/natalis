// The notebook's list() shows each file's first line. It caches that line by path, size and modification time, so a
// file that has not changed is not read again. This file counts the reads, so the cache is seen working.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notebook } from "../contracts.js";
import { openNotebook } from "./git-notebook.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;
let nb: Notebook;

/** How many times the notebook read this file since the last reset. */
function readsOf(file: string): number {
  const wanted = path.join(dir, ...file.split("/"));
  return vi.mocked(readFileSync).mock.calls.filter((call) => path.resolve(String(call[0])) === path.resolve(wanted)).length;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "natalis-firstline-"));
  nb = await openNotebook(path.join(dir, "entity"));
  dir = path.join(dir, "entity");
});

afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5 });
});

describe("the first-line cache in list()", () => {
  it("does not read an unchanged file again", async () => {
    await nb.write("people/a.md", "Ana\n", "Note on Ana", "body");
    expect(nb.list("people")[0]?.firstLine).toBe("Ana");

    vi.mocked(readFileSync).mockClear();
    expect(nb.list("people")[0]?.firstLine).toBe("Ana");
    expect(readsOf("people/a.md")).toBe(0);
  });

  it("reads a changed file once, and shows its new first line", async () => {
    await nb.write("people/a.md", "Ana\n", "Note on Ana", "body");
    expect(nb.list("people")[0]?.firstLine).toBe("Ana");

    await nb.write("people/a.md", "Bea is the new name here\n", "Rename the note", "body");
    vi.mocked(readFileSync).mockClear();
    expect(nb.list("people")[0]?.firstLine).toBe("Bea is the new name here");
    expect(readsOf("people/a.md")).toBe(1);

    vi.mocked(readFileSync).mockClear();
    expect(nb.list("people")[0]?.firstLine).toBe("Bea is the new name here");
    expect(readsOf("people/a.md")).toBe(0);
  });

  it("reads the file again when one that went away comes back with new text", async () => {
    await nb.write("people/a.md", "Ana\n", "Note on Ana", "body");
    expect(nb.list("people")[0]?.firstLine).toBe("Ana");
    await nb.remove("people/a.md", "Move the note away", "body");
    expect(nb.list("people")).toEqual([]);

    await nb.write("people/a.md", "Cem, a new note\n", "A new note", "body");
    expect(nb.list("people")[0]?.firstLine).toBe("Cem, a new note");
  });
});
