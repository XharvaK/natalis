// `natalis judge --events <events.jsonl> --a <run|reference.jsonl> --b <run|reference.jsonl> --rubric <file.md>
// --judge <judge.json> --out <folder>`: scores two sides, event by event, against a rubric. The rubric is read by
// path and never copied into the repository.

import { resolve } from "node:path";
import { judgeFiles } from "../../replay/index.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const JUDGE_USAGE =
  "Usage: natalis judge --events <events.jsonl> --a <run folder or reference.jsonl> --b <run folder or reference.jsonl> " +
  "--rubric <file.md> --judge <judge.json> --out <folder>";

export function judgeCommand(args: string[]): Promise<number> {
  return runCommand(JUDGE_USAGE, async () => {
    const flags = parseFlags(args, ["--events", "--a", "--b", "--rubric", "--judge", "--out"], []);
    const { report } = await judgeFiles({
      eventsPath: resolve(requireFlag(flags, "--events")),
      aPath: resolve(requireFlag(flags, "--a")),
      bPath: resolve(requireFlag(flags, "--b")),
      rubricPath: resolve(requireFlag(flags, "--rubric")),
      judgePath: resolve(requireFlag(flags, "--judge")),
      outDir: resolve(requireFlag(flags, "--out")),
    });
    const t = report.totals;
    console.log(
      `Judged ${t.judged} of ${t.events} events (${t.unjudged} unjudged). A wins ${t.wins.A}, ties ${t.wins.tie}, B wins ${t.wins.B}.`,
    );
    console.log(`Report: ${resolve(requireFlag(flags, "--out"))} (report.md and report.json).`);
    return 0;
  });
}
