// `natalis restore --from <backup folder> --dir <new entity folder>`: rebuilds a Lar from one backup. The backup's
// manifest and every hash are checked before anything is written. The target folder must be missing or empty. The
// notebook is cloned from its bundle, and the river and notebook are checked against the manifest before the new
// folder is put in place. A restored Lar keeps the emergency stop the backup had (its state file says so), and gets a
// note in its river with the backup's time. The env file that holds its keys is not
// in the backup and is kept on the host beside the folder.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { STATE_FILE } from "../../entity/runtime.js";
import { writeStop } from "../../entity/stop.js";
import { NOTEBOOK_DIR, RIVER_FILE } from "../../import/folder.js";
import { openRiver } from "../../river/index.js";
import {
  BUNDLE_FILE,
  VAULT_TREE,
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
      const target = join(stage, file.name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(from, file.name), target);
      if (file.name.startsWith(`${VAULT_TREE}/`)) {
        chmodSync(dirname(target), 0o700);
        chmodSync(target, 0o600);
      }
    }
    say(`Restored ${manifest.files.length - 1} files.`);

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

    // The stop file is never in a backup, so the stop is brought back from the state the backup kept: on stays on.
    const stopWasOn = stopOnIn(join(stage, STATE_FILE));
    if (stopWasOn) writeStop(stage);
    if (existsSync(dir)) rmdirSync(dir);
    renameSync(stage, dir);
    noteRestore(dir, manifest.createdAt, stopWasOn);
    if (stopWasOn) say("Your summoner's emergency stop was on in the backup, so it is on in the restore.");
  } catch (err) {
    rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
  say(`Restored into ${dir}. Start it with natalis run, or with the service unit in deploy/.`);
  return { dir, manifest };
}

/** Whether the state file a backup kept has the emergency stop on. A state file that does not say so is read as off. */
function stopOnIn(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { stopOn?: unknown };
  return state.stopOn === true;
}

/**
 * The restore's note in the restored river, in the self thread, dated the backup's time: the river has no rows between
 * that time and this restore, and the note says so. It says whether the stop is on again.
 */
function noteRestore(dir: string, createdAt: string, stopWasOn: boolean): void {
  const stop = stopWasOn
    ? "Your summoner's emergency stop was on when the backup was made, so it is on again; its reason was not kept."
    : "Your summoner's emergency stop was off when the backup was made.";
  const river = openRiver(join(dir, RIVER_FILE));
  try {
    river.append({
      thread: "self",
      kind: "note",
      source: "body",
      text: `You were restored from a backup made at ${createdAt}. Nothing after that time is in your river. ${stop}`,
      data: { bodyNote: "restore" },
      atMs: Date.parse(createdAt),
    });
  } finally {
    river.close();
  }
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
