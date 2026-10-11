// The owner's emergency stop: a file named STOP in the entity's folder. Its presence means the stop is on; its text,
// if any, is the reason. The owner writes it from the command line (natalis stop). The body checks it cheaply at
// every outward act. While it is on, outward acts are refused; replies to the owner still go.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STOP_FILE = "STOP";
const REASON_MAX = 300;
/** Enough bytes to read a reason of REASON_MAX characters, even with wide characters. */
const READ_MAX_BYTES = 4 * REASON_MAX;

export type StopState = { on: boolean; reason?: string };

export function stopPath(dir: string): string {
  return join(dir, STOP_FILE);
}

export function isStopOn(dir: string): boolean {
  return existsSync(stopPath(dir));
}

/** The stop as it is on disk now. A stop file that cannot be read is still a stop, with no reason. */
export function readStop(dir: string): StopState {
  if (!isStopOn(dir)) return { on: false };
  let text = "";
  try {
    text = readFileSync(stopPath(dir), "utf8").slice(0, READ_MAX_BYTES).trim();
  } catch {
    text = "";
  }
  const reason = text.slice(0, REASON_MAX);
  return reason === "" ? { on: true } : { on: true, reason };
}

/** Turns the stop on. The reason, if given, is written into the file. */
export function writeStop(dir: string, reason?: string): void {
  const text = reason === undefined ? "" : reason.trim();
  writeFileSync(stopPath(dir), text === "" ? "" : `${text}\n`, "utf8");
}

/** Turns the stop off. Returns false when it was not on. */
export function clearStop(dir: string): boolean {
  if (!isStopOn(dir)) return false;
  rmSync(stopPath(dir), { force: true });
  return true;
}
