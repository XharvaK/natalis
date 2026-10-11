// `natalis backup --dir <entity folder> --out <folder> [--keep <n>]`: one dated backup of a Lar, made while it may be
// running. The folder <out>/<entity-folder-name>-<YYYYMMDD-HHMMSS>/ holds river.db (a consistent copy made by SQLite,
// never a plain file copy), notebook.bundle (the whole notebook as a git bundle), copies of the small files beside
// the river, and MANIFEST.json with sizes and hashes. The backup is written under a temporary name and renamed only
// after it checks out. With --keep n, the oldest backups of this Lar beyond n are removed. With --seal-to <dir> and
// --key-env <NAME>, the checked folder is also sealed into one encrypted package in <dir> (see backup-seal.ts), and
// --seal-keep n keeps the newest n sealed packages of this Lar.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NOTEBOOK_DIR, RIVER_FILE } from "../../import/folder.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BUNDLE_FILE,
  DOMUS_DB_PATH,
  DOMUS_STATE_PATH,
  HOME_SKIPPED,
  HOME_TREE,
  isAllowedName,
  MANIFEST_FILE,
  PLAIN_FILES,
  MEDIA_TREE,
  VAULT_TREE,
  formatStamp,
  git,
  errorText,
  isEnvFileName,
  readRiverLastSeq,
  sha256File,
  type Manifest,
  type ManifestFile,
} from "./backup-format.js";
import {
  assertSealableLar,
  readSealKey,
  requireKeyName,
  sealFolder,
  type SealFolderResult,
  type SealOptions,
} from "./backup-seal.js";
import { parseFlags, requireFlag, runCommand, UsageError, type ParsedFlags } from "./shared.js";

export const BACKUP_USAGE =
  "Usage: natalis backup --dir <entity folder> --out <folder> [--keep <n>] [--seal-to <folder> --key-env <NAME> [--seal-keep <n>]]";

export type BackupOptions = {
  /** The Lar's own folder. Read only. */
  dir: string;
  /** The folder the dated backup goes into. Created if missing. */
  out: string;
  /** Keep this many of the newest backups of this Lar. Older ones are removed. Omit to keep all. */
  keep?: number;
  /** Also seal the checked folder into one encrypted package. Omit to leave the backup unsealed. */
  seal?: SealOptions;
  /** The time the backup is named for. Defaults to now. */
  now?: Date;
  /** One plain line per step. */
  say: (line: string) => void;
};

export type BackupResult = { folder: string; manifest: Manifest; removed: string[]; sealed?: SealFolderResult };

