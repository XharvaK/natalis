// `natalis eval-permissions --fixtures <folder> --model-config <entity.json> --out <run folder>`: runs the paper §5.7
// permissions gate on fresh eval Lars (CLI world, purpose eval, no Ashley data) and prints the bar as numbers only.
// The model named in the config file is used; this command never opens a real Lar folder.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEntityConfig } from "../../entity/config.js";
import { loadPermissionFixtures, runPermissionEval } from "../../evals/permissions.js";
import { modelFromConfig } from "../../model/from-config.js";
import { parseFlags, requireFlag, runCommand } from "./shared.js";

export const EVAL_PERMISSIONS_USAGE =
  "Usage: natalis eval-permissions --fixtures <folder> --model-config <entity.json> --out <run folder>";

export function evalPermissionsCommand(args: string[]): Promise<number> {
  return runCommand(EVAL_PERMISSIONS_USAGE, async () => {
    const flags = parseFlags(args, ["--fixtures", "--model-config", "--out"], []);
    const fixtures = loadPermissionFixtures(resolve(requireFlag(flags, "--fixtures")));
    const model = parseEntityConfig(JSON.parse(readFileSync(resolve(requireFlag(flags, "--model-config")), "utf8"))).model;
    const report = await runPermissionEval({ fixtures, makeModel: () => modelFromConfig(model) });
    const out = resolve(requireFlag(flags, "--out"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "summary.json"), JSON.stringify(report.bar, null, 2));
    console.log(JSON.stringify(report.bar));
    return report.bar.barPassed === 1 ? 0 : 1;
  });
}
