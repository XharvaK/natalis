// The digest of proposals: what the Lar wrote under proposals/ in its notebook, read from the notebook's git history.
// It writes nothing. `natalis proposals` prints it, and the body's monthly list reads its short per-file lines.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SecretScanner } from "../contracts.js";

/** The notebook folder the Lar writes its proposals in. */
export const PROPOSALS_FOLDER = "proposals";
/** git's empty tree: the base of the first change, before any commit. A public constant, not a secret. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const RECORD = "\u001e";
const FIELD = "\u001f";
const FIRST_LINE_MAX = 150;

export type ProposalDigestFile = {
  path: string;
  status: "added" | "changed" | "removed";
  day: string;
  firstLine: string;
};

export type ProposalDigest = {
  /** The Markdown, already redacted. */
  text: string;
  added: number;
  changed: number;
  removed: number;
  /** Every changed file, newest first like the sections. */
  files: ProposalDigestFile[];
};

type Change = { path: string; status: "added" | "changed" | "removed"; day: string };

/**
 * The digest of the proposals changed after the start of `since` (a local day, YYYY-MM-DD). The base of the window is the
 * last commit before that day; the net change from it to HEAD is what is listed, so a file made and removed inside the
 * window is not listed at all. The notebook must be a repository of its own: the folder is never searched upward.
 */
export async function proposalsDigest(options: { notebook: string; since: string; scanner: SecretScanner }): Promise<ProposalDigest> {
  const { notebook, since, scanner } = options;
  // Without a repository of its own, git would search upward and read some other repository's history.
  if (!existsSync(join(notebook, ".git"))) throw new Error(`There is no notebook history in ${notebook}.`);
  const head = await headOf(notebook);
  if (head === undefined) return emptyDigest(since);
  // No commit ever touched proposals: the net change cannot hold one. This saves three git calls on most starts.
  const everTouched = await git(notebook, ["log", "--max-count=1", "--format=%H", "--", PROPOSALS_FOLDER]);
  if (everTouched === "") return emptyDigest(since);

  const before = await git(notebook, ["rev-list", "-1", `--before=${since}`, "HEAD"]);
  const base = before === "" ? EMPTY_TREE : before;
  const statuses = await git(notebook, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--name-status", base, "HEAD", "--", PROPOSALS_FOLDER]);
  const changes = statuses === "" ? [] : await dayOfChanges(notebook, statuses, before === "" ? "HEAD" : `${before}..HEAD`);
  if (changes.length === 0) return emptyDigest(since);

  // Newest first: by the day of the last commit that touched the file, then by name.
  changes.sort((a, b) => (a.day === b.day ? a.path.localeCompare(b.path) : a.day < b.day ? 1 : -1));
  const sections: string[] = [];
  const files: ProposalDigestFile[] = [];
  for (const change of changes) {
    const heading = `## ${change.path} (${change.status}, last changed ${change.day})`;
    if (change.status === "removed") {
      sections.push(`${heading}\n\nRemoved.`);
      files.push({ path: change.path, status: change.status, day: change.day, firstLine: "" });
      continue;
    }
    const text = await git(notebook, ["show", `HEAD:${change.path}`]);
    const parts = [heading, "", fenced(text, "text")];
    if (change.status === "changed") {
      const diff = await git(notebook, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", base, "HEAD", "--", change.path]);
      parts.push("", "Diff:", "", fenced(diff, "diff"));
    }
    sections.push(parts.join("\n"));
    files.push({ path: change.path, status: change.status, day: change.day, firstLine: proposalFirstLine(text, scanner) });
  }
  const counts = countOf(changes);
  const lines = [
    `# Proposals changed since ${since}`,
    "",
    `${changes.length} ${changes.length === 1 ? "file" : "files"} changed since ${since}: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed.`,
    "",
    sections.join("\n\n"),
    "",
  ];
  return { text: scanner.redact(lines.join("\n")), ...counts, files };
}

/** Runs git with execFile (never a shell). Resolves with trimmed stdout; rejects with git's own words. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolveRun(String(stdout).trim());
    });
  });
}

/** The HEAD commit, or undefined when the notebook has no commit yet. */
async function headOf(notebook: string): Promise<string | undefined> {
  try {
    return await git(notebook, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return undefined;
  }
}

function emptyDigest(since: string): ProposalDigest {
  return { text: `No proposals changed since ${since}.`, added: 0, changed: 0, removed: 0, files: [] };
}

/** Parses the name-status lines and dates each file by its newest commit inside the window. */
async function dayOfChanges(notebook: string, statuses: string, range: string): Promise<Change[]> {
  const log = await git(notebook, ["-c", "core.quotepath=off", "log", "--no-color", `--format=${RECORD}%as${FIELD}%h`, "--name-only", range, "--", PROPOSALS_FOLDER]);
  const dayByPath = new Map<string, string>();
  for (const record of log.split(RECORD)) {
    const [header = "", ...files] = record.split("\n");
    const day = header.split(FIELD)[0] ?? "";
    for (const file of files) {
      if (file.trim() !== "" && !dayByPath.has(file)) dayByPath.set(file, day);
    }
  }
  const changes: Change[] = [];
  for (const line of statuses.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const code = line.slice(0, tab).charAt(0);
    const path = line.slice(tab + 1);
    const status = code === "A" ? "added" : code === "D" ? "removed" : "changed";
    changes.push({ path, status, day: dayByPath.get(path) ?? "" });
  }
  return changes;
}

function countOf(changes: readonly Change[]): { added: number; changed: number; removed: number } {
  return {
    added: changes.filter((change) => change.status === "added").length,
    changed: changes.filter((change) => change.status === "changed").length,
    removed: changes.filter((change) => change.status === "removed").length,
  };
}

/** The file's first non-empty line, without leading # and spaces, redacted, at most 150 characters plus an ellipsis. */
export function proposalFirstLine(text: string, scanner: SecretScanner): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return "";
  const plain = line.replace(/^[#\s]+/, "").trim();
  const chars = Array.from(scanner.redact(plain));
  return chars.length <= FIRST_LINE_MAX ? chars.join("") : `${chars.slice(0, FIRST_LINE_MAX).join("")}…`;
}

/** The text in a code fence longer than any run of backticks inside it, so the text cannot close the fence. */
function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
