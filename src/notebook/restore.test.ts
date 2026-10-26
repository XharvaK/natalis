import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notebookRestoreCommand } from "../bin/commands/notebook-restore.js";
import { openNotebook } from "./git-notebook.js";
import { restoreNotebookTo } from "./restore.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true, maxRetries: 5 })));
const head = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const count = (dir: string) => Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());

async function book() {
  const root = mkdtempSync(join(tmpdir(), "natalis-nbr-"));
  roots.push(root);
  const dir = join(root, "notebook");
  const nb = await openNotebook(dir);
  await nb.write("people/mara.md", "Mara likes tea.", "first", "self");
  const good = head(dir);
  await nb.write("people/mara.md", "Mara likes coffee.", "second", "self");
  await nb.write("places/hill.md", "Windy.", "third", "self");
  return { root, dir, good };
}

describe("restore the notebook to a commit", () => {
  it("makes one new commit whose files match the old commit, and keeps all history", async () => {
    const { dir, good } = await book();
    const before = count(dir);
    const result = await restoreNotebookTo(dir, good, "Undo a bad day");
    expect(readFileSync(join(dir, "people/mara.md"), "utf8")).toBe("Mara likes tea.");
    expect(existsSync(join(dir, "places/hill.md"))).toBe(false);
    expect(count(dir)).toBe(before + 1);
    expect(result.commit).toBe(head(dir));
    expect(result.files).toBe(2);
    const subject = execFileSync("git", ["-C", dir, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).trim();
    expect(subject).toMatch(/^summoner\|Summoner restored the notebook to [0-9a-f]{7,}: Undo a bad day$/);
  });

  it("refuses a commit that is not in the notebook's history, and an empty reason", async () => {
    const { dir } = await book();
    await expect(restoreNotebookTo(dir, "0123456789abcdef0123456789abcdef01234567", "x")).rejects.toThrow(/not a commit/);
    await expect(restoreNotebookTo(dir, "HEAD~1", " ")).rejects.toThrow(/reason/);
  });

  it("is a command: natalis notebook-restore --dir --commit --reason", async () => {
    const { root, good } = await book();
    writeFileSync(join(root, "state.json"), JSON.stringify({ stoppedCleanly: true, aliveMs: 1 }));
    const out: string[] = [];
    const code = await notebookRestoreCommand(["--dir", root, "--commit", good, "--reason", "Undo"], (l) => out.push(l), (l) => out.push(l));
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Restored/);
    expect(await notebookRestoreCommand(["--dir", root], () => {}, () => {})).toBe(2);
  });

  it("SHOULD-3: refuses while state.json does not show a clean stop, unless --force", async () => {
    const { root, dir, good } = await book();
    const before = head(dir);
    const quiet = () => {};
    // Running: not stopped cleanly.
    writeFileSync(join(root, "state.json"), JSON.stringify({ stoppedCleanly: false, aliveMs: Date.now() }));
    const err: string[] = [];
    expect(await notebookRestoreCommand(["--dir", root, "--commit", good, "--reason", "Undo"], quiet, (l) => err.push(l))).toBe(1);
    expect(err.join("\n")).toMatch(/stop/i);
    expect(head(dir)).toBe(before);
    // No state file at all: no clean stop is shown either.
    rmSync(join(root, "state.json"));
    expect(await notebookRestoreCommand(["--dir", root, "--commit", good, "--reason", "Undo"], quiet, quiet)).toBe(1);
    expect(head(dir)).toBe(before);
    // --force goes ahead.
    expect(await notebookRestoreCommand(["--dir", root, "--commit", good, "--reason", "Undo", "--force"], quiet, quiet)).toBe(0);
    expect(head(dir)).not.toBe(before);
  });
});
