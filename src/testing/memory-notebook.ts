// In-memory Notebook for tests. It follows the Notebook contract in src/contracts.ts and is not for production.
// Choices this fake makes where the contract is silent:
// - Paths are relative, use "/", and have no empty, "." or ".." parts.
// - remove moves the file to "trash/<path>" (a counter is added when that name is taken). Trash is skipped by
//   list and search, but read still reads it, so a moved note can be recovered.
// - append adds a newline first when the note exists and does not end with one.
// - Every change is recorded in `log` with its reason and author, the way the real notebook records commits.

import { NotebookError, type Notebook, type NotebookAuthor, type NotebookEntry } from "../contracts.js";

export type NotebookLogEntry = {
  op: "write" | "edit" | "append" | "rename" | "remove";
  path: string;
  to?: string;
  reason: string;
  author: NotebookAuthor;
  atMs: number;
};

export type MemoryNotebookOptions = { root?: string; nowMs?: () => number };

type StoredFile = { text: string; modifiedMs: number };

export class MemoryNotebook implements Notebook {
  readonly root: string;
  readonly log: NotebookLogEntry[] = [];
  private readonly files = new Map<string, StoredFile>();
  private readonly nowMs: () => number;

  constructor(options: MemoryNotebookOptions = {}) {
    this.root = options.root ?? "memory://notebook";
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  read(path: string): string | null {
    const p = checkPath(path);
    return this.files.get(p)?.text ?? null;
  }

  async write(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void> {
    const p = checkPath(path);
    this.files.set(p, { text, modifiedMs: this.nowMs() });
    this.record({ op: "write", path: p, reason, author });
  }

  async edit(path: string, find: string, replace: string, reason: string, author: NotebookAuthor): Promise<void> {
    const p = checkPath(path);
    const current = this.files.get(p);
    if (current === undefined) throw new NotebookError(`There is no note at ${p}.`, "not_found");
    if (find === "") throw new NotebookError("There is no text to find.", "not_found");
    const first = current.text.indexOf(find);
    if (first < 0) throw new NotebookError(`The text was not found in ${p}.`, "not_found");
    // Look from the next character so overlapping matches count too.
    if (current.text.indexOf(find, first + 1) >= 0) {
      throw new NotebookError(`The text appears more than once in ${p}.`, "ambiguous");
    }
    const text = current.text.slice(0, first) + replace + current.text.slice(first + find.length);
    this.files.set(p, { text, modifiedMs: this.nowMs() });
    this.record({ op: "edit", path: p, reason, author });
  }

  async append(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void> {
    const p = checkPath(path);
    const current = this.files.get(p)?.text ?? "";
    const separator = current !== "" && !current.endsWith("\n") ? "\n" : "";
    this.files.set(p, { text: current + separator + text, modifiedMs: this.nowMs() });
    this.record({ op: "append", path: p, reason, author });
  }

  async remove(path: string, reason: string, author: NotebookAuthor): Promise<void> {
    const p = checkPath(path);
    const current = this.files.get(p);
    if (current === undefined) throw new NotebookError(`There is no note at ${p}.`, "not_found");
    let target = `trash/${p}`;
    for (let n = 2; this.files.has(target); n += 1) target = `trash/${p}.${n}`;
    this.files.delete(p);
    this.files.set(target, current);
    this.record({ op: "remove", path: p, to: target, reason, author });
  }

  async rename(path: string, to: string, reason: string, author: NotebookAuthor): Promise<void> {
    const p = checkPath(path);
    const target = checkPath(to);
    if (p === "trash" || p.startsWith("trash/") || target === "trash" || target.startsWith("trash/")) {
      throw new NotebookError("Files in trash/ are kept, not renamed.", "bad_path");
    }
    const current = this.files.get(p);
    if (current === undefined) throw new NotebookError(`There is no note at ${p}.`, "not_found");
    if (p === target) return;
    if (this.files.has(target)) throw new NotebookError(`There is already a note at ${target}.`, "bad_path");
    this.files.delete(p);
    this.files.set(target, current);
    this.record({ op: "rename", path: p, to: target, reason, author });
  }

  list(dir?: string): NotebookEntry[] {
    const folder = dir === undefined ? "" : dir.replace(/\/+$/, "");
    const prefix = folder === "" ? "" : `${checkPath(folder)}/`;
    const entries: NotebookEntry[] = [];
    for (const path of [...this.files.keys()].sort()) {
      if (isTrash(path) || !path.startsWith(prefix)) continue;
      const file = this.files.get(path);
      if (file === undefined) continue;
      entries.push({
        path,
        bytes: Buffer.byteLength(file.text, "utf8"),
        modifiedMs: file.modifiedMs,
        firstLine: firstLine(file.text),
      });
    }
    return entries;
  }

  search(text: string, limit = 50): Array<{ path: string; line: number; text: string }> {
    const needle = text.toLowerCase();
    const hits: Array<{ path: string; line: number; text: string }> = [];
    if (needle === "") return hits;
    for (const path of [...this.files.keys()].sort()) {
      if (isTrash(path)) continue;
      const lines = (this.files.get(path)?.text ?? "").split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
        const line = lines[i] ?? "";
        if (line.toLowerCase().includes(needle)) hits.push({ path, line: i + 1, text: line });
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private record(entry: Omit<NotebookLogEntry, "atMs">): void {
    this.log.push({ ...entry, atMs: this.nowMs() });
  }
}

function checkPath(path: string): string {
  const bad =
    typeof path !== "string" ||
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..");
  if (bad) throw new NotebookError(`That path is not allowed: ${JSON.stringify(path)}.`, "bad_path");
  return path;
}

function isTrash(path: string): boolean {
  return path === "trash" || path.startsWith("trash/");
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
