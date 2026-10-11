// What the importer may see of an entity folder before it writes anything: is the river empty, and which notebook
// files exist. Reading is read-only, so a dry run leaves the folder exactly as it was.

import { existsSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ENTITY_FILE } from "../entity/config.js";
import { STATE_FILE } from "../entity/runtime.js";
import { ENTITY_LAYOUT } from "../notebook/layout.js";

export const RIVER_FILE = "river.db";
export const NOTEBOOK_DIR = "notebook";

/** Stub files the entity starts with. Same paths and purpose as the runtime's stubs; a bundle may replace them. */
const STUB_FILES = [".gitattributes", "self/constitution.md", "self/character.md"] as const;

/** Files a fresh notebook already holds. A bundle note may replace one of these; any other file is a conflict. */
export const SEEDED_NOTEBOOK_FILES: ReadonlySet<string> = new Set<string>([
  ...ENTITY_LAYOUT.map((entry) => `${entry.folder}/README.md`),
  ...STUB_FILES,
]);

export type EntityFolderFacts = {
  dir: string;
  dirExists: boolean;
  riverExists: boolean;
  /** The last seq in the river. 0 for an empty or missing river. */
  riverLastSeq: number;
  /** Set when river.db exists but could not be read. The importer will not write into it. */
  riverError?: string;
  notebookExists: boolean;
  /** Every file under notebook/ except .git, "/"-separated and sorted. */
  notebookFiles: string[];
  hasConfig: boolean;
  hasState: boolean;
};

export function readEntityFolder(dir: string): EntityFolderFacts {
  const dirExists = isDirectory(dir);
  const riverPath = join(dir, RIVER_FILE);
  const notebookPath = join(dir, NOTEBOOK_DIR);
  const facts: EntityFolderFacts = {
    dir,
    dirExists,
    riverExists: existsSync(riverPath),
    riverLastSeq: 0,
    notebookExists: isDirectory(notebookPath),
    notebookFiles: [],
    hasConfig: existsSync(join(dir, ENTITY_FILE)),
    hasState: existsSync(join(dir, STATE_FILE)),
  };
  if (facts.riverExists) {
    try {
      facts.riverLastSeq = readLastSeq(riverPath);
    } catch (err) {
      facts.riverError = err instanceof Error ? err.message : String(err);
    }
  }
  if (facts.notebookExists) facts.notebookFiles = listFiles(notebookPath, "").sort();
  return facts;
}

/** The river's last seq, read through a read-only connection. Throws when the file is not a readable river. */
function readLastSeq(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM rows").get() as { last: number } | undefined;
    return Number(row?.last ?? 0);
  } finally {
    db.close();
  }
}

function listFiles(root: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
