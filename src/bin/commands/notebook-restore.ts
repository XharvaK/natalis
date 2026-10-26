// `natalis notebook-restore --dir <entity folder> --commit <sha> --reason "<line>"`: the summoner puts the notebook's
// files back as they stood at an earlier commit. It is one new commit by the summoner; no history is removed. Stop the
// Lar first: a running Lar keeps writing its own notes.

import { join, resolve } from "node:path";
import { NOTEBOOK_DIR } from "../../import/folder.js";
import { restoreNotebookTo } from "../../notebook/restore.js";
import { parseFlags, requireFlag, UsageError } from "./shared.js";

export const NOTEBOOK_RESTORE_USAGE = 'Usage: natalis notebook-restore --dir <entity folder> --commit <sha> --reason "<line>"';

export async function notebookRestoreCommand(args: string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  let dir: string, commit: string, reason: string;
  try {
    const flags = parseFlags(args, ["--dir", "--commit", "--reason"], []);
    dir = resolve(requireFlag(flags, "--dir"));
    commit = requireFlag(flags, "--commit");
    reason = requireFlag(flags, "--reason");
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(NOTEBOOK_RESTORE_USAGE);
      return 2;
    }
    throw e;
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
}
