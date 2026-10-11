// Reads a seed bundle (docs/seed-bundle.md) and checks its shape. Shape problems stop the import and are listed
// by file and line. Secret hits are refused items: the item is marked and listed by file and line, never by
// value. Reading writes nothing.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RiverSource, SecretScanner } from "../contracts.js";

export const BUNDLE_FORMAT = "natalis-seed-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_FILE = "bundle.json";
export const RIVER_BUNDLE_FILE = "river.jsonl";
export const TOMBSTONE_BUNDLE_FILE = "tombstones.jsonl";
/** The importer writes this notebook file itself, so a bundle note may not use the name. */
export const FORGOTTEN_NOTE = "forgotten.md";

export type Problem = { file: string; line?: number; message: string };

export type Refusal = {
  file: string;
  line?: number;
  item: "note" | "provenance" | "river row" | "tombstone";
  reason: string;
};

export type BundleFile = {
  /** Where it goes in the notebook, "/"-separated. */
  path: string;
  /** Where it is in the bundle, for messages. */
  file: string;
  text: string;
  bytes: number;
  refused: boolean;
};

export type BundleRow = {
  line: number;
  atMs: number;
  thread: string;
  kind: "event" | "say" | "note";
  source: RiverSource;
  place?: string;
  actor?: string;
  text?: string;
  data?: Record<string, unknown>;
  refused: boolean;
};

export type BundleTombstone = {
  line: number;
  atMs: number;
  by: "owner" | "self" | "body";
  reason: string;
  count?: number;
  what?: string;
  refused: boolean;
};

export type Bundle = {
  dir: string;
  source: string;
  createdAt: string;
  notes: BundleFile[];
  provenance: BundleFile[];
  rows: BundleRow[];
  tombstones: BundleTombstone[];
};

export type ReadBundleResult =
  | { ok: true; bundle: Bundle; refused: Refusal[] }
  | { ok: false; problems: Problem[] };

const RIVER_KINDS = ["event", "say", "note"] as const;
const SOURCES = ["owner", "outside", "self", "body"] as const;
const TOMBSTONE_BY = ["owner", "self", "body"] as const;

/** Reads and checks a bundle folder. Problems are collected, not thrown; secret hits become refusals. */
export function readBundle(dir: string, scanner: SecretScanner): ReadBundleResult {
  const problems: Problem[] = [];
  const refused: Refusal[] = [];
  if (!isDirectory(dir)) {
    return { ok: false, problems: [{ file: dir, message: "the bundle is not a folder" }] };
  }

  const meta = readMeta(dir, problems);
  if (meta !== undefined && scanner.scan(meta.source).length > 0) {
    problems.push({ file: BUNDLE_FILE, message: "the source line holds a credential-like string; change it" });
  }

  const rows = readRows(dir, scanner, problems, refused);
  const tombstones = readTombstones(dir, scanner, problems, refused);
  const notes = readFolderFiles(dir, "notes", scanner, problems, refused, "note");
  const provenance = readFolderFiles(dir, "provenance", scanner, problems, refused, "provenance");

  if (problems.length > 0 || meta === undefined) return { ok: false, problems };
  const bundle: Bundle = {
    dir,
    source: meta.source,
    createdAt: meta.createdAt,
    notes,
    provenance,
    rows,
    tombstones,
  };
  return { ok: true, bundle, refused };
}

// ---------------------------------------------------------------------------------------------------
// bundle.json

