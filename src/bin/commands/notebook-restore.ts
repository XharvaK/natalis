// `natalis notebook-restore --dir <entity folder> --commit <sha> --reason "<line>" [--force]`: the summoner puts the notebook's
// files back as they stood at an earlier commit. It is one new commit by the summoner; no history is removed. It refuses
// unless state.json shows the Lar's last stop was clean (a running Lar writes its own notes, and two writers would split
// her memory). --force skips that check, for a Lar known to be down after a crash.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLarLock, type LarLock } from "../../entity/lar-lock.js";
import { STATE_FILE } from "../../entity/runtime.js";
import { NOTEBOOK_DIR } from "../../import/folder.js";
import { restoreNotebookTo } from "../../notebook/restore.js";
import { parseFlags, requireFlag, UsageError } from "./shared.js";

export const NOTEBOOK_RESTORE_USAGE = 'Usage: natalis notebook-restore --dir <entity folder> --commit <sha> --reason "<line>" [--force]';

export async function notebookRestoreCommand(args: string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  let dir: string, commit: string, reason: string, force: boolean;
  try {
    const flags = parseFlags(args, ["--dir", "--commit", "--reason"], ["--force"]);
    dir = resolve(requireFlag(flags, "--dir"));
    commit = requireFlag(flags, "--commit");
    reason = requireFlag(flags, "--reason");
    force = flags.switches.has("--force");
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(NOTEBOOK_RESTORE_USAGE);
      return 2;
    }
    throw e;
  }
  // The lock comes first and is held for the whole restore. --force skips only the clean-stop check, never this.
  let lock: LarLock;
  try {
    lock = acquireLarLock(dir);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  try {
    if (!force && !stoppedCleanly(dir)) {
      err(`${STATE_FILE} does not show a clean stop, so the Lar may be running. Stop it with natalis stop and let it end, then run this again; or give --force if you know it is down.`);
      return 1;
    }
    try {
      const result = await restoreNotebookTo(join(dir, NOTEBOOK_DIR), commit, reason);
      if (result.files === 0) out(`The notebook already matches ${result.from.slice(0, 12)}; nothing changed.`);
      else out(`Restored ${result.files} file(s) to ${result.from.slice(0, 12)} as commit ${result.commit.slice(0, 12)}.`);
      out("If the Lar was running, restart it so it reads its notes fresh.");
      return 0;
    } catch (e) {
      err(e instanceof Error ? e.message : String(e));
      return 1;
    }
  } finally {
    lock.release();
  }
}

/** True only when state.json reads and says the body's last stop was its own. */
function stoppedCleanly(dir: string): boolean {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { stoppedCleanly?: unknown }).stoppedCleanly === true;
  } catch {
    return false;
  }
}
