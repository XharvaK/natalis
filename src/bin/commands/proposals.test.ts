import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretScanner } from "../../secrets/index.js";
import { proposalsCommand, proposalsDigest } from "./proposals.js";

// Fake credentials and vault values are built from parts at run time, so no token-shaped literal sits in the source.
const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");
const VAULT_VALUE = ["vault", "value", "0123456789abcdef"].join("-");

let root: string;
let lar: string;
let notebook: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-proposals-"));
  lar = join(root, "ada");
  notebook = join(lar, "notebook");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(
    join(lar, "entity.json"),
    JSON.stringify({ model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32000 }, summoner: { alias: "summoner" } }),
  );
  gitIn(notebook, ["init", "-q"]);
  gitIn(notebook, ["symbolic-ref", "HEAD", "refs/heads/main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Runs git in a folder with a fixed author and, when given, a fixed commit date. */
function gitIn(cwd: string, args: string[], date?: string): string {
  const env = { ...process.env, ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) };
  return execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Test Writer", "-c", "user.email=writer@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { env, encoding: "utf8", windowsHide: true },
  ).trim();
}

/** Commits files in the notebook on a given day. A null text removes the file. */
function commit(date: string, files: Record<string, string | null>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(notebook, path);
    if (text === null) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  gitIn(notebook, ["add", "-A"]);
  gitIn(notebook, ["commit", "-q", "-m", message], date);
}

/** Two commits: one before the window of 2026-10-04, one inside it. */
function notebookWithProposals(): void {
  commit(
    "2026-09-20T12:00:00Z",
    {
      "self/life.md": "Life notes.\n",
      "proposals/keep.md": "Old idea, before the window.\n",
      "proposals/gone.md": "A note that will go.\n",
    },
    "Write my first notes",
  );
  commit(
    "2026-10-08T12:00:00Z",
    {
      "proposals/keep.md": "Old idea, now refined.\n",
      "proposals/gone.md": null,
      "proposals/new-tool.md": "A search tool for my own notes.\n",
      "self/life.md": "Life notes, edited.\n",
    },
    "Write a proposal for a search tool",
  );
}

function scanner() {
  return createSecretScanner({ knownValues: [VAULT_VALUE] });
}

describe("proposalsDigest", () => {
  it("lists a file added, a file changed and a file removed in the window, with text, diff and counts", async () => {
    notebookWithProposals();
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).toContain("# Proposals changed since 2026-10-04");
    expect(digest.text).toContain("3 files changed since 2026-10-04: 1 added, 1 changed, 1 removed.");
    expect(digest.text).toContain("## proposals/new-tool.md (added, last changed 2026-10-08)");
    expect(digest.text).toContain("A search tool for my own notes.");
    expect(digest.text).toContain("## proposals/keep.md (changed, last changed 2026-10-08)");
    expect(digest.text).toContain("-Old idea, before the window.");
    expect(digest.text).toContain("+Old idea, now refined.");
    expect(digest.text).toContain("## proposals/gone.md (removed, last changed 2026-10-08)");
    expect(digest.text).toContain("Removed.");
    expect(digest.added).toBe(1);
    expect(digest.changed).toBe(1);
    expect(digest.removed).toBe(1);
  });

  it("leaves out files outside proposals/, and changes made before the window", async () => {
    notebookWithProposals();
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).not.toContain("self/life.md");
    expect(digest.text).not.toContain("Life notes");
  });

  it("says nothing changed when every change is before the day given", async () => {
    notebookWithProposals();
    const digest = await proposalsDigest({ notebook, since: "2026-10-09", scanner: scanner() });

    expect(digest.text).toBe("No proposals changed since 2026-10-09.");
    expect(digest.added + digest.changed + digest.removed).toBe(0);
  });

  it("does not list a file made and removed inside the window, when the window opens before it", async () => {
    notebookWithProposals();
    const digest = await proposalsDigest({ notebook, since: "2026-09-01", scanner: scanner() });

    expect(digest.text).toContain("2 files changed since 2026-09-01: 2 added, 0 changed, 0 removed.");
    expect(digest.text).toContain("## proposals/keep.md (added");
    expect(digest.text).toContain("## proposals/new-tool.md (added");
    expect(digest.text).not.toContain("gone.md");
  });

  it("says so plainly when the notebook has no proposals at all", async () => {
    commit("2026-10-08T12:00:00Z", { "self/life.md": "Only life notes.\n" }, "Write my life notes");
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).toBe("No proposals changed since 2026-10-04.");
  });

  it("says so plainly when the notebook has no commit at all", async () => {
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).toBe("No proposals changed since 2026-10-04.");
  });

  it("refuses a folder with no repository of its own, rather than reading a repository above it", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    await expect(proposalsDigest({ notebook: bare, since: "2026-10-04", scanner: scanner() })).rejects.toThrow(/no notebook history/);
  });

  it("redacts a key the Lar pasted into a proposal", async () => {
    commit("2026-10-08T12:00:00Z", { "proposals/paste.md": `Use this key: ${FAKE_KEY}\n` }, "Write a proposal with a key in it");
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).toContain("## proposals/paste.md (added");
    expect(digest.text).not.toContain(FAKE_KEY);
    expect(digest.text).toContain("[secret:openai_sk]");
  });

  it("redacts a value the body holds, such as a vault value", async () => {
    commit("2026-10-08T12:00:00Z", { "proposals/vault.md": `The site wants ${VAULT_VALUE} in the header.\n` }, "Write a proposal about a site");
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).not.toContain(VAULT_VALUE);
    expect(digest.text).toContain("[secret:known_value]");
  });

  it("fences text that contains backticks so the text cannot close its own fence", async () => {
    commit("2026-10-08T12:00:00Z", { "proposals/code.md": "Run ```npm test``` first.\n" }, "Write a proposal with code");
    const digest = await proposalsDigest({ notebook, since: "2026-10-04", scanner: scanner() });

    expect(digest.text).toContain("````text\nRun ```npm test``` first.\n````");
  });
});

