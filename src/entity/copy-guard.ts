// A Lar belongs to one folder on one machine. The body records a hash of the machine id and the folder's real path in
// state.json, so a folder copied to another path or host is refused instead of becoming a second, diverging Lar. The
// hash is only a guard: it holds no secret and is safe to lose. Replay and eval copies are never refused or recorded.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";

/** The state.json key holding the hash of the folder where this Lar last ran. */
export const FOLDER_HASH_KEY = "folderHash";

/** Said when a live Lar finds itself in a folder other than the one it was recorded in. */
export const FOLDER_MOVED_MESSAGE =
  "This Lar's folder was moved or copied. If this is the real Lar, start it with --moved.";

/** Linux machine ids, in the order they are tried. Other platforms fall back to the host name. */
const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

/** The machine's id: the first readable machine-id file, or the host name where there is none (Windows, macOS). */
export function machineId(): string {
  for (const path of MACHINE_ID_FILES) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value !== "") return value;
    } catch {
      // This file is not on this host; try the next one.
    }
  }
  return hostname();
}

/** The sha256 hex of `<machine id>\n<absolute real folder path>`. */
export function folderHash(dir: string, machine: string = machineId()): string {
  return createHash("sha256").update(`${machine}\n${realpathSync(dir)}`).digest("hex");
}

export type CopyGuardResult =
  | { action: "record"; folderHash: string }
  | { action: "keep"; folderHash: string }
  | { action: "refuse"; message: string };

/**
 * What a live start should do with the hash state.json recorded. A missing hash is a first start and is recorded. A
 * matching hash is kept. A different hash is refused, unless the owner says the folder was moved on purpose.
 */
export function checkCopyGuard(input: {
  dir: string;
  recorded: string | undefined;
  moved?: boolean;
  /** The machine id to hash with. Tests give one; a live start uses this host's. */
  machine?: string;
}): CopyGuardResult {
  const current = folderHash(input.dir, input.machine ?? machineId());
  if (input.recorded === undefined || input.moved === true) return { action: "record", folderHash: current };
  if (input.recorded === current) return { action: "keep", folderHash: current };
  return { action: "refuse", message: FOLDER_MOVED_MESSAGE };
}

/** Thrown by a live start whose folder is not the one state.json recorded. */
export class CopyGuardRefused extends Error {
  constructor() {
    super(FOLDER_MOVED_MESSAGE);
    this.name = "CopyGuardRefused";
  }
}
