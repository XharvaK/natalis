// The sealed package: one encrypted file that holds a whole backup folder, so a Lar's backups can be copied off the host
// without anyone there being able to read them. Layout: the magic line "NATALIS1\n", one JSON header line, the
// AES-256-GCM ciphertext of a gzip archive, then the 16-byte GCM tag. The magic and the header are the GCM additional
// authenticated data, so a changed byte anywhere is refused. The archive holds the folder's files sorted by relative
// POSIX path: for each file a JSON line {"path","size","sha256"}, then exactly size bytes, then a newline. The key is
// 32 bytes, given as 64 hex characters in an environment variable the caller names. It is never written anywhere.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { errorText } from "./backup-format.js";
import { UsageError } from "./shared.js";

export const SEAL_EXTENSION = ".natalisbak";
export const SEAL_MAGIC = "NATALIS1\n";
export const SEAL_VERSION = 1;
export const SEAL_ALG = "aes-256-gcm" as const;
/** A Lar's folder name as a package may carry it. */
export const SEAL_LAR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** The name of an environment variable, as --key-env takes it. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STAMP_PATTERN = /^\d{8}-\d{6}$/;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const MAGIC_BYTES = Buffer.from(SEAL_MAGIC, "ascii");
const NEWLINE = Buffer.from("\n", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SealedEntry = { path: string; content: Buffer };
export type SealedHeader = { v: number; lar: string; stamp: string; alg: string; iv: string; files: number };
export type OpenedEntry = { path: string; size: number; sha256: string; content: Buffer };
export type OpenedPackage = { header: SealedHeader; entries: OpenedEntry[] };

export type SealOptions = {
  /** The folder the sealed package goes into. Created with mode 0700 if missing. */
  dir: string;
  /** The 32-byte sealing key. */
  key: Buffer;
  /** Keep this many sealed packages of this Lar. Older ones are removed. Omit to keep all. */
  keep?: number;
};

export type SealFolderResult = { file: string; files: number; bytes: number; removed: string[] };

/** Reads the sealing key from the named environment variable: exactly 64 hex characters. Never shows the value. */
export function readSealKey(name: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set. Put the sealing key (64 hex characters) in it, or leave sealing off.`);
  }
  if (!HEX_KEY_PATTERN.test(value)) {
    throw new Error(`${name} must hold exactly 64 hex characters (a 32-byte key). Its value is not shown.`);
  }
  return Buffer.from(value, "hex");
}

/** A --key-env value must name a variable. The key itself is refused, and never echoed. */
export function requireKeyName(value: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new UsageError("--key-env needs the name of an environment variable (letters, digits, underscores), never the key itself.");
  }
  return value;
}

/** A Lar's folder name must be one a package can carry. Throws plain before anything is written. */
export function assertSealableLar(lar: string): void {
  if (!SEAL_LAR_PATTERN.test(lar)) {
    throw new Error(`The Lar's folder name "${lar}" cannot be sealed. Use letters, digits, dashes and underscores.`);
  }
}

/** The package's file name for one backup: <lar>-<YYYYMMDD-HHMMSS>.natalisbak. */
export function sealedPackageName(lar: string, stamp: string): string {
  return `${lar}-${stamp}${SEAL_EXTENSION}`;
}

/** A path inside a package: relative, with "/" separators, and no empty, "." or ".." part, no backslash, no drive letter. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Seals a set of files into one package and returns its bytes. Files are sorted by path, so the same files always
 * seal the same way. Throws plain on an unsafe path, a duplicate path, a bad Lar name, a bad stamp or a key that is
 * not 32 bytes.
 */
