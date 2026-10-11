// `natalis restore --from <backup folder> --dir <new entity folder>`: rebuilds a Lar from one backup. The backup's
// manifest and every hash are checked before anything is written. The target folder must be missing or empty. The
// notebook is cloned from its bundle, and the river and notebook are checked against the manifest before the new
// folder is put in place. A restored Lar starts with its emergency stop off; the env file that holds its keys is not
// in the backup and is kept on the host beside the folder.

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { NOTEBOOK_DIR, RIVER_FILE } from "../../import/folder.js";
import {
  BUNDLE_FILE,
  checkFilesAgainst,
  git,
  readManifest,
  readRiverLastSeq,
  type Manifest,
} from "./backup-format.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const RESTORE_USAGE = "Usage: natalis restore --from <backup folder> --dir <new entity folder>";

export type RestoreOptions = {
  /** A backup folder made by natalis backup. Read only. */
  from: string;
  /** The folder to rebuild into. Must be missing or empty. */
  dir: string;
  /** One plain line per step. */
  say: (line: string) => void;
};

export type RestoreResult = { dir: string; manifest: Manifest };

/** Rebuilds a Lar into `dir`. Throws a plain error on any failure and leaves no half-built folder behind. */
export async function restoreEntity(options: RestoreOptions): Promise<RestoreResult> {
  const from = resolve(options.from);
  const dir = resolve(options.dir);
  const say = options.say;

  const manifest = readManifest(from);
  say(`Read the manifest: ${manifest.entity}, made ${manifest.createdAt}, river last seq ${manifest.riverLastSeq}.`);
  checkFilesAgainst(from, manifest);
  say(`Checked ${manifest.files.length} files against their hashes.`);

  checkTarget(dir);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${basename(dir)}-restore-${randomUUID().slice(0, 8)}.partial`);
  mkdirSync(stage);

  try {
    for (const file of manifest.files) {
      if (file.name === BUNDLE_FILE) continue;
      copyFileSync(join(from, file.name), join(stage, file.name));
      say(`Restored ${file.name}.`);
    }

    const bundle = join(from, BUNDLE_FILE);
    const notebook = join(stage, NOTEBOOK_DIR);
    await git(undefined, ["clone", "--quiet", bundle, notebook]);
    // The clone remembers the bundle as its origin. A restored notebook has no remote, so that link is removed.
    if ((await git(notebook, ["remote"])).split("\n").includes("origin")) {
      await git(notebook, ["remote", "remove", "origin"]);
    }
    const head = await git(notebook, ["rev-parse", "--verify", "HEAD"]);
    if (head !== manifest.notebookHead) {
      throw new Error(`The restored notebook is at ${head.slice(0, 12)}, but the manifest says ${manifest.notebookHead.slice(0, 12)}. Not keeping it.`);
    }
    say(`Rebuilt the notebook from its bundle at ${head.slice(0, 12)}.`);

    const seq = readRiverLastSeq(join(stage, RIVER_FILE));
    if (seq !== manifest.riverLastSeq) {
      throw new Error(`The restored river ends at seq ${seq}, but the manifest says ${manifest.riverLastSeq}. Not keeping it.`);
    }
    say(`Checked the restored river: last seq ${seq}, as the manifest says.`);

    if (existsSync(dir)) rmdirSync(dir);
    renameSync(stage, dir);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
  say(`Restored into ${dir}. Start it with natalis run, or with the service unit in deploy/.`);
  return { dir, manifest };
}

/** The target must not exist yet, or exist as an empty folder. Anything else is refused, so nothing is overwritten. */
function checkTarget(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder. Choose a new folder for the restore.`);
  if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty. Choose a new folder: a restore never overwrites.`);
}

/** `natalis restore` as the command line runs it. Returns the exit code. */
export async function restoreCommand(args: readonly string[]): Promise<number> {
  return runCommand(RESTORE_USAGE, async () => {
    const flags = parseFlags([...args], ["--from", "--dir"], []);
    const from = requireFlag(flags, "--from");
    const dir = requireFlag(flags, "--dir");
    await restoreEntity({ from, dir, say: (line) => console.log(line) });
    return 0;
  });
}
