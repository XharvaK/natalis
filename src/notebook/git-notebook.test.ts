import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotebookError } from "../contracts.js";
import type { Notebook } from "../contracts.js";
import { openNotebook } from "./git-notebook.js";

let dir: string;
let nb: Notebook;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** Subjects of every commit, oldest first. */
function subjects(): string[] {
  return git(["log", "--reverse", "--format=%s"]).split("\n").filter((line) => line.length > 0);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "natalis-notebook-"));
  nb = await openNotebook(path.join(dir, "entity"));
  dir = path.join(dir, "entity");
});

afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5 });
});

describe("openNotebook", () => {
  it("creates the folder, a git repository on branch main, and LF attributes", () => {
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(git(["symbolic-ref", "--short", "HEAD"]).trim()).toBe("main");
    expect(readFileSync(path.join(dir, ".gitattributes"), "utf8")).toBe("* text=auto eol=lf\n");
    expect(subjects()).toEqual(["Open the notebook: text is kept with LF line endings"]);
  });

  it("opening an existing notebook again changes nothing", async () => {
    await openNotebook(dir);
    expect(subjects()).toHaveLength(1);
  });

  it("creates a folder that does not exist yet and works from there", async () => {
    const deep = path.join(path.dirname(dir), "a", "b", "c");
    const other = await openNotebook(deep);
    await other.write("x.md", "hi\n", "First line", "body");
    expect(readFileSync(path.join(deep, "x.md"), "utf8")).toBe("hi\n");
  });
});

describe("write", () => {
  it("commits with the author and the reason visible in git log", async () => {
    await nb.write("people/ana.md", "Ana likes tea.\n", "Remember what Ana likes", "thread:dm:owner");
    expect(nb.read("people/ana.md")).toBe("Ana likes tea.\n");
    const log = git(["log", "-1", "--format=%an|%ae|%s"]).trim();
    expect(log).toBe("thread:dm:owner|entity@natalis.invalid|Remember what Ana likes");
  });

  it("puts a long reason in the body and keeps the subject within 72 characters", async () => {
    const reason = "Record the whole story of the rainy afternoon when the bus was late and everyone waited";
    await nb.write("diary/day.md", "It rained.\n", reason, "body");
    const subject = git(["log", "-1", "--format=%s"]).trim();
    const full = git(["log", "-1", "--format=%B"]);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("...")).toBe(true);
    expect(full).toContain(reason);
  });

  it("a write with the same content makes no commit", async () => {
    await nb.write("self/name.md", "Name: Sol\n", "Set my name", "body");
    const before = subjects().length;
    await nb.write("self/name.md", "Name: Sol\n", "Set my name again", "body");
    expect(subjects()).toHaveLength(before);
  });

  it("refuses an empty reason or author", async () => {
    await expect(nb.write("a.md", "x", "   ", "body")).rejects.toThrow(/reason/);
    await expect(nb.write("a.md", "x", "why", "  ")).rejects.toThrow(/author/);
  });

  it("creates parent folders as needed", async () => {
    await nb.write("deep/er/still/note.md", "ok\n", "Nested note", "body");
    expect(nb.read("deep/er/still/note.md")).toBe("ok\n");
  });
});

describe("edit", () => {
  beforeEach(async () => {
    await nb.write("memory/facts.md", "alpha\nbeta\ngamma\n", "Seed facts", "body");
  });

  it("replaces exactly one occurrence and commits", async () => {
    await nb.edit("memory/facts.md", "beta", "BETA", "Correct the second fact", "body");
    expect(nb.read("memory/facts.md")).toBe("alpha\nBETA\ngamma\n");
    expect(subjects().at(-1)).toBe("Correct the second fact");
  });

  it("not_found when the text is absent, and changes nothing", async () => {
    const before = subjects().length;
    const err = await nb.edit("memory/facts.md", "delta", "x", "Try", "body").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotebookError);
    expect((err as NotebookError).kind).toBe("not_found");
    expect(subjects()).toHaveLength(before);
  });

  it("ambiguous when the text occurs twice, and changes nothing", async () => {
    await nb.write("memory/dup.md", "same\nsame\n", "Seed duplicates", "body");
    const before = subjects().length;
    const err = await nb.edit("memory/dup.md", "same", "other", "Try", "body").catch((e: unknown) => e);
    expect((err as NotebookError).kind).toBe("ambiguous");
    expect(nb.read("memory/dup.md")).toBe("same\nsame\n");
    expect(subjects()).toHaveLength(before);
  });

  it("not_found for a file that does not exist", async () => {
    const err = await nb.edit("memory/none.md", "a", "b", "Try", "body").catch((e: unknown) => e);
    expect((err as NotebookError).kind).toBe("not_found");
  });
});

