import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNotebook } from "../../notebook/index.js";
import { openRiver } from "../../river/index.js";
import { forgetCommand, parseForgetArgs, runForget } from "./forget.js";

// Every name and line here is invented.
const REASON = "Owner asked to forget the lantern note";

let root: string;
let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "natalis-forgetcmd-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");

  const river = openRiver(join(dir, "river.db"));
  river.append({ thread: "cli:owner", kind: "event", source: "owner", text: "Lantern Yard is by the water." });
  river.append({ thread: "cli:owner", kind: "event", source: "owner", text: "Hello there." });
  river.append({ thread: "cli:owner", kind: "say", source: "self", text: "Lantern yard again, then." });
  river.close();

  const notebook = await openNotebook(join(dir, "notebook"));
  await notebook.write("people/mara.md", "Mara lives on Lantern Yard\nShe likes tea\nlantern is near yard\n", "Note on Mara", "body");
  await notebook.write("places/quay.md", "Lantern yard is quiet\n", "Note on the quay", "body");
  await notebook.write("private/old.md", "Lantern Yard, an old note\n", "An old note", "body");
  await notebook.remove("private/old.md", "Move an old note away", "body");

  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The river row numbers of every row with this text, read back from the river. */
function seqsOf(text: string): number[] {
  const river = openRiver(join(dir, "river.db"));
  try {
    return river.read({ limit: 1000 }).filter((row) => row.text === text).map((row) => row.seq);
  } finally {
    river.close();
  }
}

function gitLog(): string {
  return execFileSync("git", ["log", "--format=%an|%s"], { cwd: join(dir, "notebook"), encoding: "utf8" });
}

describe("reading the forget flags", () => {
  it("needs a folder, a reason, and exactly one of --query or --seqs", () => {
    expect(parseForgetArgs(["--query", "x", "--reason", "r"])).toMatchObject({ ok: false, error: /--dir is missing/ });
    expect(parseForgetArgs(["--dir", dir, "--query", "x"])).toMatchObject({ ok: false, error: /--reason is missing/ });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r"])).toMatchObject({ ok: false, error: /Give either/ });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "x", "--seqs", "1"])).toMatchObject({
      ok: false,
      error: /Give either/,
    });
  });

  it("needs a word to search for, and row numbers it can read", () => {
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "  "])).toMatchObject({
      ok: false,
      error: /at least one word/,
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "3,x"])).toMatchObject({
      ok: false,
      error: /row numbers such as 3,4,9/,
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "0"])).toMatchObject({ ok: false });
  });

  it("reads a valid query or list of row numbers", () => {
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "Lantern Yard"])).toEqual({
      ok: true,
      request: { dir, query: "Lantern Yard", reason: "r" },
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "3, 4,9"])).toEqual({
      ok: true,
      request: { dir, seqs: [3, 4, 9], reason: "r" },
    });
  });
});

describe("natalis forget --query", () => {
  it("forgets the river rows and the note lines with the words, and prints counts only", async () => {
    const code = await forgetCommand(["--dir", dir, "--query", "lantern yard", "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(0);
    expect(out[0]).toBe("Forgot 2 river row(s), 3 note line(s) in 2 note file(s), and 0 text(s) in the state file.");
    expect(out.join("
")).toContain("stop it and run this again");
    expect(out.join("\n")).toContain("git history still holds the old text");
    expect(out.join("\n")).not.toMatch(/lantern|mara|quay/i);
  });

  it("replaces the matching note lines, leaves the rest, and keeps the text in trash", async () => {
    await runForget({ dir, query: "lantern yard", reason: REASON });

    const notebook = await openNotebook(join(dir, "notebook"));
    expect(notebook.read("people/mara.md")).toBe("[forgotten by the summoner]\nShe likes tea\n[forgotten by the summoner]\n");
    expect(notebook.read("places/quay.md")).toBe("[forgotten by the summoner]\n");
    const trashed = notebook.list("trash").map((entry) => entry.path);
    expect(trashed).toHaveLength(1);
    expect(notebook.read(trashed[0] as string)).toContain("Lantern Yard, an old note");
  });

  it("commits each changed file as the owner, with the reason", async () => {
    await runForget({ dir, query: "lantern yard", reason: REASON });
    const lines = gitLog().trim().split("\n");
    expect(lines.filter((line) => line === `owner|${REASON}`)).toHaveLength(2);
  });

  it("forgets nothing when no words match", async () => {
    await runForget({ dir, query: "nothing like this", reason: REASON });
    expect(seqsOf("Lantern Yard is by the water.")).toHaveLength(1);
    const notebook = await openNotebook(join(dir, "notebook"));
    expect(notebook.read("people/mara.md")).toContain("Mara lives on Lantern Yard");
  });
});

describe("natalis forget --seqs", () => {
  it("forgets the river rows by number and leaves the notebook alone", async () => {
    const [hello] = seqsOf("Hello there.");
    const code = await forgetCommand(["--dir", dir, "--seqs", String(hello), "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(0);
    expect(out).toEqual([`Forgot 1 river row(s).`]);
    expect(seqsOf("Hello there.")).toEqual([]);
    expect(seqsOf("Lantern Yard is by the water.")).toHaveLength(1);
  });
});

describe("refusing a forget it cannot do", () => {
  it("refuses a folder that is not an entity's", async () => {
    await expect(runForget({ dir: join(root, "elsewhere"), query: "x", reason: REASON })).rejects.toThrow(/No entity.json/);
  });

  it("prints the usage and exits 2 when the flags are wrong", async () => {
    const code = await forgetCommand(["--dir", dir], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis forget");
    expect(out).toEqual([]);
  });
});
