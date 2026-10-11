// `natalis proposals --dir <entity folder> [--since YYYY-MM-DD]` prints the weekly digest of what the Lar wrote under
// proposals/ in its notebook. It reads the notebook's git history and nothing else: no write, no commit, no remote. For
// each file added, changed or removed since the day given (seven days ago by default) it prints the file's text as it
// stands, and the diff for a changed file, newest first, as Markdown. Every value the body holds, and every vault value,
// is redacted before anything is printed. A proposal is a request from the Lar; the review decides what happens to it.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SecretScanner } from "../../contracts.js";
import { loadEntityConfig } from "../../entity/config.js";
import { createSecretScanner } from "../../secrets/index.js";
import { git, errorText } from "./backup-format.js";
import { knownValueList, heldValues } from "./known-values.js";
import { NOTEBOOK_DIR } from "../../import/folder.js";
import { parseFlags, UsageError, type ParsedFlags } from "./shared.js";

export const PROPOSALS_USAGE = "Usage: natalis proposals --dir <entity folder> [--since YYYY-MM-DD]";
/** The notebook folder the Lar writes its proposals in. */
export const PROPOSALS_FOLDER = "proposals";
/** git's empty tree: the base of the first change, before any commit. A public constant, not a secret. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DAY_MS = 86_400_000;
const RECORD = "\u001e";
const FIELD = "\u001f";

export type ProposalDigest = {
  /** The Markdown, already redacted. */
  text: string;
  added: number;
  changed: number;
  removed: number;
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

  const before = await git(notebook, ["rev-list", "-1", `--before=${since}`, "HEAD"]);
  const base = before === "" ? EMPTY_TREE : before;
  const statuses = await git(notebook, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--name-status", base, "HEAD", "--", PROPOSALS_FOLDER]);
  const changes = statuses === "" ? [] : await dayOfChanges(notebook, statuses, before === "" ? "HEAD" : `${before}..HEAD`);
  if (changes.length === 0) return emptyDigest(since);

  // Newest first: by the day of the last commit that touched the file, then by name.
  changes.sort((a, b) => (a.day === b.day ? a.path.localeCompare(b.path) : a.day < b.day ? 1 : -1));
  const sections: string[] = [];
  for (const change of changes) {
    const heading = `## ${change.path} (${change.status}, last changed ${change.day})`;
    if (change.status === "removed") {
      sections.push(`${heading}\n\nRemoved.`);
      continue;
    }
    const text = await git(notebook, ["show", `HEAD:${change.path}`]);
    const parts = [heading, "", fenced(text, "text")];
    if (change.status === "changed") {
      const diff = await git(notebook, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", base, "HEAD", "--", change.path]);
      parts.push("", "Diff:", "", fenced(diff, "diff"));
    }
    sections.push(parts.join("\n"));
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
  return { text: scanner.redact(lines.join("\n")), ...counts };
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
  return { text: `No proposals changed since ${since}.`, added: 0, changed: 0, removed: 0 };
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

/** The text in a code fence longer than any run of backticks inside it, so the text cannot close the fence. */
function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** A local calendar day as YYYY-MM-DD. */
function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether the text is a real calendar day written YYYY-MM-DD. */
function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
}

/** Runs the digest command. Returns the exit code: 0 for a digest (or none), 2 for bad flags, 1 for a failure. */
export async function proposalsCommand(
  args: readonly string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  now: Date = new Date(),
): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags([...args], ["--dir", "--since"], []);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`natalis: ${error.message}`);
      err(PROPOSALS_USAGE);
      return 2;
    }
    throw error;
  }
  const dirArg = flags.values.get("--dir");
  if (dirArg === undefined) {
    err(PROPOSALS_USAGE);
    return 2;
  }
  const since = flags.values.get("--since") ?? localDay(new Date(now.getTime() - 7 * DAY_MS));
  if (!isDay(since)) {
    err("natalis: --since must be a day written YYYY-MM-DD, such as 2026-10-04.");
    err(PROPOSALS_USAGE);
    return 2;
  }

  const dir = resolve(dirArg);
  try {
    const config = loadEntityConfig(dir);
    const held = heldValues(dir, config, { vault: true });
    const scanner = createSecretScanner({ knownValues: knownValueList(held) });
    const digest = await proposalsDigest({ notebook: join(dir, NOTEBOOK_DIR), since, scanner });
    out(digest.text);
    return 0;
  } catch (error) {
    err(`natalis: ${errorText(error)}`);
    return 1;
  }
}
