// The entity's notebook: a folder of plain text, versioned with git. Every write is a commit with a reason.
// Git runs only through execFile (no shell). All writes go through one queue so git never races itself.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";
import { NotebookError } from "../contracts.js";
import type { Notebook, NotebookAuthor, NotebookEntry } from "../contracts.js";
import { SEED_AUTHOR } from "./layout.js";

const ATTRIBUTES = "* text=auto eol=lf\n";
const COMMIT_EMAIL = "entity@natalis.invalid";
const SUBJECT_MAX = 72;
const FIRST_LINE_MAX = 120;
const SEARCH_LINE_MAX = 200;
const TRASH = "trash";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------
// Paths

/**
 * Normalize a notebook path to relative, `/`-separated form. Refuses anything that could leave the notebook
 * or reach git's own folder. Returns "" only when `allowRoot` is set and the path names the root.
 */
function normalizePath(input: unknown, allowRoot = false): string {
  const shown = typeof input === "string" ? JSON.stringify(input) : String(input);
  const refuse = (why: string): never => {
    throw new NotebookError(`Refused path ${shown}: ${why}.`, "bad_path");
  };
  if (typeof input !== "string") refuse("a path is text");
  const raw = input as string;
  if (raw === "" || raw === ".") {
    if (allowRoot) return "";
    refuse("the path is empty");
  }
  if (/[\x00-\x1f]/.test(raw)) refuse("control characters are not allowed");
  if (raw.includes("\\")) refuse("separate folders with /");
  if (raw.includes(":")) refuse("colons are not allowed in names");
  if (posix.isAbsolute(raw) || win32.isAbsolute(raw)) refuse("the path is absolute");

  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") refuse("'..' would leave the notebook");
    if (/[. ]$/.test(segment)) refuse("a name may not end with a dot or a space");
    if (segment.toLowerCase() === ".git") refuse(".git belongs to the repository itself");
    parts.push(segment);
  }
  if (parts.length === 0) {
    if (allowRoot) return "";
    refuse("the path is empty");
  }
  return parts.join("/");
}

function toAbsolute(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Text of a file, or null when there is no such file (or it is a folder). Other failures are loud. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(codeOf(err) ?? "")) return null;
    throw new NotebookError(`Could not read a notebook file: ${(err as Error).message}`, "io");
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Commit text and identity

function cleanAuthor(author: NotebookAuthor): string {
  const name = String(author ?? "")
    .replace(/[<>\r\n]/g, "")
    .trim();
  if (name.length === 0) throw new Error("A notebook write needs an author.");
  return name;
}

