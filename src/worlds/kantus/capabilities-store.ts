// The Capabilities folder: the markdown reference sheets Kantus.exe exports on the summoner's PC, synced into the Lar's
// folder under kantus/capabilities/. They are read by relative path only, a giant sheet is served in short blocks, and the
// one thing written here is a Stage 2 overview at VST3/<Vendor>/<Plugin>/Overview.md. Nothing here decides what the sheets
// mean.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../fsutil/write-atomic.js";
import { capabilityPath, LARGE_BODY_LIMIT, overviewPath, WireError } from "./wire.js";

export const KANTUS_FOLDER = "kantus";
export const CAPABILITIES_FOLDER = "capabilities";
/** A read serves at most this many lines, so a giant PARAMETERS_FULL.md never blows the turn. */
export const MAX_READ_LINES = 250;
/** An overview is at most this many bytes. */
export const OVERVIEW_BYTES_MAX = 32 * 1024;
/** A query is at most this many characters. */
const QUERY_MAX = 200;

/** Where the synced sheets live for one Lar: <lar>/kantus/capabilities. */
export function capabilitiesRoot(dir: string): string {
  return join(dir, KANTUS_FOLDER, CAPABILITIES_FOLDER);
}

/** One sheet of a sync: its path inside Capabilities/ and its whole markdown text. */
export type CapabilityEntry = { path: string; text: string };

/** What one sync did: sheets written, and (a full sync only) sheets removed because the studio no longer sends them. */
export type SyncCounts = { written: number; removed: number };

export type SyncOptions = {
  /** True for a whole-folder sync: a sheet not in the entries is removed. Incremental syncs only write. */
  full?: boolean;
};

export type CapabilityReadOptions = {
  /** A literal text to find, matched without case. Cannot be combined with offsetLine. */
  query?: string;
  /** The 1-based line to start at. Defaults to 1. */
  offsetLine?: number;
  /** How many lines to return, at most MAX_READ_LINES. Defaults to MAX_READ_LINES. */
  maxLines?: number;
};

export type CapabilityLine = { line: number; text: string };

export type CapabilityRead =
  | { ok: true; path: string; totalLines: number; lines: CapabilityLine[]; fromLine?: number; nextLine?: number; matched?: number }
  | { ok: false; code: "bad_path" | "bad_args" | "not_synced" | "not_found"; reason: string };

export type CapabilityWrite =
  | { ok: true; path: string; bytes: number }
  | { ok: false; code: "bad_path" | "bad_text" | "too_large"; reason: string };

export type CapabilitiesStore = {
  /** The folder the sheets live in, <lar>/kantus/capabilities. */
  readonly root: string;
  /** Writes the sheets of one sync, and removes the ones a full sync no longer lists. Throws for a bad entry. */
  applySync(entries: readonly CapabilityEntry[], options?: SyncOptions): SyncCounts;
  /** Reads one sheet by its relative path, a block of lines at a time, or the lines a query matches. */
  read(path: string, options?: CapabilityReadOptions): CapabilityRead;
  /** Writes a Stage 2 summary at VST3/<Vendor>/<Plugin>/Overview.md, and nowhere else. */
  writeOverview(path: string, text: string): CapabilityWrite;
};