export function sealBytes(input: { lar: string; stamp: string; key: Buffer; entries: readonly SealedEntry[] }): Buffer {
  const { lar, stamp, key } = input;
  assertSealableLar(lar);
  if (!STAMP_PATTERN.test(stamp)) throw new Error(`The stamp "${stamp}" is not YYYYMMDD-HHMMSS.`);
  checkKey(key);

  const sorted = [...input.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isSafeRelativePath(entry.path)) throw new Error(`${entry.path} is not a safe file name for a sealed package. Nothing was sealed.`);
    if (seen.has(entry.path)) throw new Error(`${entry.path} is listed twice. Nothing was sealed.`);
    seen.add(entry.path);
    const line = { path: entry.path, size: entry.content.length, sha256: sha256Hex(entry.content) };
    parts.push(Buffer.from(`${JSON.stringify(line)}\n`, "utf8"), entry.content, NEWLINE);
  }
  const compressed = gzipSync(Buffer.concat(parts));

  const iv = randomBytes(IV_BYTES);
  const header = `${JSON.stringify({ v: SEAL_VERSION, lar, stamp, alg: SEAL_ALG, iv: iv.toString("hex"), files: sorted.length })}\n`;
  const prefix = Buffer.from(`${SEAL_MAGIC}${header}`, "utf8");
  const cipher = createCipheriv(SEAL_ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(prefix);
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([prefix, body, cipher.getAuthTag()]);
}

/**
 * Opens a package with the key and checks all of it: the magic, the header, the GCM tag over the magic, header and
 * ciphertext, the archive's shape, and every file's size and hash. Throws plain on any failure, and returns only what
 * it has checked. Writes nothing.
 */
export function openSealedBytes(bytes: Buffer, key: Buffer): OpenedPackage {
  checkKey(key);
  if (bytes.length < MAGIC_BYTES.length + 1 + TAG_BYTES || !bytes.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
    throw new Error("This is not a sealed Natalis package (its first line is not NATALIS1).");
  }
  const headerEnd = bytes.indexOf(0x0a, MAGIC_BYTES.length);
  if (headerEnd < 0 || headerEnd + 1 + TAG_BYTES > bytes.length) throw new Error("The package header is cut short.");
  const header = parseHeader(bytes.subarray(MAGIC_BYTES.length, headerEnd).toString("utf8"));

  const prefix = bytes.subarray(0, headerEnd + 1);
  const ciphertext = bytes.subarray(headerEnd + 1, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  let compressed: Buffer;
  try {
    const decipher = createDecipheriv(SEAL_ALG, key, Buffer.from(header.iv, "hex"), { authTagLength: TAG_BYTES });
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("The package did not open. Either the key is not the one it was sealed with, or the package was changed.");
  }
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed);
  } catch {
    throw new Error("The package's archive is damaged.");
  }
  return { header, entries: readArchive(archive, header.files) };
}

/**
 * Seals a backup folder into <out>/<lar>-<stamp>.natalisbak. The package is written as <name>.partial (mode 0600),
 * fsynced and renamed. Then it is opened again with the key and compared with what was sealed. A package that does
 * not check is deleted and the error says so. With keep, the oldest packages of this Lar beyond keep are removed.
 */
