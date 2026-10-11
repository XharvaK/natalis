// Forgetting in the notebook's git history. The history is rebuilt from its first commit: every commit's text files get
// the same line replacement the notes get (a line holding every word becomes the forgotten marker), and so do commit
// messages. A commit that changes nothing keeps its id; the others keep their author, committer and dates. The branch
// then points at the rebuilt head, the reflog is emptied and the objects that only old history held are pruned. Older
// backups are not touched: they keep the old history until they rotate out.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { forgetLines } from "./forget.js";

export type HistoryPurge = { commits: number; blobs: number };

const NONE: HistoryPurge = { commits: 0, blobs: 0 };
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const FIELD = "\x1f";

/**
 * Removes the words from every commit of the notebook at `root` (a git repository). Returns how many commits were
 * rebuilt and how many text files were changed in them. Nothing is changed when no commit holds the words.
 */
export async function purgeHistory(root: string, words: readonly string[]): Promise<HistoryPurge> {
  if (words.length === 0) return NONE;
  const head = await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head === undefined) return NONE;
  // The branch HEAD names, so the rebuilt head replaces it; a detached HEAD is moved directly.
  const ref = (await tryGit(root, ["symbolic-ref", "--quiet", "HEAD"])) ?? "HEAD";
  const order = lines(await git(root, ["rev-list", "--reverse", "--topo-order", head]));

  const index = join(root, ".git", `natalis-forget-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  const rebuilt = new Map<string, string>();
  const blobs = new Map<string, string | null>();
  let commits = 0;
  let changedBlobs = 0;
  try {
    for (const commit of order) {
      const [, ...parents] = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).trim().split(" ");
      const newParents = parents.map((parent) => rebuilt.get(parent) ?? parent);
      const record = await git(root, ["log", "-1", `--format=%an${FIELD}%ae${FIELD}%aI${FIELD}%cn${FIELD}%ce${FIELD}%cI${FIELD}%B`, commit]);
      const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, ...body] = record.split(FIELD);
      // git log ends each record with one newline of its own; the message keeps the newlines it was written with.
      const raw = body.join(FIELD);
      const message = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      const tree = (await git(root, ["rev-parse", `${commit}^{tree}`])).trim();

      const next = await rewriteTree(root, tree, env, words, blobs);
      changedBlobs += next.changed;
      const text = forgetLines(message, words);
      const sameParents = newParents.length === parents.length && newParents.every((parent, i) => parent === parents[i]);
      if (next.tree === tree && sameParents && text.count === 0) {
        rebuilt.set(commit, commit);
        continue;
      }
      const sha = (
        await git(
          root,
          ["-c", "commit.gpgsign=false", "commit-tree", next.tree, ...newParents.flatMap((parent) => ["-p", parent])],
          text.text,
          {
            GIT_AUTHOR_NAME: authorName ?? "",
            GIT_AUTHOR_EMAIL: authorEmail ?? "",
            GIT_AUTHOR_DATE: authorDate ?? "",
            GIT_COMMITTER_NAME: committerName ?? "",
            GIT_COMMITTER_EMAIL: committerEmail ?? "",
            GIT_COMMITTER_DATE: committerDate ?? "",
          },
        )
      ).trim();
      rebuilt.set(commit, sha);
      commits += 1;
    }

    const newHead = rebuilt.get(head) ?? head;
    if (newHead === head) return NONE;
    await git(root, ["update-ref", "-m", "forget", ref, newHead, head]);
    // The old commits must not stay reachable: the reflog is emptied and the objects only they held are pruned.
    await git(root, ["reflog", "expire", "--expire=now", "--all"]);
    await git(root, ["-c", "gc.reflogExpire=now", "gc", "--prune=now", "--quiet"]);
    // The index is made to match the new head; the working tree already holds the same text.
    await git(root, ["reset", "--quiet", "--mixed", "HEAD"]);
    return { commits, blobs: changedBlobs };
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * The tree with the words removed from its text files. A file that holds no words keeps its blob; each blob is rewritten
 * once, however many commits hold it. Returns the tree id (the same one when nothing changed).
 */
async function rewriteTree(
  root: string,
  tree: string,
  env: Record<string, string>,
  words: readonly string[],
  blobs: Map<string, string | null>,
): Promise<{ tree: string; changed: number }> {
  const listing = (await git(root, ["ls-tree", "-r", "-z", tree])).split("\0").filter((entry) => entry !== "");
  const changes: string[] = [];
  let changed = 0;
  for (const entry of listing) {
    const tab = entry.indexOf("\t");
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type !== "blob" || mode === undefined || sha === undefined) continue;
    if (!blobs.has(sha)) {
      const text = decodeText(await gitBytes(root, ["cat-file", "blob", sha]));
      const result = text === undefined ? { text: "", count: 0 } : forgetLines(text, words);
      if (result.count === 0) {
        blobs.set(sha, null);
      } else {
        blobs.set(sha, (await git(root, ["hash-object", "-w", "--stdin"], result.text)).trim());
        changed += 1;
      }
    }
    const next = blobs.get(sha);
    if (next !== null && next !== undefined) changes.push(`${mode} ${next}\t${path}`);
  }
  if (changes.length === 0) return { tree, changed: 0 };
  // A fresh index holds the tree, the changed files are put into it, and the index is written as a tree.
  await git(root, ["read-tree", tree], "", env);
  await git(root, ["update-index", "-z", "--index-info"], changes.map((change) => `${change}\0`).join(""), env);
  const rewritten = (await git(root, ["write-tree"], "", env)).trim();
  return { tree: rewritten, changed };
}

/** Text when the bytes are valid UTF-8 with no NUL in them; undefined for anything else (a binary file is never searched). */
function decodeText(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || !Buffer.from(text, "utf8").equals(bytes)) return undefined;
  return text;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

/** git's text output. A command that fails throws, with git's own words. */
async function git(root: string, args: string[], input = "", env: Record<string, string> = {}): Promise<string> {
  return (await gitBytes(root, args, input, env)).toString("utf8");
}

async function tryGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(root, args)).trim();
  } catch {
    return undefined;
  }
}

function gitBytes(root: string, args: string[], input = "", env: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      "git",
      args,
      { cwd: root, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? "").trim() || error.message;
          rejectRun(new Error(`git ${args[0] ?? ""} failed: ${detail}`));
          return;
        }
        resolveRun(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