describe("natalis proposals", () => {
  it("prints the digest and exits 0 when there are proposals", async () => {
    notebookWithProposals();
    const out: string[] = [];
    const err: string[] = [];
    const code = await proposalsCommand(["--dir", lar, "--since", "2026-10-04"], (line) => out.push(line), (line) => err.push(line));

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("# Proposals changed since 2026-10-04");
    expect(err).toEqual([]);
  });

  it("prints the plain line and exits 0 when there are none", async () => {
    commit("2026-10-08T12:00:00Z", { "self/life.md": "Only life notes.\n" }, "Write my life notes");
    const out: string[] = [];
    const code = await proposalsCommand(["--dir", lar, "--since", "2026-10-04"], (line) => out.push(line), () => undefined);

    expect(code).toBe(0);
    expect(out).toEqual(["No proposals changed since 2026-10-04."]);
  });

  it("defaults --since to seven days before now, so a fixed clock gives a fixed window", async () => {
    notebookWithProposals();
    const out: string[] = [];
    // Seven days before 11 October is 4 October in every zone a host is likely to use; 5 October in the furthest east.
    const code = await proposalsCommand(["--dir", lar], (line) => out.push(line), () => undefined, new Date("2026-10-11T12:00:00Z"));

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/# Proposals changed since 2026-10-0[45]/);
    expect(out.join("\n")).toContain("new-tool.md");
  });

  it("exits 2 with the usage line for a missing --dir, a bad day, a missing value and an unknown flag", async () => {
    const err: string[] = [];
    const quiet = (): void => undefined;
    expect(await proposalsCommand(["--since", "2026-10-04"], quiet, (line) => err.push(line))).toBe(2);
    expect(await proposalsCommand(["--dir", lar, "--since", "2026-13-01"], quiet, (line) => err.push(line))).toBe(2);
    expect(await proposalsCommand(["--dir", lar, "--since", "last week"], quiet, (line) => err.push(line))).toBe(2);
    expect(await proposalsCommand(["--dir", lar, "--since"], quiet, (line) => err.push(line))).toBe(2);
    expect(await proposalsCommand(["--dir", lar, "--bogus"], quiet, (line) => err.push(line))).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis proposals");
  });

  it("exits 1 with a plain message when the folder is not a Lar, or has no notebook history", async () => {
    const err: string[] = [];
    const quiet = (): void => undefined;
    expect(await proposalsCommand(["--dir", join(root, "nobody")], quiet, (line) => err.push(line))).toBe(1);
    const bare = join(root, "bare");
    mkdirSync(bare);
    writeFileSync(join(bare, "entity.json"), JSON.stringify({ model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32000 }, summoner: { alias: "summoner" } }));
    expect(await proposalsCommand(["--dir", bare, "--since", "2026-10-04"], quiet, (line) => err.push(line))).toBe(1);
    expect(err.join("\n")).toMatch(/no notebook history/);
  });
});