/** Opens the Capabilities folder for one Lar. Nothing is created until a sheet is synced or an overview written. */
export function openCapabilities(dir: string): CapabilitiesStore {
  const root = capabilitiesRoot(dir);

  return {
    root,

    applySync(entries, options = {}) {
      if (!Array.isArray(entries)) throw new Error("A capabilities sync must be a list of sheets.");
      // Every sheet is checked before any is written, so a sync that names one bad sheet changes nothing.
      const checked: Array<{ path: string; text: string }> = [];
      const seen = new Set<string>();
      for (const raw of entries as readonly unknown[]) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("A capability sheet must be an object with a path and its text.");
        const entry = raw as Record<string, unknown>;
        const path = capabilityPath(entry["path"]);
        const text = entry["text"];
        if (typeof text !== "string") throw new Error(`The sheet ${path} has no text.`);
        if (Buffer.byteLength(text, "utf8") > LARGE_BODY_LIMIT) throw new Error(`The sheet ${path} is larger than a whole capabilities sync allows.`);
        if (seen.has(path)) throw new WireError(400, "duplicate_path");
        seen.add(path);
        checked.push({ path, text });
      }
      for (const sheet of checked) writeFileAtomic(fileOf(root, sheet.path), sheet.text, { mkdir: true });
      let removed = 0;
      if (options.full === true) {
        for (const path of sheetPaths(root)) {
          if (seen.has(path)) continue;
          rmSync(fileOf(root, path), { force: true });
          removed += 1;
        }
      }
      return { written: checked.length, removed };
    },

    read(path, options = {}) {
      let relative: string;
      try {
        relative = capabilityPath(path);
      } catch (error) {
        return badPath(error, "read");
      }
      if (options.query !== undefined && typeof options.query !== "string") return failArgs("query must be text.");
      const query = options.query === undefined ? undefined : options.query.trim();
      if (query !== undefined && query.length > QUERY_MAX) return failArgs(`A query is at most ${QUERY_MAX} characters.`);
      const offsetLine = options.offsetLine;
      if (offsetLine !== undefined && (typeof offsetLine !== "number" || !Number.isSafeInteger(offsetLine) || offsetLine < 1)) {
        return failArgs("offsetLine must be a whole line number from 1.");
      }
      if (options.maxLines !== undefined && (typeof options.maxLines !== "number" || !Number.isSafeInteger(options.maxLines) || options.maxLines < 1)) {
        return failArgs("maxLines must be a whole number from 1.");
      }
      if (query !== undefined && query !== "" && offsetLine !== undefined) {
        return failArgs("Give query, or offsetLine, not both.");
      }
      if (!existsSync(root)) {
        return { ok: false, code: "not_synced", reason: "No Capabilities/ sheets have been synced to this host yet, so there is nothing to read." };
      }
      const file = fileOf(root, relative);
      if (!existsSync(file) || !statSync(file).isFile()) {
        return { ok: false, code: "not_found", reason: `There is no ${relative} among the synced Capabilities/ sheets.` };
      }
      const lines = splitLines(readFileSync(file, "utf8"));
      const maxLines = Math.min(options.maxLines ?? MAX_READ_LINES, MAX_READ_LINES);
      if (query !== undefined && query !== "") {
        const needle = query.toLowerCase();
        const matched: CapabilityLine[] = [];
        lines.forEach((text, index) => {
          if (text.toLowerCase().includes(needle)) matched.push({ line: index + 1, text });
        });
        return { ok: true, path: relative, totalLines: lines.length, lines: matched.slice(0, maxLines), matched: matched.length };
      }
      const from = offsetLine ?? 1;
      const block = lines.slice(from - 1, from - 1 + maxLines).map((text, index) => ({ line: from + index, text }));
      const lastShown = from - 1 + block.length;
      return {
        ok: true, path: relative, totalLines: lines.length, fromLine: from, lines: block,
        ...(lastShown < lines.length ? { nextLine: lastShown + 1 } : {}),
      };
    },

    writeOverview(path, text) {
      let relative: string;
      try {
        relative = overviewPath(path);
      } catch (error) {
        return badPath(error, "written");
      }
      if (typeof text !== "string" || text.trim() === "") {
        return { ok: false, code: "bad_text", reason: "An overview must be markdown text, and it was empty." };
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > OVERVIEW_BYTES_MAX) {
        return { ok: false, code: "too_large", reason: `An overview is at most ${OVERVIEW_BYTES_MAX / 1024} KiB; this one is ${bytes} bytes.` };
      }
      writeFileAtomic(fileOf(root, relative), text, { mkdir: true });
      return { ok: true, path: relative, bytes };
    },
  };
}

/** The file for a path already checked segment by segment, so it stays inside the folder. */
function fileOf(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

function failArgs(reason: string): { ok: false; code: "bad_args"; reason: string } {
  return { ok: false, code: "bad_args", reason };
}

function badPath(error: unknown, what: "read" | "written"): { ok: false; code: "bad_path"; reason: string } {
  const code = error instanceof WireError ? error.code : "bad_path";
  return {
    ok: false, code: "bad_path",
    reason: `A capability path must be a relative .md path inside Capabilities/, with no empty, "." or ".." segment (${code}). Nothing was ${what}.`,
  };
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every sheet in the folder, as relative paths with "/" between segments, in a stable order. */
function sheetPaths(root: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, prefix: string): void => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), relative);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(relative);
    }
  };
  walk(root, "");
  return found.sort();
}