describe("append", () => {
  it("adds a newline separator when the file does not end in one", async () => {
    await nb.write("diary/log.md", "first", "Start the log", "body");
    await nb.append("diary/log.md", "second\n", "Add a second line", "body");
    expect(nb.read("diary/log.md")).toBe("first\nsecond\n");
  });

  it("adds no extra newline when the file already ends in one", async () => {
    await nb.write("diary/log.md", "first\n", "Start the log", "body");
    await nb.append("diary/log.md", "second", "Add a line", "body");
    expect(nb.read("diary/log.md")).toBe("first\nsecond");
  });

  it("creates a missing file", async () => {
    await nb.append("inbox/new.md", "hello", "Start an inbox note", "body");
    expect(nb.read("inbox/new.md")).toBe("hello");
  });
});

describe("remove", () => {
  it("moves the file to trash/<date>/ with its history, and never deletes", async () => {
    await nb.write("projects/plan.md", "Step one\n", "Draft the plan", "body");
    await nb.edit("projects/plan.md", "one", "two", "Revise the plan", "body");
    await nb.remove("projects/plan.md", "The plan is finished elsewhere", "body");

    expect(nb.read("projects/plan.md")).toBeNull();
    const trashed = `trash/${today()}/projects/plan.md`;
    expect(nb.read(trashed)).toBe("Step two\n");
    // The subject is shortened to fit 72 characters; the full reason, with the trash path, is in the body.
    const message = git(["log", "-1", "--format=%B"]);
    expect(message).toContain("The plan is finished elsewhere");
    expect(message).toContain(`(moved to ${trashed})`);

    const history = git(["log", "--follow", "--format=%s", "--", trashed]);
    expect(history).toContain("Draft the plan");
    expect(history).toContain("Revise the plan");
  });

  it("a second removal of the same name the same day gets a numbered trash name", async () => {
    await nb.write("people/x.md", "one\n", "Make the note", "body");
    await nb.remove("people/x.md", "Drop it", "body");
    await nb.write("people/x.md", "two\n", "Make it again", "body");
    await nb.remove("people/x.md", "Drop it again", "body");
    expect(nb.read(`trash/${today()}/people/x.md`)).toBe("one\n");
    expect(nb.read(`trash/${today()}/people/x-2.md`)).toBe("two\n");
  });

  it("refuses to remove inside trash/", async () => {
    await nb.write("people/y.md", "bye\n", "Make the note", "body");
    await nb.remove("people/y.md", "Drop it", "body");
    const err = await nb.remove(`trash/${today()}/people/y.md`, "Again", "body").catch((e: unknown) => e);
    expect((err as NotebookError).kind).toBe("bad_path");
  });

  it("not_found for a file that is not there", async () => {
    const err = await nb.remove("people/ghost.md", "Nope", "body").catch((e: unknown) => e);
    expect((err as NotebookError).kind).toBe("not_found");
  });
});

