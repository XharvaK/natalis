// NB-B and NOTE-1: one way to replace a file whole. A new temporary file with a unique name is made with "wx" (never an
// existing file, never through a planted link), written, synced, renamed over the old one, and the folder is synced, so
// after a crash the file is the old version or the new one, never empty or cut.

import * as realFs from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export type AtomicFs = Pick<typeof realFs,
  "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync" | "mkdirSync" | "fchmodSync" | "constants">;

export type AtomicOptions = {
  /** The file's mode; 0600 when left out. */
  mode?: number;
  /** Make the folder first when it is missing (with this mode when given). */
  mkdir?: boolean | { mode: number };
  /** The file system calls, for tests. */
  fs?: AtomicFs;
};

export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicOptions = {}): void {
  const fs = options.fs ?? realFs;
  const mode = options.mode ?? 0o600;
  const folder = dirname(path);
  if (options.mkdir) fs.mkdirSync(folder, { recursive: true, ...(typeof options.mkdir === "object" ? { mode: options.mkdir.mode } : {}) });
  const temp = join(folder, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", mode);
  try {
    try {
      fs.fchmodSync(fd, mode);
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let at = 0;
      while (at < bytes.length) at += fs.writeSync(fd, bytes, at, bytes.length - at);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
  }
  syncFolder(fs, folder);
}

function syncFolder(fs: AtomicFs, folder: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch {
    // A folder that cannot be synced (some systems refuse) still has the new file in place.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