export function sealFolder(input: {
  folder: string;
  lar: string;
  stamp: string;
  key: Buffer;
  out: string;
  keep?: number;
  say: (line: string) => void;
}): SealFolderResult {
  const { folder, lar, stamp, key, out, say } = input;
  assertSealableLar(lar);
  checkKey(key);
  const files = listFiles(folder)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((found) => ({ path: found.path, content: readFileSync(found.abs) }));
  say(`Read ${files.length} files from ${basename(folder)} for sealing.`);

  const bytes = sealBytes({ lar, stamp, key, entries: files });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = join(out, sealedPackageName(lar, stamp));
  if (existsSync(file)) throw new Error(`${basename(file)} already exists. Wait a second and try again.`);

  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  try {
    writeDurable(partial, bytes);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  say(`Wrote ${basename(file)}: ${files.length} files, ${bytes.length} bytes.`);

  try {
    const opened = openSealedBytes(readFileSync(file), key);
    const sealedList = files.map((entry) => ({ path: entry.path, size: entry.content.length, sha256: sha256Hex(entry.content) }));
    const openedList = opened.entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
    if (JSON.stringify(openedList) !== JSON.stringify(sealedList)) throw new Error("its files do not match what was sealed");
    say(`Checked the package: opened with the key, tag ok, ${opened.entries.length} file hashes ok.`);
  } catch (err) {
    rmSync(file, { force: true });
    throw new Error(`The sealed package did not check (${errorText(err)}), so it was deleted.`);
  }

  const removed = input.keep === undefined ? [] : pruneSealed(out, lar, input.keep, say);
  say(`Sealed package is ready: ${file}`);
  return { file, files: files.length, bytes: bytes.length, removed };
}

/**
 * Removes the oldest sealed packages of this Lar beyond `keep`. Only names exactly as this Lar's packages are named
 * are counted, so a similar file beside them is never touched. Returns the names removed, oldest first.
 */
export function pruneSealed(out: string, lar: string, keep: number, say: (line: string) => void): string[] {
  const pattern = new RegExp(`^${escapeRegExp(lar)}-\\d{8}-\\d{6}${escapeRegExp(SEAL_EXTENSION)}$`);
  const names = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const surplus = names.slice(0, Math.max(0, names.length - keep));
  for (const name of surplus) {
    rmSync(join(out, name), { force: true, maxRetries: 5 });
    say(`Removed old sealed package ${name}.`);
  }
  return surplus;
}

function parseHeader(text: string): SealedHeader {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw headerError("it is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw headerError("it is not an object");
  const h = value as Record<string, unknown>;
  if (h["v"] !== SEAL_VERSION) throw headerError("the version is not 1");
  if (typeof h["lar"] !== "string" || !SEAL_LAR_PATTERN.test(h["lar"])) throw headerError("the Lar name");
  if (typeof h["stamp"] !== "string" || !STAMP_PATTERN.test(h["stamp"])) throw headerError("the stamp");
  if (h["alg"] !== SEAL_ALG) throw headerError("the algorithm is not aes-256-gcm");
  if (typeof h["iv"] !== "string" || !/^[0-9a-f]{24}$/.test(h["iv"])) throw headerError("the IV");
  const files = h["files"];
  if (typeof files !== "number" || !Number.isSafeInteger(files) || files < 0) throw headerError("the file count");
  return { v: SEAL_VERSION, lar: h["lar"], stamp: h["stamp"], alg: SEAL_ALG, iv: h["iv"], files };
}

function readArchive(archive: Buffer, expected: number): OpenedEntry[] {
  const entries: OpenedEntry[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (at < archive.length) {
    const end = archive.indexOf(0x0a, at);
    if (end < 0) throw archiveError("an entry line is cut short");
    let line: unknown;
    try {
      line = JSON.parse(archive.subarray(at, end).toString("utf8"));
    } catch {
      throw archiveError("an entry line is not JSON");
    }
    const item = (typeof line === "object" && line !== null ? line : {}) as Record<string, unknown>;
    const path = item["path"];
    const size = item["size"];
    const sha256 = item["sha256"];
    if (typeof path !== "string" || !isSafeRelativePath(path)) throw archiveError("a file path is not safe");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw archiveError("a file size is not right");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw archiveError("a file hash is not right");
    if (seen.has(path)) throw archiveError("a file is listed twice");
    const start = end + 1;
    const stop = start + size;
    if (stop + 1 > archive.length) throw archiveError(`${path} is cut short`);
    if (archive[stop] !== 0x0a) throw archiveError(`${path} is not followed by a newline`);
    const content = archive.subarray(start, stop);
    if (sha256Hex(content) !== sha256) throw archiveError(`${path} does not match its hash`);
    seen.add(path);
    entries.push({ path, size, sha256, content });
    at = stop + 1;
  }
  if (entries.length !== expected) throw archiveError(`it holds ${entries.length} files, but the header says ${expected}`);
  return entries;
}

/** The files under a folder as relative POSIX paths. A link or any other special entry is refused, not followed. */
function listFiles(root: string, under = ""): { path: string; abs: string }[] {
  const found: { path: string; abs: string }[] = [];
  for (const entry of readdirSync(join(root, under), { withFileTypes: true })) {
    const path = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...listFiles(root, path));
    } else if (entry.isFile()) {
      found.push({ path, abs: join(root, path) });
    } else {
      throw new Error(`${path} is not a plain file or folder, so it cannot be sealed.`);
    }
  }
  return found;
}

/** Writes a new file with mode 0600, flushes it to disk, and closes it. Never replaces an existing file. */
function writeDurable(file: string, bytes: Buffer): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error("The sealing key must be 32 bytes.");
}

function headerError(what: string): Error {
  return new Error(`The package header is not right (${what}).`);
}

function archiveError(what: string): Error {
  return new Error(`The package archive is not right (${what}). The package is damaged.`);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