function readMeta(dir: string, problems: Problem[]): { source: string; createdAt: string } | undefined {
  const value = readJson(join(dir, BUNDLE_FILE), BUNDLE_FILE, problems);
  if (value === undefined) return undefined;
  const block = objectOrProblem(value, BUNDLE_FILE, undefined, problems);
  if (block === undefined) return undefined;
  const before = problems.length;
  if (block["format"] !== BUNDLE_FORMAT) problems.push({ file: BUNDLE_FILE, message: `format must be "${BUNDLE_FORMAT}"` });
  if (block["version"] !== BUNDLE_VERSION) problems.push({ file: BUNDLE_FILE, message: `version must be ${BUNDLE_VERSION}` });
  onlyKeys(block, ["format", "version", "source", "createdAt"], BUNDLE_FILE, undefined, problems);
  const source = block["source"];
  if (typeof source !== "string" || source.trim() === "" || /[\r\n]/.test(source)) {
    problems.push({ file: BUNDLE_FILE, message: "source must be one line of text" });
  }
  const createdAt = block["createdAt"];
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    problems.push({ file: BUNDLE_FILE, message: "createdAt must be a date and time (ISO)" });
  }
  if (problems.length > before || typeof source !== "string" || typeof createdAt !== "string") return undefined;
  return { source: source.trim(), createdAt };
}

// ---------------------------------------------------------------------------------------------------
// river.jsonl