function cleanReason(reason: string): string {
  const full = String(reason ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (full.length === 0) throw new Error("A notebook write needs a reason.");
  return full;
}

function shortenSubject(line: string): string {
  const cut = line.slice(0, SUBJECT_MAX - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** The reason is the subject when it fits in one line; otherwise the subject is shortened and the full reason goes in the body. */
function commitMessage(reason: string): string {
  const firstLine = reason.split("\n")[0]?.trim() ?? "";
  const subject = firstLine.length > SUBJECT_MAX ? shortenSubject(firstLine) : firstLine;
  return reason === subject ? `${subject}\n` : `${subject}\n\n${reason}\n`;
}

function identityArgs(author: string): string[] {
  return ["-c", `user.name=${author}`, "-c", `user.email=${COMMIT_EMAIL}`, "-c", "commit.gpgsign=false"];
}

// ---------------------------------------------------------------------------------------------------
// Git, through execFile only

type GitRun = { code: number; stdout: string; stderr: string };

function runGit(args: string[], cwd: string, input: string): Promise<GitRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          rejectRun(new NotebookError(`git could not run: ${error.message}`, "io"));
          return;
        }
        resolveRun({
          code: error ? (error.code as number) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function git(root: string, args: string[], okCodes: number[] = [0], input = ""): Promise<GitRun> {
  const run = await runGit(args, root, input);
  if (!okCodes.includes(run.code)) {
    const detail = run.stderr.trim() || run.stdout.trim() || `exit ${run.code}`;
    throw new NotebookError(`git failed: ${detail}`, "io");
  }
  return run;
}

// ---------------------------------------------------------------------------------------------------
// The notebook

function firstLineOf(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, FIRST_LINE_MAX);
  }
  return "";
}

/** Every file under `dir` (relative to `root`, `/`-separated), `.git` excluded. Symbolic links are not followed. */
function collectFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

class GitNotebook implements Notebook {
  readonly root: string;
  private tail: Promise<void> = Promise.resolve();
  /** First lines by path, with the size and modification time they were read at. */
  private readonly firstLines = new Map<string, { size: number; mtimeMs: number; firstLine: string }>();

  constructor(root: string) {
    this.root = root;
  }

  /** One job at a time, in call order. A failed job does not stop the queue. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Put `text` at `rel` and commit it, unless git sees no change. Runs inside the queue only. */
  private async save(rel: string, text: string, author: string, reason: string): Promise<void> {
    const file = toAbsolute(this.root, rel);
    if (readText(file) !== text) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      } catch (err) {
        throw new NotebookError(`Could not write ${rel}: ${(err as Error).message}`, "io");
      }
    }
    await git(this.root, ["add", "--", rel]);
    // Exit 1 means "there is a staged change"; 0 means the write changed nothing, so no commit.
    const changed = await git(this.root, ["diff", "--cached", "--quiet", "--", rel], [0, 1]);
    if (changed.code === 0) return;
    await this.commit(author, reason);
  }

  private async commit(author: string, reason: string): Promise<void> {
    await git(
      this.root,
      [...identityArgs(author), "commit", "--quiet", "--no-verify", "--cleanup=verbatim", "-F", "-"],
      [0],
      commitMessage(reason),
    );
  }

  read(path: string): string | null {
    return readText(toAbsolute(this.root, normalizePath(path)));
  }

  async write(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void> {
    const rel = normalizePath(path);
    const who = cleanAuthor(author);
    const why = cleanReason(reason);
    return this.enqueue(() => this.save(rel, text, who, why));
  }

  async edit(
    path: string,
    find: string,
    replace: string,
    reason: string,
    author: NotebookAuthor,
  ): Promise<void> {
    const rel = normalizePath(path);
    const who = cleanAuthor(author);
    const why = cleanReason(reason);
    if (typeof find !== "string" || find.length === 0) {
      throw new NotebookError("There is no text to find.", "not_found");
    }
    return this.enqueue(async () => {
      const current = readText(toAbsolute(this.root, rel));
      if (current === null) throw new NotebookError(`${rel} does not exist.`, "not_found");
      const first = current.indexOf(find);
      if (first === -1) throw new NotebookError(`The text was not found in ${rel}.`, "not_found");
      if (current.indexOf(find, first + 1) !== -1) {
        throw new NotebookError(`The text occurs more than once in ${rel}; nothing was changed.`, "ambiguous");
      }
      const next = current.slice(0, first) + replace + current.slice(first + find.length);
      await this.save(rel, next, who, why);
    });
  }

  async append(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void> {
    const rel = normalizePath(path);
    const who = cleanAuthor(author);
    const why = cleanReason(reason);
    return this.enqueue(async () => {
      const current = readText(toAbsolute(this.root, rel)) ?? "";
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      await this.save(rel, current + separator + text, who, why);
    });
  }

  async remove(path: string, reason: string, author: NotebookAuthor): Promise<void> {
    const rel = normalizePath(path);
    const who = cleanAuthor(author);
    const why = cleanReason(reason);
    if (rel === TRASH || rel.startsWith(`${TRASH}/`)) {
      throw new NotebookError("Files in trash/ are kept, not removed again.", "bad_path");
    }
    return this.enqueue(async () => {
      if (!isFile(toAbsolute(this.root, rel))) throw new NotebookError(`${rel} does not exist.`, "not_found");
      const target = this.trashTarget(rel);
      mkdirSync(dirname(toAbsolute(this.root, target)), { recursive: true });
      await git(this.root, ["add", "--", rel]);
      await git(this.root, ["mv", "--", rel, target]);
      await this.commit(who, `${why} (moved to ${target})`);
    });
  }

  /** trash/<UTC date>/<original path>; a second file with the same name that day gets -2, -3, ... before its extension. */
  private trashTarget(rel: string): string {
    const day = new Date().toISOString().slice(0, 10);
    const base = `${TRASH}/${day}/${rel}`;
    if (!existsSync(toAbsolute(this.root, base))) return base;
    const ext = posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!existsSync(toAbsolute(this.root, candidate))) return candidate;
    }
  }

  /** Notebook-relative paths of the files under a folder, sorted, `.git` excluded. */
  private filePaths(dirRel: string): string[] {
    const start = dirRel === "" ? this.root : toAbsolute(this.root, dirRel);
    if (!existsSync(start)) return [];
    if (!statSync(start).isDirectory()) throw new NotebookError(`${dirRel} is not a folder.`, "not_found");
    const out: string[] = [];
    collectFiles(this.root, start, out);
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  list(dir?: string): NotebookEntry[] {
    const dirRel = normalizePath(dir ?? "", true);
    const entries: NotebookEntry[] = [];
    const walked = new Set<string>();
    for (const path of this.filePaths(dirRel)) {
      const file = toAbsolute(this.root, path);
      walked.add(path);
      try {
        const stat = statSync(file);
        entries.push({
          path,
          bytes: stat.size,
          modifiedMs: Math.round(stat.mtimeMs),
          firstLine: this.firstLineCached(path, file, stat),
        });
      } catch (err) {
        // A file moved between the walk and the stat is not part of the listing any more.
        if (codeOf(err) !== "ENOENT") throw err;
        this.firstLines.delete(path);
      }
    }
    // A full listing sees every file, so a cache entry it did not walk belongs to a file that is gone.
    if (dirRel === "") {
      for (const path of [...this.firstLines.keys()]) if (!walked.has(path)) this.firstLines.delete(path);
    }
    return entries.sort(byPath);
  }

  /** The first line of a file, read again only when its size or modification time has changed since last time. */
  private firstLineCached(path: string, file: string, stat: { size: number; mtimeMs: number }): string {
    const known = this.firstLines.get(path);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.firstLine;
    const firstLine = firstLineOf(readFileSync(file, "utf8"));
    this.firstLines.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, firstLine });
    return firstLine;
  }

  search(text: string, limit = 50): Array<{ path: string; line: number; text: string }> {
    const needle = String(text ?? "").toLowerCase();
    const hits: Array<{ path: string; line: number; text: string }> = [];
    if (needle.length === 0 || limit <= 0) return hits;
    for (const path of this.filePaths("")) {
      if (path === TRASH || path.startsWith(`${TRASH}/`)) continue;
      const content = readText(toAbsolute(this.root, path));
      if (content === null || content.includes("\0")) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!line.toLowerCase().includes(needle)) continue;
        hits.push({ path, line: i + 1, text: line.trim().slice(0, SEARCH_LINE_MAX) });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }
}

/**
 * Open (or create) the notebook folder at `root`. Creates the folder and `git init`s it on branch main when
 * there is no repository yet, and makes sure `.gitattributes` keeps text in LF.
 */
export async function openNotebook(root: string): Promise<Notebook> {
  const abs = resolve(root);
  try {
    mkdirSync(abs, { recursive: true });
  } catch (err) {
    throw new NotebookError(`Could not create the notebook folder: ${(err as Error).message}`, "io");
  }
  if (!existsSync(join(abs, ".git"))) {
    await git(abs, ["init", "--quiet"]);
    await git(abs, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  const notebook = new GitNotebook(abs);
  await notebook.write(
    ".gitattributes",
    ATTRIBUTES,
    "Open the notebook: text is kept with LF line endings",
    SEED_AUTHOR,
  );
  return notebook;
}