describe("path rules", () => {
  const bad = [
    "",
    ".",
    "/etc/passwd",
    "\\\\server\\share\\x",
    "C:/Windows/x",
    "../escape.md",
    "notes/../../escape.md",
    ".git/config",
    ".git",
    ".GIT/x",
    "notes/.git/x",
    "nul\u0000byte.md",
    "back\\slash.md",
    "trailing./name",
  ];

  it.each(bad)("refuses %j as bad_path on write, read and remove", async (p) => {
    const write = await nb.write(p, "x", "Try it", "body").catch((e: unknown) => e);
    expect(write).toBeInstanceOf(NotebookError);
    expect((write as NotebookError).kind).toBe("bad_path");
    expect(() => nb.read(p)).toThrow(NotebookError);
    const remove = await nb.remove(p, "Try it", "body").catch((e: unknown) => e);
    expect((remove as NotebookError).kind).toBe("bad_path");
  });

  it("normalizes ./ and doubled slashes to one path", async () => {
    await nb.write("./notes//a.md", "x\n", "Normalize", "body");
    expect(nb.read("notes/a.md")).toBe("x\n");
  });
});

describe("concurrent writes", () => {
  it("all land as commits, in call order", async () => {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(nb.write(`batch/item-${i}.md`, `item ${i}\n`, `step ${i}`, "body"));
    }
    await Promise.all(writes);
    const all = subjects();
    expect(all.slice(1)).toEqual(Array.from({ length: 20 }, (_, i) => `step ${i}`));
    expect(nb.list("batch")).toHaveLength(20);
  });
});

describe("list and firstLine", () => {
  it("lists files recursively, sorted, without .git, with bytes and first non-empty line", async () => {
    await nb.write("people/b.md", "\n\n  Ben is a baker  \nmore\n", "Note on Ben", "body");
    await nb.write("people/a.md", "Ana\n", "Note on Ana", "body");
    await nb.write("diary/2026.md", "x".repeat(150) + "\n", "A long first line", "body");

    const entries = nb.list();
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual([".gitattributes", "diary/2026.md", "people/a.md", "people/b.md"]);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);

    const ben = entries.find((e) => e.path === "people/b.md");
    expect(ben?.firstLine).toBe("Ben is a baker");
    expect(ben?.bytes).toBe(Buffer.byteLength("\n\n  Ben is a baker  \nmore\n"));
    expect(typeof ben?.modifiedMs).toBe("number");

    expect(entries.find((e) => e.path === "diary/2026.md")?.firstLine).toHaveLength(120);
  });

  it("lists one folder when asked", async () => {
    await nb.write("people/a.md", "Ana\n", "Note on Ana", "body");
    await nb.write("diary/d.md", "Day\n", "A day", "body");
    expect(nb.list("people").map((e) => e.path)).toEqual(["people/a.md"]);
  });

  it("an empty or missing folder lists as nothing", () => {
    expect(nb.list("nowhere")).toEqual([]);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await nb.write("people/ana.md", "Ana likes TEA.\nShe walks at dawn.\n", "Note on Ana", "body");
    await nb.write("places/cafe.md", "  The tea house is quiet.   \n", "Note on the cafe", "body");
  });

  it("is case-insensitive and reports path, 1-based line and trimmed text", () => {
    const hits = nb.search("tea");
    expect(hits).toEqual([
      { path: "people/ana.md", line: 1, text: "Ana likes TEA." },
      { path: "places/cafe.md", line: 1, text: "The tea house is quiet." },
    ]);
  });

  it("excludes trash/ and .git", async () => {
    await nb.remove("people/ana.md", "Moved away", "body");
    const hits = nb.search("tea");
    expect(hits.map((h) => h.path)).toEqual(["places/cafe.md"]);
    // git writes "bare = false" into .git/config; the scan must never reach it.
    expect(nb.search("bare = false")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(nb.search("e", 1)).toHaveLength(1);
  });

  it("an empty query finds nothing", () => {
    expect(nb.search("")).toEqual([]);
  });

  it("trims long lines to 200 characters", async () => {
    await nb.write("world/long.md", "needle " + "y".repeat(400) + "\n", "A long line", "body");
    const hit = nb.search("needle").find((h) => h.path === "world/long.md");
    expect(hit?.text).toHaveLength(200);
  });
});
