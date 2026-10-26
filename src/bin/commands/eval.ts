// `natalis eval --cases <folder> --model-config <entity.json> --out <run folder>`: runs scenario eval cases, each on a
// fresh throwaway Lar in a temp folder, on the model named in the config file. No Lar folder is opened or read; only
// the config file's model block is used. Writes summary.json, results.jsonl and cases/. Exit 1 when a case fails.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEntityConfig } from "../../entity/config.js";
import { EVAL_CONFIG, loadEvalCases, runEvalCase, writeEvalReport } from "../../evals/index.js";
import { modelFromConfig } from "../../model/from-config.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const EVAL_USAGE = "Usage: natalis eval --cases <folder> --model-config <entity.json> --out <run folder>";

export function evalCommand(args: string[]): Promise<number> {
  return runCommand(EVAL_USAGE, async () => {
    const flags = parseFlags(args, ["--cases", "--model-config", "--out"], []);
    const cases = loadEvalCases(resolve(requireFlag(flags, "--cases")));
    const model = parseEntityConfig(JSON.parse(readFileSync(resolve(requireFlag(flags, "--model-config")), "utf8"))).model;
    const config = { ...EVAL_CONFIG, model };
    const results = [];
    for (const def of cases) {
      const result = await runEvalCase(def, { makeModel: () => modelFromConfig(model), config });
      console.log(`${result.verdict === "passed" ? "ok" : "FAIL"} ${def.name} (soft ${Math.round(result.softPassRate * 100)}%)`);
      results.push(result);
    }
    writeEvalReport(resolve(requireFlag(flags, "--out")), results);
    return results.every((r) => r.verdict === "passed") ? 0 : 1;
  });
}
