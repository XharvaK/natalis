// `natalis backup --dir <entity folder> --out <folder> [--keep <n>]`: one dated backup of a Lar, made while it may be
// running. The folder <out>/<entity-folder-name>-<YYYYMMDD-HHMMSS>/ holds river.db (a consistent copy made by SQLite,
// never a plain file copy), notebook.bundle (the whole notebook as a git bundle), copies of the small files beside
// the river, and MANIFEST.json with sizes and hashes. The backup is written under a temporary name and renamed only
// after it checks out. With --keep n, the oldest backups of this Lar beyond n are removed.

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NOTEBOOK_DIR, RIVER_FILE } from "../../import/folder.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BUNDLE_FILE,
  MANIFEST_FILE,
  PLAIN_FILES,
  formatStamp,
  git,
  hasEnvName,
  readRiverLastSeq,
  sha256File,
  type Manifest,
  type ManifestFile,
} from "./backup-format.js";
import { parseFlags, requireFlag, runCommand, UsageError } from "./shared.js";

export const BACKUP_USAGE = "Usage: natalis backup --dir <entity folder> --out <folder> [--keep <n>]";

export type BackupOptions = {
  /** The Lar's own folder. Read only. */
  dir: string;
  /** The folder the dated backup goes into. Created if missing. */
  out: string;
  /** Keep this many of the newest backups of this Lar. Older ones are removed. Omit to keep all. */
  keep?: number;
  /** The time the backup is named for. Defaults to now. */
  now?: Date;
  /** One plain line per step. */
  say: (line: string) => void;
};

export type BackupResult = { folder: string; manifest: Manifest; removed: string[] };

/** Makes a backup. Throws a plain error on any failure, and leaves no half-written folder behind. */
export async function backupEntity(options: BackupOptions): Promise<BackupResult> {
  const dir = resolve(options.dir);
  const out = resolve(options.out);
  const name = basename(dir);
  const say = options.say;
  if (!existsSync(join(dir, RIVER_FILE))) throw new Error(`No ${RIVER_FILE} in ${dir}. Give the Lar's own folder.`);
  const notebook = join(dir, NOTEBOOK_DIR);
  if (!existsSync(join(notebook, ".git"))) throw new Error(`No notebook in ${dir}. Start the Lar once before backing it up.`);

  const now = options.now ?? new Date();
  const folder = join(out, `${name}-${formatStamp(now)}`);
  if (existsSync(folder)) throw new Error(`${folder} already exists. Wait a second and try again.`);
  mkdirSync(out, { recursive: true });
  const partial = join(out, `.${name}-${formatStamp(now)}-${randomUUID().slice(0, 8)}.partial`);
  mkdirSync(partial);

  try {
    const files: ManifestFile[] = [];
    const bundle = join(partial, BUNDLE_FILE);
    const riverCopy = join(partial, RIVER_FILE);

    // The small files first, then the river. The Lar writes its river before it updates state.json, so a state file
    // read before the river copy never points past the rows that copy holds.
    const plainNames: string[] = [];
    for (const file of PLAIN_FILES) {
      if (hasEnvName(file)) continue;
      if (!existsSync(join(dir, file))) continue;
      copyFileSync(join(dir, file), join(partial, file));
      plainNames.push(file);
      say(`Copied ${file}.`);
    }

    const riverLastSeq = snapshotRiver(join(dir, RIVER_FILE), riverCopy);
    say(`Copied ${RIVER_FILE} as a consistent snapshot (last seq ${riverLastSeq}).`);

    const notebookHead = await notebookHeadOf(notebook);
    await git(notebook, ["bundle", "create", bundle, "--all"]);
    say(`Bundled the notebook at ${notebookHead.slice(0, 12)}.`);

    for (const file of [RIVER_FILE, BUNDLE_FILE, ...plainNames]) {
      files.push(describeFile(partial, file));
    }

    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      entity: name,
      createdAt: now.toISOString(),
      riverLastSeq,
      notebookHead,
      files,
    };
    writeFileSync(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    say(`Wrote ${MANIFEST_FILE} with ${files.length} files and their hashes.`);

    const copiedSeq = readRiverLastSeq(riverCopy);
    if (copiedSeq !== riverLastSeq) {
      throw new Error(`The copied river ends at seq ${copiedSeq}, but the manifest says ${riverLastSeq}. Nothing was kept.`);
    }
    say(`Checked the copied river: opens read-only, last seq ${copiedSeq} as the manifest says.`);

    await git(notebook, ["bundle", "verify", bundle]);
    say("Checked the notebook bundle with git bundle verify.");

    renameSync(partial, folder);
    say(`Backup is ready: ${folder}`);

    const removed = options.keep === undefined ? [] : pruneBackups(out, name, options.keep, say);
    return { folder, manifest, removed };
  } catch (err) {
    rmSync(partial, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
}

/**
 * Copies the river through SQLite, so the copy is one consistent snapshot even while the Lar writes. Returns the
 * copy's last seq. The source is opened read-only and never written.
 */
function snapshotRiver(source: string, target: string): number {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (err) {
    throw new Error(`Could not copy ${RIVER_FILE} (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    db.close();
  }
  return readRiverLastSeq(target);
}

function describeFile(folder: string, name: string): ManifestFile {
  const path = join(folder, name);
  return { name, bytes: statSync(path).size, sha256: sha256File(path) };
}

async function notebookHeadOf(notebook: string): Promise<string> {
  try {
    const head = await git(notebook, ["rev-parse", "--verify", "HEAD"]);
    if (head !== "") return head;
  } catch {
    // Handled below: a notebook with no commit has nothing to back up.
  }
  throw new Error("The notebook has no commits yet, so there is nothing to back up.");
}

/**
 * Removes the oldest backups of this Lar beyond `keep`. Only folders named exactly as a backup of this Lar is named
 * are counted, so a similar folder beside them is never touched. Returns the names removed, oldest first.
 */
export function pruneBackups(out: string, name: string, keep: number, say: (line: string) => void): string[] {
  const pattern = new RegExp(`^${escapeRegExp(name)}-\\d{8}-\\d{6}$`);
  const folders = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const surplus = folders.slice(0, Math.max(0, folders.length - keep));
  for (const folder of surplus) {
    rmSync(join(out, folder), { recursive: true, force: true, maxRetries: 5 });
    say(`Removed old backup ${folder}.`);
  }
  return surplus;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `natalis backup` as the command line runs it. Returns the exit code. */
export async function backupCommand(args: readonly string[]): Promise<number> {
  return runCommand(BACKUP_USAGE, async () => {
    const flags = parseFlags([...args], ["--dir", "--out", "--keep"], []);
    const dir = requireFlag(flags, "--dir");
    const out = requireFlag(flags, "--out");
    const keep = parseKeep(flags.values.get("--keep"));
    await backupEntity({ dir, out, keep, say: (line) => console.log(line) });
    return 0;
  });
}

export function parseKeep(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError("--keep needs a whole number, 1 or more.");
  return Number(value);
}
