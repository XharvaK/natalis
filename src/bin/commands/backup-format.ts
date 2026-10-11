// The shape of a Lar backup, shared by `natalis backup` and `natalis restore`: the files a backup holds, the manifest
// that lists them with sizes and hashes, and the two checks both commands make (the manifest, and the river's last
// seq). A backup holds only the files named here, plus the worlds' own folders: the vault (kept 0600), the sandbox
// home and the game's folder. Nothing with "env" in its name is ever in the list (in the home, a file or folder with
// "env" in its name is left out), and the emergency stop file is not either: a restored Lar starts with its stop off.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RIVER_FILE } from "../../import/folder.js";

export const MANIFEST_FILE = "MANIFEST.json";
export const BUNDLE_FILE = "notebook.bundle";
export const BACKUP_FORMAT = "natalis-backup";
export const BACKUP_VERSION = 1;

/** Files copied as they are, when the Lar's folder has them. Order matters for backups: see backup.ts. */
export const PLAIN_FILES: readonly string[] = [
  "state.json",
  "entity.json",
  "discord.json",
  "discord-aliases.json",
  "discord-aliases.refs.json",
  "privacy.json",
  "welcome.md",
  "web.json",
  "sandbox.json",
  "domus.json",
];

/** The web world's vault: one file per secret, each copied as it is and restored with mode 0600. */
export const VAULT_TREE = "vault";
/** The sandbox world's home: everything the Lar keeps there, except symlinks, caches, and anything named like env. */
export const HOME_TREE = "home";
/** Top-level folders of the home that are only caches, left out of a backup. */
export const HOME_SKIPPED: ReadonlySet<string> = new Set([".cache"]);
/** The game world's database, copied as a consistent snapshot, and its heartbeat file. */
export const DOMUS_DB_PATH = "domus/domus.sqlite";
export const DOMUS_STATE_PATH = "domus/state.json";
const VAULT_ENTRY = /^vault\/[A-Za-z0-9_.-]{1,48}\.json$/;

/** Every name a manifest may list. Anything else, including any name with "env" in it, is refused. */
const ALLOWED_NAMES: ReadonlySet<string> = new Set<string>([RIVER_FILE, BUNDLE_FILE, ...PLAIN_FILES, DOMUS_DB_PATH, DOMUS_STATE_PATH]);

/** A name a manifest may list: a known file, a vault entry, or a plain relative path inside the home. */
export function isAllowedName(name: string): boolean {
  if (ALLOWED_NAMES.has(name)) return !hasEnvName(name);
  if (VAULT_ENTRY.test(name)) return true;
  if (!name.startsWith(`${HOME_TREE}/`)) return false;
  const parts = name.split("/");
  return parts.length >= 2 && parts.every((part) => part !== "" && part !== "." && part !== ".." && !/[\\\u0000:]/.test(part))
    && !parts.slice(1).some(hasEnvName);
}

export type ManifestFile = { name: string; bytes: number; sha256: string };

export type Manifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** The Lar's folder name at backup time. */
  entity: string;
  /** ISO time, UTC. */
  createdAt: string;
  /** The last seq of the copied river. */
  riverLastSeq: number;
  /** The notebook's HEAD commit at backup time. */
  notebookHead: string;
  files: ManifestFile[];
};

export function hasEnvName(name: string): boolean {
  return name.toLowerCase().includes("env");
}

/** Checks an already-parsed manifest. Throws a plain error naming the first wrong field. */
export function parseManifest(value: unknown): Manifest {
  const bad = (what: string): never => {
    throw new Error(`${MANIFEST_FILE} is malformed: ${what}. Not restoring.`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not an object");
  const root = value as Record<string, unknown>;
  if (root["format"] !== BACKUP_FORMAT) bad(`format is not "${BACKUP_FORMAT}"`);
  if (root["version"] !== BACKUP_VERSION) bad(`version is not ${BACKUP_VERSION}`);
  if (typeof root["entity"] !== "string") bad("entity");
  if (typeof root["createdAt"] !== "string") bad("createdAt");
  const riverLastSeq = root["riverLastSeq"];
  if (typeof riverLastSeq !== "number" || !Number.isSafeInteger(riverLastSeq) || riverLastSeq < 0) bad("riverLastSeq");
  if (typeof root["notebookHead"] !== "string" || !/^[0-9a-f]{40,64}$/.test(root["notebookHead"])) bad("notebookHead");
  const files = root["files"];
  if (!Array.isArray(files)) bad("files");
  const seen = new Set<string>();
  const list = (files as unknown[]).map((item): ManifestFile => {
    const file = item as Record<string, unknown>;
    const name = file?.["name"];
    if (typeof name !== "string" || !isAllowedName(name)) bad(`a file name that is not allowed (${String(name)})`);
    if (seen.has(name as string)) bad(`${String(name)} is listed twice`);
    seen.add(name as string);
    const bytes = file["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) bad(`the size of ${String(name)}`);
    const sha256 = file["sha256"];
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) bad(`the hash of ${String(name)}`);
    return { name: name as string, bytes: bytes as number, sha256: sha256 as string };
  });
  for (const required of [RIVER_FILE, BUNDLE_FILE]) {
    if (!seen.has(required)) bad(`${required} is not listed`);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    entity: root["entity"] as string,
    createdAt: root["createdAt"] as string,
    riverLastSeq: riverLastSeq as number,
    notebookHead: root["notebookHead"] as string,
    files: list,
  };
}

/** Reads and checks the manifest of a backup folder. */
export function readManifest(backupDir: string): Manifest {
  const file = join(backupDir, MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} in ${backupDir} could not be read (${errorText(err)}). Not restoring.`);
  }
  return parseManifest(parsed);
}

/** Every listed file is present, and its size and hash match the manifest. Throws on the first mismatch. */
export function checkFilesAgainst(backupDir: string, manifest: Manifest): void {
  for (const file of manifest.files) {
    const path = join(backupDir, file.name);
    if (!existsSync(path)) throw new Error(`${file.name} is missing from the backup. Not restoring.`);
    if (statSync(path).size !== file.bytes) {
      throw new Error(`${file.name} does not match its manifest (size). The backup may be damaged. Not restoring.`);
    }
    if (sha256File(path) !== file.sha256) {
      throw new Error(`${file.name} does not match its manifest (hash). The backup may be damaged. Not restoring.`);
    }
  }
}

/** The SHA-256 of a file, as lowercase hex. A Lar's river is small enough to read whole. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The last seq of a river file, read through a read-only connection. Throws plain if it is not a Natalis river. */
export function readRiverLastSeq(riverFile: string): number {
  const db = new DatabaseSync(riverFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS last FROM rows").get() as { last: number };
    return Number(row.last);
  } catch (err) {
    throw new Error(`${RIVER_FILE} is not a readable Natalis river (${errorText(err)}).`);
  } finally {
    db.close();
  }
}

/** A local-time stamp, YYYYMMDD-HHMMSS: the middle of every backup folder's name. */
export function formatStamp(when: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const day = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`;
  return `${day}-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
}

/** Runs git with execFile (never a shell). Resolves with trimmed stdout; rejects with git's own words. */
export function git(cwd: string | undefined, args: string[]): Promise<string> {
  const fullArgs = cwd === undefined ? args : ["-C", cwd, ...args];
  return new Promise((resolveRun, rejectRun) => {
    execFile("git", fullArgs, { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolveRun(String(stdout).trim());
    });
  });
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
