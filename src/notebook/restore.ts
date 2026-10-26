// Restores the notebook's files to how they stood at an earlier commit, as one new commit by the summoner. Nothing in
// the history is removed or rewritten: the restore is itself a change that can be undone by restoring again. A commit
// must be in the notebook's own history (an ancestor of HEAD), and the working tree must be clean.

import { execFile } from "node:child_process";

export type NotebookRestore = { commit: string; files: number; from: string };

const AUTHOR = "summoner";
const EMAIL = "entity@natalis.invalid";

function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<{ code: number; out: string }> {
  return new Promise((done, fail) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1;
      if (!okCodes.includes(code)) {
        fail(new Error(`git ${args[0]} failed: ${String(stderr).trim() || String(error?.message)}`));
        return;
      }
      done({ code, out: String(stdout).trim() });
    });
  });
}

export async function restoreNotebookTo(root: string, commit: string, reason: string): Promise<NotebookRestore> {
  const why = reason.trim();
  if (why === "") throw new Error("Give a reason in one line; it is kept with the restore.");
  const resolved = await git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], [0, 1]);
  if (resolved.code !== 0 || resolved.out === "") throw new Error(`${commit} is not a commit in this notebook.`);
  const sha = resolved.out;
  const ancestor = await git(root, ["merge-base", "--is-ancestor", sha, "HEAD"], [0, 1]);
  if (ancestor.code !== 0) throw new Error(`${commit} is not a commit in this notebook's history.`);
  const status = await git(root, ["status", "--porcelain"]);
  if (status.out !== "") throw new Error("The notebook has changes that are not committed. Nothing was restored.");

  await git(root, ["read-tree", "--reset", "-u", sha]);
  const changed = (await git(root, ["diff", "--cached", "--name-only", "HEAD"])).out.split("\n").filter((line) => line !== "");
  const head = (await git(root, ["rev-parse", "HEAD"])).out;
  if (changed.length === 0) return { commit: head, files: 0, from: sha };
  const subject = `Summoner restored the notebook to ${sha.slice(0, 12)}: ${why.split("\n")[0]}`;
  await git(root, ["-c", `user.name=${AUTHOR}`, "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", subject]);
  return { commit: (await git(root, ["rev-parse", "HEAD"])).out, files: changed.length, from: sha };
}
