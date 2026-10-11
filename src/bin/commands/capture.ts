// `natalis capture --dir <entity> --since <ISO> --until <ISO> --out <folder>`: writes events.jsonl and
// reference.jsonl for one time window of an entity's river. The window is from --since (inclusive) to --until
// (exclusive).

import { resolve } from "node:path";
import { captureWindow } from "../../replay/index.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const CAPTURE_USAGE =
  "Usage: natalis capture --dir <entity folder> --since <ISO time> --until <ISO time> --out <folder>";

export function captureCommand(args: string[]): Promise<number> {
  return runCommand(CAPTURE_USAGE, async () => {
    const flags = parseFlags(args, ["--dir", "--since", "--until", "--out"], []);
    const dir = resolve(requireFlag(flags, "--dir"));
    const sinceMs = parseIso(requireFlag(flags, "--since"), "--since");
    const untilMs = parseIso(requireFlag(flags, "--until"), "--until");
    const out = resolve(requireFlag(flags, "--out"));
    const result = captureWindow({ dir, sinceMs, untilMs, outDir: out });
    console.log(`Captured ${result.events} events and ${result.says} says into ${out}.`);
    if (result.forgotten > 0) console.log(`Skipped ${result.forgotten} forgotten rows.`);
    return 0;
  });
}

function parseIso(text: string, flag: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`${flag} must be a date and time, such as 2026-10-01T00:00:00Z.`);
  return ms;
}
