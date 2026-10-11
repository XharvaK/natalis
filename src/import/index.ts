// `natalis import`: reads a seed bundle, checks it against the entity folder, prints the plan, and writes only
// when asked (--apply). The importer judges nothing; it checks shape and secrets and keeps the record.

import type { SecretScanner } from "../contracts.js";
import { createSecretScanner } from "../secrets/index.js";
import { readBundle, type Problem } from "./bundle.js";
import { applyImport, type ApplyCounts } from "./apply.js";
import { renderPlan } from "./format.js";
import { readEntityFolder } from "./folder.js";
import { makePlan } from "./plan.js";

export type ImportOptions = {
  /** The entity folder. Created when missing. */
  dir: string;
  bundleDir: string;
  /** False is a dry run: the plan is printed and nothing is written. */
  apply: boolean;
  /** Leave refused items out instead of stopping. */
  skipRefused: boolean;
  scanner?: SecretScanner;
};

export type ImportOutcome = {
  /** False when the bundle has problems, or an apply was asked for and blocked. */
  ok: boolean;
  applied: boolean;
  /** Plain lines for the terminal. */
  lines: string[];
  counts?: ApplyCounts;
};

export async function runImport(options: ImportOptions): Promise<ImportOutcome> {
  const scanner = options.scanner ?? createSecretScanner();
  const read = readBundle(options.bundleDir, scanner);
  if (!read.ok) {
    return {
      ok: false,
      applied: false,
      lines: ["The bundle has problems. Nothing was checked further and nothing was written.", ...read.problems.map(problemLine)],
    };
  }

  const facts = readEntityFolder(options.dir);
  const plan = makePlan(read.bundle, read.refused, facts, { skipRefused: options.skipRefused });
  const lines = renderPlan(plan);

  if (!options.apply) {
    lines.push("");
    if (plan.blocked.length === 0) {
      lines.push("Dry run: nothing was written. Run again with --apply to write this plan.");
    } else {
      lines.push(`Dry run: nothing was written. Applying would stop: ${plan.blocked.join("; ")}.`);
    }
    return { ok: true, applied: false, lines };
  }

  if (plan.blocked.length > 0) {
    lines.push("");
    lines.push(`Not applied: ${plan.blocked.join("; ")}. Nothing was written.`);
    return { ok: false, applied: false, lines };
  }

  const counts = await applyImport(options.dir, read.bundle, plan);
  lines.push("");
  lines.push(
    `Applied: ${counts.rows} river rows, ${counts.tombstones} tombstones, ${counts.notes} notes, ` +
      `${counts.provenance} provenance files. The entity starts calm at river seq ${counts.lastSeq}.`,
  );
  return { ok: true, applied: true, lines, counts };
}

function problemLine(problem: Problem): string {
  const where = problem.line === undefined ? problem.file : `${problem.file} line ${problem.line}`;
  return `  ${where}: ${problem.message}`;
}

export { readBundle } from "./bundle.js";
export { makePlan } from "./plan.js";
export { applyImport, buildState, chronological } from "./apply.js";
export { readEntityFolder } from "./folder.js";
export { renderPlan } from "./format.js";