/** Makes a backup. Throws a plain error on any failure, and leaves no half-written folder behind. */
export async function backupEntity(options: BackupOptions): Promise<BackupResult> {
  const dir = resolve(options.dir);
  const out = resolve(options.out);
  const name = basename(dir);
  const say = options.say;
  if (!existsSync(join(dir, RIVER_FILE))) throw new Error(`No ${RIVER_FILE} in ${dir}. Give the Lar's own folder.`);
  const notebook = join(dir, NOTEBOOK_DIR);
  if (!existsSync(join(notebook, ".git"))) throw new Error(`No notebook in ${dir}. Start the Lar once before backing it up.`);
  // A sealed package carries the folder's name, so a name it cannot carry is refused before anything is written.
  if (options.seal !== undefined) assertSealableLar(name);

  const now = options.now ?? new Date();
  const folder = join(out, `${name}-${formatStamp(now)}`);
  if (existsSync(folder)) throw new Error(`${folder} already exists. Wait a second and try again.`);
  mkdirSync(out, { recursive: true });
  const partial = join(out, `.${name}-${formatStamp(now)}-${randomUUID().slice(0, 8)}.partial`);
  // Owner-only: a backup can hold the vault.
  mkdirSync(partial, { mode: 0o700 });

  try {
    const files: ManifestFile[] = [];
    const bundle = join(partial, BUNDLE_FILE);
    const riverCopy = join(partial, RIVER_FILE);

    // The small files first, then the river. The Lar writes its river before it updates state.json, so a state file
    // read before the river copy never points past the rows that copy holds.
    const plainNames: string[] = [];
    for (const file of PLAIN_FILES) {
      if (isEnvFileName(file)) continue;
      if (!existsSync(join(dir, file))) continue;
      copyFileSync(join(dir, file), join(partial, file));
      plainNames.push(file);
      say(`Copied ${file}.`);
    }

    const riverLastSeq = snapshotRiver(join(dir, RIVER_FILE), riverCopy);
    say(`Copied ${RIVER_FILE} as a consistent snapshot (last seq ${riverLastSeq}).`);

    // The worlds' own things: the game's database (a snapshot, like the river) and heartbeat file, the vault, the home.
    if (existsSync(join(dir, DOMUS_DB_PATH))) {
      mkdirSync(join(partial, dirname(DOMUS_DB_PATH)), { recursive: true });
      snapshotSqlite(join(dir, DOMUS_DB_PATH), join(partial, DOMUS_DB_PATH));
      plainNames.push(DOMUS_DB_PATH);
      say(`Copied ${DOMUS_DB_PATH} as a consistent snapshot.`);
    }
    if (existsSync(join(dir, DOMUS_STATE_PATH))) {
      mkdirSync(join(partial, dirname(DOMUS_STATE_PATH)), { recursive: true });
      copyFileSync(join(dir, DOMUS_STATE_PATH), join(partial, DOMUS_STATE_PATH));
      plainNames.push(DOMUS_STATE_PATH);
    }
    // The vault is not in a plain backup: it holds the web's secret values, so only a sealed package carries it.
    const mediaNames = copyTree(dir, partial, MEDIA_TREE, () => true);
    if (mediaNames.length > 0) say(`Copied the shelf of pictures (${mediaNames.length} files).`);
    const homeNames = copyTree(dir, partial, HOME_TREE, (rel) => !HOME_SKIPPED.has(rel.split("/")[1] ?? ""));
    if (homeNames.length > 0) say(`Copied the home (${homeNames.length} files).`);
    plainNames.push(...mediaNames, ...homeNames);

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

    let sealed: SealFolderResult | undefined;
    if (options.seal !== undefined) {
      try {
        // The package carries the vault too. Its manifest lists the vault's files with their hashes, so a restore from
        // the opened package brings the vault back; the plain folder's manifest stays as it is.
        const vault = vaultFiles(dir);
        if (vault.length > 0) say(`Read the vault (${vault.length} entries) for the sealed package.`);
        const sealedManifest: Manifest = {
          ...manifest,
          files: [...manifest.files, ...vault.map((entry) => ({ name: entry.path, bytes: entry.content.length, sha256: sha256Of(entry.content) }))],
        };
        sealed = sealFolder({
          folder,
          lar: name,
          stamp: formatStamp(now),
          key: options.seal.key,
          out: resolve(options.seal.dir),
          keep: options.seal.keep,
          say,
          add: vault,
          replace: { [MANIFEST_FILE]: Buffer.from(`${JSON.stringify(sealedManifest, null, 2)}
`, "utf8") },
        });
      } catch (err) {
        throw new Error(`${errorText(err)} The backup folder ${folder} is kept.`);
      }
    }

    const removed = options.keep === undefined ? [] : pruneBackups(out, name, options.keep, say);
    return { folder, manifest, removed, sealed };
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
  snapshotSqlite(source, target);
  return readRiverLastSeq(target);
}

function snapshotSqlite(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (err) {
    throw new Error(`Could not copy ${basename(source)} (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    db.close();
  }
}

/** The vault's files as a sealed package holds them: the path inside the package and the bytes, read from the Lar's folder. */
function vaultFiles(dir: string): Array<{ path: string; content: Buffer }> {
  const root = join(dir, VAULT_TREE);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const found: Array<{ path: string; content: Buffer }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${VAULT_TREE}/${entry.name}`;
    if (entry.isFile() && isAllowedName(path)) found.push({ path, content: readFileSync(join(dir, path)) });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sha256Of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Copies the regular files of one of the Lar's folders (the home) into the backup, keeping each file's mode.
 * Symlinks and anything else that is not a plain file or folder are left out, and so is every name the manifest would
 * refuse. Returns the copied names, as the manifest lists them ("<tree>/<path>").
 */
function copyTree(dir: string, partial: string, tree: string, keep: (rel: string) => boolean): string[] {
  const root = join(dir, tree);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const copied: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (!keep(child)) continue;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && isAllowedName(child)) {
        mkdirSync(join(partial, rel), { recursive: true });
        copyFileSync(join(dir, child), join(partial, child));
        copied.push(child);
      }
    }
  };
  walk(tree);
  return copied.sort();
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
    const flags = parseFlags([...args], ["--dir", "--out", "--keep", "--seal-to", "--key-env", "--seal-keep"], []);
    const dir = requireFlag(flags, "--dir");
    const out = requireFlag(flags, "--out");
    const keep = parseKeep(flags.values.get("--keep"));
    const seal = sealOptionsFrom(flags, process.env);
    await backupEntity({ dir, out, keep, seal, say: (line) => console.log(line) });
    return 0;
  });
}

/**
 * The sealing options the flags name, or undefined when sealing is off. The key is read here, before any backup is
 * made, so a bad key fails at once. A key error is a plain failure (exit 1); a flag mix-up is a usage error (exit 2).
 */
export function sealOptionsFrom(flags: ParsedFlags, env: NodeJS.ProcessEnv): SealOptions | undefined {
  const to = flags.values.get("--seal-to");
  const keyName = flags.values.get("--key-env");
  const keepText = flags.values.get("--seal-keep");
  if (to === undefined && keyName === undefined && keepText === undefined) return undefined;
  if (to === undefined) {
    throw new UsageError(keyName === undefined ? "--seal-keep needs --seal-to." : "--key-env needs --seal-to.");
  }
  if (keyName === undefined) throw new UsageError("--seal-to needs --key-env: the name of the variable that holds the sealing key.");
  const name = requireKeyName(keyName);
  const keep = parseKeep(keepText, "--seal-keep");
  return { dir: to, key: readSealKey(name, env), keep };
}

export function parseKeep(value: string | undefined, flag = "--keep"): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${flag} needs a whole number, 1 or more.`);
  return Number(value);
}
