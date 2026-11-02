// Files people send that are not pictures go into the Lar's home folder, in its files/ subfolder, where her sandbox
// sees them. The body never opens them and never judges what they are. It caps the size, keeps the name plain, never
// overwrites a file, and never writes through a link the Lar may have made inside her home.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A file is at most this large. */
export const FILE_BYTES_MAX = 25 * 1024 * 1024;
export const FILES_FOLDER = "files";
/** Names are clipped to this many characters before the extension. */
const STEM_MAX = 80;
/** How many "-2", "-3" ... names are tried before a name counts as taken. */
const SAME_NAME_MAX = 100;

/** The Lar's home folder on the host, and the same folder as the Lar sees it (inside her sandbox). */
export type FilesHome = { dir: string; shownAs: string };

/** A name a shell takes as it is: letters, digits, dot, dash and underscore, never starting with a dot. */
export function plainFileName(name: string): { stem: string; extension: string } {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  const match = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(clean);
  const stem = (match?.[1] ?? "").replace(/[._]+$/, "").slice(0, STEM_MAX);
  return { stem: stem || "file", extension: (match?.[2] ?? "").toLowerCase() };
}

/**
 * Writes one file into the home's files/ folder and says where the Lar finds it. A name that is taken gets "-2", "-3"
 * and so on. Throws a plain error when the folder is a link or not a folder, or when the file cannot be written.
 */
export function saveFile(home: FilesHome, name: string, bytes: Uint8Array): { shownAt: string; name: string } {
  if (bytes.length > FILE_BYTES_MAX) throw new Error(`it is larger than ${FILE_BYTES_MAX / 1024 / 1024} MiB`);
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  const folder = join(home.dir, FILES_FOLDER);
  const found = lstatOrUndefined(folder);
  if (found === undefined) mkdirSync(folder, { mode: 0o700 });
  else if (found.isSymbolicLink() || !found.isDirectory()) {
    throw new Error(`${FILES_FOLDER} in your home is not a plain folder, so nothing was written there`);
  }
  // B-1: the folder is opened once, without following a link, and every write goes through that open folder. A swap
  // the sandbox makes after this point cannot send the file anywhere else on the host.
  let fd: number;
  try {
    fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${FILES_FOLDER} in your home is not a plain folder, so nothing was written there`);
  }
  try {
    // The open folder must be the one at realpath(home)/files, so a link higher up cannot send the file elsewhere.
    const opened = fstatSync(fd);
    const expected = lstatOrUndefined(join(realpathSync(home.dir), FILES_FOLDER));
    if (expected === undefined || !expected.isDirectory() || expected.dev !== opened.dev || expected.ino !== opened.ino) {
      throw new Error(`${FILES_FOLDER} in your home leads somewhere else, so nothing was written there`);
    }
    const base = process.platform === "linux" ? `/proc/self/fd/${fd}` : folder;
    const { stem, extension } = plainFileName(name);
    for (let n = 1; n <= SAME_NAME_MAX; n++) {
      const candidate = n === 1 ? `${stem}${extension}` : `${stem}-${n}${extension}`;
      try {
        // "wx" never replaces a file and never follows a link that is already there.
        writeFileSync(`${base}/${candidate}`, bytes, { flag: "wx", mode: 0o600 });
        return { shownAt: `${home.shownAs.replace(/\/+$/, "")}/${FILES_FOLDER}/${candidate}`, name: candidate };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw new Error("it could not be written into your home");
      }
    }
  } finally {
    closeSync(fd);
  }
  throw new Error(`${SAME_NAME_MAX} files with that name are already in your home`);
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
