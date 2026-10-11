// `natalis unseal --from <file.natalisbak> --to <dir> --key-env <NAME>`: opens one sealed package into a normal backup
// folder, the kind `natalis restore --from` takes. The key comes from the named environment variable, never from the
// command line. The package is checked first (the GCM tag, then every file's size and hash), then the files are written
// into a temporary sibling folder, which must check against its own manifest. Only then is it put in place. A wrong key
// or a damaged package writes nothing. The target must be missing or empty, so nothing is overwritten.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { checkFilesAgainst, errorText, readManifest } from "./backup-format.js";
import { openSealedBytes, readSealKey, requireKeyName, type OpenedPackage } from "./backup-seal.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const UNSEAL_USAGE = "Usage: natalis unseal --from <file.natalisbak> --to <dir> --key-env <NAME>";

export type UnsealOptions = {
  /** A sealed package made by natalis backup --seal-to. Read only. */
  from: string;
  /** The folder to unseal into. Must be missing or empty. */
  to: string;
  /** The 32-byte key the package was sealed with. */
  key: Buffer;
  /** One plain line per step. */
  say: (line: string) => void;
};

export type UnsealResult = { dir: string; lar: string; stamp: string; files: number };

/** Opens a sealed package into `to`. Throws a plain error on any failure, and leaves no half-built folder behind. */
export function unsealEntity(options: UnsealOptions): UnsealResult {
  const from = resolve(options.from);
  const dir = resolve(options.to);
  const say = options.say;

  checkTarget(dir);
  let bytes: Buffer;
  try {
    bytes = readFileSync(from);
  } catch (err) {
    throw new Error(`${from} could not be read (${errorText(err)}). Nothing was written.`);
  }
  say(`Read ${basename(from)} (${bytes.length} bytes).`);

  let opened: OpenedPackage;
  try {
    opened = openSealedBytes(bytes, options.key);
  } catch (err) {
    throw new Error(`${errorText(err)} Nothing was written.`);
  }
  say(`Opened the package with the key: tag ok, ${opened.entries.length} files, every hash ok.`);

  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${basename(dir)}-unseal-${randomUUID().slice(0, 8)}.partial`);
  mkdirSync(stage, { mode: 0o700 });

  try {
    const stageRoot = resolve(stage);
    for (const entry of opened.entries) {
      const target = resolve(stage, entry.path);
      if (!target.startsWith(`${stageRoot}${sep}`)) throw new Error(`${entry.path} would land outside the folder. Nothing was written.`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, entry.content, { mode: 0o600 });
      say(`Wrote ${entry.path}.`);
    }

    const manifest = readManifest(stage);
    if (manifest.entity !== opened.header.lar) {
      throw new Error(`The package is named for ${opened.header.lar}, but its manifest says ${manifest.entity}. Nothing was written.`);
    }
    checkFilesAgainst(stage, manifest);
    say(`Checked the folder against its manifest: ${manifest.files.length} files.`);

    if (existsSync(dir)) rmdirSync(dir);
    renameSync(stage, dir);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
  say(`Unsealed into ${dir}. Restore it with: natalis restore --from ${dir} --dir <new folder>`);
  return { dir, lar: opened.header.lar, stamp: opened.header.stamp, files: opened.entries.length };
}

/** The target must not exist yet, or exist as an empty folder. Anything else is refused, so nothing is overwritten. */
function checkTarget(dir: string): void {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder. Choose a new folder for the unseal.`);
  if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty. Choose a new folder: an unseal never overwrites.`);
}

/** `natalis unseal` as the command line runs it. Returns the exit code. */
export async function unsealCommand(args: readonly string[]): Promise<number> {
  return runCommand(UNSEAL_USAGE, async () => {
    const flags = parseFlags([...args], ["--from", "--to", "--key-env"], []);
    const from = requireFlag(flags, "--from");
    const to = requireFlag(flags, "--to");
    const keyName = requireKeyName(requireFlag(flags, "--key-env"));
    const key = readSealKey(keyName);
    unsealEntity({ from, to, key, say: (line) => console.log(line) });
    return 0;
  });
}
