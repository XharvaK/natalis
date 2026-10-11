// `natalis replay --dir <entity> --events <events.jsonl> --out <run folder> [--config <entity.json>]`: replays the
// captured events on a copy of the entity. The original is never written. Nothing is delivered to any world.

import { resolve } from "node:path";
import { runReplay } from "../../replay/index.js";
import { parseFlags, requireFlag, runCommand, scannerFor } from "./shared.js";

export const REPLAY_USAGE =
  "Usage: natalis replay --dir <entity folder> --events <events.jsonl> --out <run folder> [--config <entity.json>]";

export function replayCommand(args: string[]): Promise<number> {
  return runCommand(REPLAY_USAGE, async () => {
    const flags = parseFlags(args, ["--dir", "--events", "--out", "--config"], []);
    const dir = resolve(requireFlag(flags, "--dir"));
    const configPath = flags.values.get("--config");
    const result = await runReplay({
      dir,
      eventsPath: resolve(requireFlag(flags, "--events")),
      outDir: resolve(requireFlag(flags, "--out")),
      ...(configPath === undefined ? {} : { configPath: resolve(configPath) }),
      scanner: scannerFor(dir),
    });
    console.log(`Fed ${result.eventsFed} of ${result.eventsTotal} events: ${result.says} says, ${result.wakes} wakes.`);
    console.log(`Transcript: ${result.transcriptPath}`);
    console.log(`Copy: ${result.entityDir} (river last seq ${result.lastSeq}).`);
    if (result.modelFailures > 0) console.log(`Model calls that failed: ${result.modelFailures}.`);
    if (result.stoppedEarly !== undefined) {
      console.error(`Stopped early: ${result.stoppedEarly}.`);
      return 1;
    }
    return 0;
  });
}
