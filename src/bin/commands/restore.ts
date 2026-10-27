// `natalis restore --from <backup folder> --dir <new entity folder>`: rebuilds a Lar from one backup. The backup's
// manifest and every hash are checked before anything is written. The target folder must be missing or empty, except
// that it may hold today's grants.db: permissions are never restored from a backup, so a restore keeps the file that
// holds the Owner's current grants and refusals, drops its unused once grants, and logs each drop. The notebook is
// cloned from its bundle, and the river and notebook are checked against the manifest before the new folder is put in
// place. A restored Lar keeps the emergency stop the backup had (its state file says so), and gets a note in its river
// with the backup's time. The env file that holds its keys is not in the backup and is kept on the host beside the
// folder.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { FOLDER_HASH_KEY, folderHash } from "../../entity/copy-guard.js";
import { GRANTS_FILE, grantsPath, openGrants } from "../../entity/grants.js";
import { acquireLarLock, LAR_LOCK_DATABASE_FILE, LAR_LOCK_INFO_FILE, type LarLock } from "../../entity/lar-lock.js";
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

/**
 * Rebuilds a Lar into `dir`. Holds the target folder's lock for the whole run, so a second restore or a run on it is
 * refused meanwhile. Throws a plain error on any failure and leaves no half-built folder behind.
 */
export async function restoreEntity(options: RestoreOptions): Promise<RestoreResult> {
  const from = resolve(options.from);
  const dir = resolve(options.dir);
  const say = options.say;

  const manifest = readManifest(from);
  say(`Read the manifest: ${manifest.entity}, made ${manifest.createdAt}, river last seq ${manifest.riverLastSeq}.`);
  checkFilesAgainst(from, manifest);
  say(`Checked ${manifest.files.length} files against their hashes.`);

  checkTarget(dir);
  const existed = existsSync(dir);
  // The target folder is the Lar that will exist here, so its lock is taken before anything is written. A second
  // restore, or a run on the same folder, is refused with the lock's busy message.
  mkdirSync(dir, { recursive: true });
  let lock: LarLock;
  try {
    lock = acquireLarLock(dir);
  } catch (error) {
    // A folder made only for this attempt is removed again; a holder's lock files are left where they are.
    if (!existed) {
      try {
        rmdirSync(dir);
      } catch {
        // Another holder already put its lock files in the folder.
      }
    }
    throw error;
  }

  const parent = dirname(dir);
  const stage = join(parent, `.${basename(dir)}-restore-${randomUUID().slice(0, 8)}.partial`);

  try {
    try {
      mkdirSync(stage);
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
      // The checked folder moves into the locked Lar folder. Nothing is visible to a second process halfway.
      for (const entry of readdirSync(stage)) renameSync(join(stage, entry), join(dir, entry));
      rmdirSync(stage);
      // Today's grants.db is never overwritten: a target may hold it, and a target without one starts empty. An
      // unused once grant was given for a call that the restore did not keep, so it is dropped and logged.
      const keptGrants = existsSync(grantsPath(dir));
      const grants = openGrants(dir);
      let dropped = 0;
      try {
        dropped = grants.dropUnusedOnce(Date.now()).length;
      } finally {
        grants.close();
      }
      say(
        keptGrants
          ? `Kept today's grants.db: dropped ${dropped} unused once grant(s).`
          : "Started an empty grants.db: every ask tool asks again.",
      );
      recordRestoredFolder(dir);
      noteRestore(dir, manifest.createdAt, stopWasOn);
      if (stopWasOn) say("Your summoner's emergency stop was on in the backup, so it is on in the restore.");
      say(`Restored into ${dir}. Start it with natalis run, or with the service unit in deploy/.`);
      return { dir, manifest };
    } finally {
      lock.release();
    }
  } catch (err) {
    rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
    // The target was empty before this restore, except for a kept grants.db, so only what this attempt wrote is
    // removed. The kept grants.db is today's permissions and is never deleted by a failed restore.
    if (existed) {
      for (const entry of readdirSync(dir)) {
        if (entry === GRANTS_FILE || entry === `${GRANTS_FILE}-journal`) continue;
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    } else {
      rmSync(dir, { recursive: true, force: true });
    }
    throw err;
  }
}

/** Whether the state file a backup kept has the emergency stop on. A state file that does not say so is read as off. */
function stopOnIn(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { stopOn?: unknown };
  return state.stopOn === true;
}

/**
 * A restore is an explicit copy made by this Lar's owner into a folder they chose, so it does not trip the copy
 * guard later. The restored state records the new folder; a folder with no state gets its hash on its first start.
 */
function recordRestoredFolder(dir: string): void {
  const statePath = join(dir, STATE_FILE);
  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  state[FOLDER_HASH_KEY] = folderHash(dir);
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, statePath);
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

/**
 * The target must not exist yet, or be empty except perhaps for today's grants.db. Anything else is refused, so no
 * note, river or configuration is overwritten. The lock's own files are not the target's contents: they are a
 * holder's, and a held lock is refused by acquiring.
 */
function checkTarget(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder. Choose a new folder for the restore.`);
  const entries = readdirSync(dir).filter(
    (name) =>
      name !== LAR_LOCK_DATABASE_FILE &&
      name !== `${LAR_LOCK_DATABASE_FILE}-journal` &&
      name !== LAR_LOCK_INFO_FILE &&
      name !== GRANTS_FILE &&
      name !== `${GRANTS_FILE}-journal`,
  );
  if (entries.length > 0) throw new Error(`${dir} is not empty. Choose a new folder: a restore never overwrites.`);
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
