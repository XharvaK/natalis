import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNotebook } from "./index.js";
import { purgeHistory } from "./history.js";

// Every name and line here is invented.
let root: string;
let folder: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-history-"));
  folder = join(root, "notebook");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: folder, encoding: "utf8" });
}

/** Each commit's id and subject, oldest first. */
function commits(): Array<{ sha: string; subject: string }> {
  return git(["rev-list", "--reverse", "HEAD"])
    .trim()
    .split("\n")
    .map((sha) => ({ sha, subject: git(["log", "-1", "--format=%s", sha]).trim() }));
}

describe("purgeHistory", () => {
  it("rebuilds the commits that hold the words, keeps the others, and leaves the words out of every commit", async () => {
    const notebook = await openNotebook(folder);
    await notebook.write("people/plain.md", "A plain note.\n", "First plain note", "body");
    await notebook.write("people/canary.md", "Harbour canary sings.\nSecond line.\n", "Note with the canary", "thread:dm:owner");
    await notebook.write("people/later.md", "A later plain note.\n", "Later note", "body");
    const before = commits();

    const result = await purgeHistory(folder, ["harbour", "canary"]);

    const after = commits();
    expect(after.map((item) => item.subject)).toEqual(before.map((item) => item.subject));
    const shaOf = (list: Array<{ sha: string; subject: string }>, subject: string): string | undefined =>
      list.find((item) => item.subject === subject)?.sha;
    // The commit with no words is the same commit; the ones that held the words are new commits.
    expect(shaOf(after, "First plain note")).toBe(shaOf(before, "First plain note"));
    expect(shaOf(after, "Note with the canary")).not.toBe(shaOf(before, "Note with the canary"));
    expect(shaOf(after, "Later note")).not.toBe(shaOf(before, "Later note"));
    expect(result.commits).toBeGreaterThanOrEqual(2);
    // The author of a rebuilt commit is kept.
    expect(git(["log", "-1", "--format=%an", shaOf(after, "Note with the canary") ?? ""]).trim()).toBe("thread:dm:owner");
    // No diff in the whole history still shows the words.
    expect(git(["log", "-p", "--all"])).not.toMatch(/harbour canary/i);
    expect(git(["log", "-p", "--all"])).toContain("[forgotten by the summoner]");
  });

  it("changes nothing when no commit holds the words", async () => {
    const notebook = await openNotebook(folder);
    await notebook.write("people/plain.md", "A plain note.\n", "First plain note", "body");
    const before = commits();

    expect(await purgeHistory(folder, ["nothing", "like", "this"])).toEqual({ commits: 0, blobs: 0 });
    expect(commits()).toEqual(before);
  });
});
