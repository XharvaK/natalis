// The key behind the short thread hash in exported events: one key per Lar, made on first need and kept beside the
// river. The key's bytes never leave this module: they are not logged, printed, or put in an error.

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// MUST-FIX before the exporter is wired:
// 1. jsonlExporter must require an explicit dataDir (the Lar folder) instead of defaulting to the export file's folder.
// 2. thread-hash.key is deliberately NOT in the plain backup list (src/bin/commands/backup-format.ts PLAIN_FILES), so
//    a restore rotates the key and old exports stop joining; decide include-or-rotate then.
// 3. The rollback cleanup must delete thread-hash.key.

/** The key file's name, in the Lar's own folder. It is not a backup file and not a notebook note. */
export const THREAD_HASH_KEY_FILE = "thread-hash.key";
/** 32 random bytes, as much key as HMAC-SHA256 takes. */
export const THREAD_HASH_KEY_BYTES = 32;
/** The exported thread field keeps its old shape: 12 lowercase hex characters. */
const THREAD_HASH_CHARS = 12;

/** The key file for a Lar's data folder. */
export function threadHashKeyPath(dir: string): string {
  return join(dir, THREAD_HASH_KEY_FILE);
}

/**
 * The Lar's thread hash key, made on first need. A file that already holds a key is read and kept, so a thread's hash
 * stays the same across restarts. A file that is not exactly one key is an error, never replaced silently.
 */
export function readThreadHashKey(dir: string): Buffer {
  const file = threadHashKeyPath(dir);
  const existing = readIfThere(file);
  if (existing !== undefined) return checkedKey(file, existing);

  mkdirSync(dir, { recursive: true });
  const key = randomBytes(THREAD_HASH_KEY_BYTES);
  try {
    // Owner-only where the platform has modes, and never over a key another process made first.
    writeFileSync(file, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (err) {
    if (codeOf(err) !== "EEXIST") {
      throw new Error(`The thread hash key could not be written in ${file} (${errorText(err)}).`);
    }
    return checkedKey(file, readFileSync(file));
  }
}

/** A short HMAC-SHA256 of one thread id, keyed for one Lar: 12 lowercase hex characters, as the old bare hash was. */
export function threadHash(key: Buffer, thread: string): string {
  return createHmac("sha256", key).update(thread, "utf8").digest("hex").slice(0, THREAD_HASH_CHARS);
}

/** The thread hash for a Lar: reads or makes its key once, then hashes every thread under it. */
export function createThreadHasher(dir: string): (thread: string) => string {
  const key = readThreadHashKey(dir);
  return (thread) => threadHash(key, thread);
}

function readIfThere(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return undefined;
    throw new Error(`The thread hash key in ${file} could not be read (${errorText(err)}).`);
  }
}

function checkedKey(file: string, key: Buffer): Buffer {
  if (key.length !== THREAD_HASH_KEY_BYTES) {
    throw new Error(
      `${file} is not a ${THREAD_HASH_KEY_BYTES}-byte thread hash key. It is left as it is: remove it to make a new key, and every thread hash will change.`,
    );
  }
  return key;
}

function codeOf(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
