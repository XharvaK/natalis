// `natalis stop --dir <entity folder> [--reason "<text>"]` turns the owner's emergency stop on: outward acts are
// refused until it is lifted, and replies to the summoner still go. `natalis stop --dir <entity folder> --off` lifts it.
// The running entity notices the change at its next outward act.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITY_FILE } from "../../entity/config.js";
import { clearStop, isStopOn, writeStop } from "../../entity/stop.js";
import { flagValue, hasFlag } from "./args.js";

export const STOP_USAGE = 'Usage: natalis stop --dir <entity folder> [--reason "<text>"]  or  natalis stop --dir <entity folder> --off';

/** Runs the stop command. Returns the exit code; output goes to the two writers given (so tests can read it). */
export function stopCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): number {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(STOP_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  if (!existsSync(join(dir, ENTITY_FILE))) {
    err(`No ${ENTITY_FILE} in ${dir}. Give the entity's own folder.`);
    return 1;
  }

  if (hasFlag(args, "--off")) {
    out(clearStop(dir) ? "Emergency stop is off. Outward acts can go on again." : "The emergency stop was not on.");
    return 0;
  }

  const reason = flagValue(args, "--reason");
  if (reason !== undefined && reason.trim() === "") {
    err("--reason needs words, or leave it out.");
    return 2;
  }
  const wasOn = isStopOn(dir);
  writeStop(dir, reason);
  const why = reason === undefined ? "" : ` Reason: ${reason.trim()}`;
  out(`${wasOn ? "Emergency stop was already on" : "Emergency stop is on"}. Outward acts are paused; the Lar can still answer the summoner.${why}`);
  return 0;
}