function readRows(dir: string, scanner: SecretScanner, problems: Problem[], refused: Refusal[]): BundleRow[] {
  const rows: BundleRow[] = [];
  for (const { line, value } of readLines(dir, RIVER_BUNDLE_FILE, problems)) {
    const block = objectOrProblem(value, RIVER_BUNDLE_FILE, line, problems);
    if (block === undefined) continue;
    const before = problems.length;
    onlyKeys(block, ["atMs", "thread", "kind", "source", "place", "actor", "text", "data"], RIVER_BUNDLE_FILE, line, problems);
    const atMs = block["atMs"];
    if (!isTimeMs(atMs)) problems.push(bad(RIVER_BUNDLE_FILE, line, "atMs must be a whole number of milliseconds since 1970"));
    const thread = block["thread"];
    if (typeof thread !== "string" || thread.trim() === "") problems.push(bad(RIVER_BUNDLE_FILE, line, "thread must be text"));
    const kind = block["kind"];
    if (!isOneOf(kind, RIVER_KINDS)) problems.push(bad(RIVER_BUNDLE_FILE, line, "kind must be event, say or note"));
    const source = block["source"];
    if (!isOneOf(source, SOURCES)) problems.push(bad(RIVER_BUNDLE_FILE, line, "source must be owner, outside, self or body"));
    for (const key of ["place", "actor", "text"] as const) {
      if (block[key] !== undefined && typeof block[key] !== "string") {
        problems.push(bad(RIVER_BUNDLE_FILE, line, `${key} must be text`));
      }
    }
    const data = block["data"];
    if (data !== undefined && !isPlainObject(data)) problems.push(bad(RIVER_BUNDLE_FILE, line, "data must be an object"));
    if (problems.length > before) continue;

    const row: BundleRow = {
      line,
      atMs: atMs as number,
      thread: (thread as string).trim(),
      kind: kind as BundleRow["kind"],
      source: source as RiverSource,
      refused: false,
    };
    if (block["place"] !== undefined) row.place = block["place"] as string;
    if (block["actor"] !== undefined) row.actor = block["actor"] as string;
    if (block["text"] !== undefined) row.text = block["text"] as string;
    if (data !== undefined) row.data = data as Record<string, unknown>;

    const hits = [row.thread, row.place, row.actor, row.text, row.data === undefined ? undefined : JSON.stringify(row.data)];
    const kinds = secretKinds(scanner, hits);
    if (kinds.length > 0) {
      row.refused = true;
      refused.push({ file: RIVER_BUNDLE_FILE, line, item: "river row", reason: credentialReason(kinds) });
    }
    rows.push(row);
  }
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1];
    const current = rows[i];
    if (previous && current && current.atMs < previous.atMs) {
      problems.push(
        bad(RIVER_BUNDLE_FILE, current.line, `this row is earlier than the row on line ${previous.line}; rows must be sorted by atMs`),
      );
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------
// tombstones.jsonl

function readTombstones(dir: string, scanner: SecretScanner, problems: Problem[], refused: Refusal[]): BundleTombstone[] {
  const out: BundleTombstone[] = [];
  for (const { line, value } of readLines(dir, TOMBSTONE_BUNDLE_FILE, problems)) {
    const block = objectOrProblem(value, TOMBSTONE_BUNDLE_FILE, line, problems);
    if (block === undefined) continue;
    const before = problems.length;
    onlyKeys(block, ["atMs", "by", "reason", "count", "what"], TOMBSTONE_BUNDLE_FILE, line, problems);
    const atMs = block["atMs"];
    if (!isTimeMs(atMs)) problems.push(bad(TOMBSTONE_BUNDLE_FILE, line, "atMs must be a whole number of milliseconds since 1970"));
    const by = block["by"];
    if (!isOneOf(by, TOMBSTONE_BY)) problems.push(bad(TOMBSTONE_BUNDLE_FILE, line, "by must be owner, self or body"));
    const reason = block["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      problems.push(bad(TOMBSTONE_BUNDLE_FILE, line, "reason must be a plain line of text"));
    }
    const count = block["count"];
    if (count !== undefined && (!isSafeInt(count) || (count as number) < 0)) {
      problems.push(bad(TOMBSTONE_BUNDLE_FILE, line, "count must be a whole number, 0 or more"));
    }
    if (block["what"] !== undefined && typeof block["what"] !== "string") {
      problems.push(bad(TOMBSTONE_BUNDLE_FILE, line, "what must be text"));
    }
    if (problems.length > before) continue;

    const item: BundleTombstone = {
      line,
      atMs: atMs as number,
      by: by as BundleTombstone["by"],
      reason: reason as string,
      refused: false,
    };
    if (count !== undefined) item.count = count as number;
    if (block["what"] !== undefined) item.what = block["what"] as string;
    const kinds = secretKinds(scanner, [item.reason, item.what]);
    if (kinds.length > 0) {
      item.refused = true;
      refused.push({ file: TOMBSTONE_BUNDLE_FILE, line, item: "tombstone", reason: credentialReason(kinds) });
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// notes/ and provenance/

function readFolderFiles(
  dir: string,
  folder: "notes" | "provenance",
  scanner: SecretScanner,
  problems: Problem[],
  refused: Refusal[],
  item: "note" | "provenance",
): BundleFile[] {
  const root = join(dir, folder);
  if (!existsSync(root)) return [];
  if (!isDirectory(root)) {
    problems.push({ file: folder, message: `${folder} must be a folder` });
    return [];
  }
  const files: BundleFile[] = [];
  for (const rel of walk(root, "", folder, problems)) {
    const file = `${folder}/${rel}`;
    if (!/\.(md|txt)$/i.test(rel)) {
      problems.push({ file, message: "only .md and .txt files can be imported" });
      continue;
    }
    const path = checkNotebookPath(rel, file, problems, folder === "notes");
    if (path === undefined) continue;
    const buffer = readFileSync(join(root, ...rel.split("/")));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      problems.push({ file, message: "the file is not valid UTF-8 text" });
      continue;
    }
    if (text.includes("\0")) {
      problems.push({ file, message: "the file holds a zero byte, so it is not text" });
      continue;
    }
    const notebookPath = folder === "notes" ? path : `provenance/${path}`;
    const entry: BundleFile = { path: notebookPath, file, text, bytes: buffer.length, refused: false };
    const hits = scanner.scan(text);
    if (hits.length > 0) {
      entry.refused = true;
      const lines = new Set(hits.map((hit) => lineOf(text, hit.start)));
      const kinds = [...new Set(hits.map((hit) => hit.kind))];
      for (const line of [...lines].sort((a, b) => a - b)) {
        refused.push({ file, line, item, reason: credentialReason(kinds) });
      }
    }
    files.push(entry);
  }
  return files;
}

/** Relative file names under `dir`, "/"-separated, sorted. Links and other special files are problems. */
function walk(dir: string, prefix: string, folder: string, problems: Problem[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      problems.push({ file: `${folder}/${rel}`, message: "links are not followed; copy the file itself" });
    } else if (entry.isDirectory()) {
      out.push(...walk(dir, rel, folder, problems));
    } else if (entry.isFile()) {
      out.push(rel);
    } else {
      problems.push({ file: `${folder}/${rel}`, message: "only plain files can be imported" });
    }
  }
  return out.sort();
}

/**
 * Checks a relative bundle path the way the notebook will check it. Returns the normalized path, or undefined
 * after recording a problem. `rejectForgottenNote` keeps the importer's own list name free.
 */
export function checkNotebookPath(rel: string, file: string, problems: Problem[], rejectForgottenNote: boolean): string | undefined {
  const fail = (message: string): undefined => {
    problems.push({ file, message: `${message}: ${rel}` });
    return undefined;
  };
  if (rel === "" || rel.trim() === "") return fail("the path is empty");
  if (/[\x00-\x1f]/.test(rel)) return fail("control characters are not allowed in a path");
  if (rel.includes("\\")) return fail("separate folders with /, not \\");
  if (rel.includes(":")) return fail("colons are not allowed in names");
  if (rel.startsWith("/")) return fail("the path is absolute");
  const parts: string[] = [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return fail("'..' would leave the notebook");
    if (segment.toLowerCase() === ".git") return fail(".git belongs to the repository itself");
    if (/[. ]$/.test(segment)) return fail("a name may not end with a dot or a space");
    parts.push(segment);
  }
  const path = parts.join("/");
  if (path === "") return fail("the path is empty");
  if (rejectForgottenNote && path === FORGOTTEN_NOTE) {
    return fail(`${FORGOTTEN_NOTE} is written by the importer; rename the note`);
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------
// helpers

type Line = { line: number; value: unknown };

/** Parses a .jsonl file. A missing file is an empty list. Blank lines are skipped; line numbers are file lines. */
function readLines(dir: string, name: string, problems: Problem[]): Line[] {
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    problems.push({ file: name, message: `could not be read (${messageOf(err)})` });
    return [];
  }
  const out: Line[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      out.push({ line: index + 1, value: JSON.parse(raw) as unknown });
    } catch {
      problems.push(bad(name, index + 1, "is not valid JSON"));
    }
  });
  return out;
}

function readJson(file: string, name: string, problems: Problem[]): unknown {
  if (!existsSync(file)) {
    problems.push({ file: name, message: "is missing" });
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    problems.push({ file: name, message: `is not valid JSON (${messageOf(err)})` });
    return undefined;
  }
}

function objectOrProblem(value: unknown, file: string, line: number | undefined, problems: Problem[]): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    problems.push(bad(file, line, "must be one JSON object"));
    return undefined;
  }
  return value;
}

function onlyKeys(block: Record<string, unknown>, allowed: readonly string[], file: string, line: number | undefined, problems: Problem[]): void {
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) problems.push(bad(file, line, `unknown field "${key}"`));
  }
}

function bad(file: string, line: number | undefined, message: string): Problem {
  return line === undefined ? { file, message } : { file, line, message };
}

/** The 1-based line holding character offset `at`. */
export function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function secretKinds(scanner: SecretScanner, values: Array<string | undefined>): string[] {
  const kinds = new Set<string>();
  for (const value of values) {
    if (value === undefined) continue;
    for (const hit of scanner.scan(value)) kinds.add(hit.kind);
  }
  return [...kinds];
}

function credentialReason(kinds: string[]): string {
  return `looks like it holds a credential (${kinds.join(", ")}); the words are not shown`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** A whole number of milliseconds that a Date can hold (the range JavaScript dates cover). */
function isTimeMs(value: unknown): value is number {
  return isSafeInt(value) && Math.abs(value) <= 8.64e15;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
