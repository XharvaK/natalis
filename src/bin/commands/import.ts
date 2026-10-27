// `natalis import --dir <entity> --bundle <folder> [--apply] [--skip-refused]`: brings a seed bundle into a fresh
// entity. Without --apply it prints the plan and writes nothing.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { acquireLarLock, type LarLock } from "../../entity/lar-lock.js";
import { runImport } from "../../import/index.js";
import { parseFlags, requireFlag, runCommand, scannerFor } from "./shared.js";

export const IMPORT_USAGE =
  "Usage: natalis import --dir <entity folder> --bundle <bundle folder> [--apply] [--skip-refused]";

export function importCommand(args: string[]): Promise<number> {
  return runCommand(IMPORT_USAGE, async () => {
    const flags = parseFlags(args, ["--dir", "--bundle"], ["--apply", "--skip-refused"]);
    const dir = resolve(requireFlag(flags, "--dir"));
    const bundleDir = resolve(requireFlag(flags, "--bundle"));
    const apply = flags.switches.has("--apply");
    // A dry run writes nothing, so it needs no lock. An apply is one writer on the Lar folder for its whole run.
    let lock: LarLock | undefined;
    if (apply) {
      mkdirSync(dir, { recursive: true });
      lock = acquireLarLock(dir);
    }
    try {
      const outcome = await runImport({
        dir,
        bundleDir,
        apply,
        skipRefused: flags.switches.has("--skip-refused"),
        scanner: scannerFor(dir),
      });
      for (const line of outcome.lines) console.log(line);
      return outcome.ok ? 0 : 1;
    } finally {
      lock?.release();
    }
  });
}
