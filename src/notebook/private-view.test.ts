import { describe, expect, it } from "vitest";
import type { Notebook, NotebookEntry } from "../contracts.js";
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
