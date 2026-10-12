// `natalis ledger <entity folder> [--days N] [--cache]`: the ledger of turns over the last N days (one day by default), as
// counts only. Each turn has one row: when it was, which kind of thread it was in, how it ended, the model, the tokens the
// provider reported, and whether the backup answered. No words are kept there, and none are printed. With --cache, the
// call ledger (one row per model call, the cache witness) is summarised per kind of thread instead: hits against the
// stable run, provider forgets, the parts that broke the cache, and the mean size of each part.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCallLedger, readLedger, summarizeCallLedger, summarizeLedger, type CallSummary } from "../../river/ledger.js";
import { flagValue, hasFlag } from "./args.js";

export const LEDGER_USAGE = "Usage: natalis ledger <entity folder> [--days N] [--cache]";
const DAY_MS = 86_400_000;

/** The ledger command. Returns the exit code; output goes to the writers given. */
export async function ledgerCommand(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const folder = args[0];
  if (folder === undefined || folder.startsWith("--")) {
    err("Give the entity's folder first.");
    err(LEDGER_USAGE);
    return 2;
  }
  const daysText = flagValue(args, "--days") ?? "1";
  if (!/^[1-9][0-9]*$/.test(daysText)) {
    err("--days takes a whole number of days, 1 or more.");
    err(LEDGER_USAGE);
    return 2;
  }
  const dir = resolve(folder);
  const riverPath = join(dir, "river.db");
  if (!existsSync(riverPath)) {
    err(`No river.db in ${dir}; there is no ledger to read.`);
    return 2;
  }

  const days = Number(daysText);
  const sinceMs = Date.now() - days * DAY_MS;
  if (hasFlag(args, "--cache")) {
    cacheReport(summarizeCallLedger(readCallLedger(riverPath, sinceMs)), days, out);
    return 0;
  }
  const summary = summarizeLedger(readLedger(riverPath, sinceMs));
  out(
    `Ledger, last ${days} day(s): ${summary.turns} turn(s). Answered ${summary.answered}, failed ${summary.failed}, aborted ${summary.aborted}.`,
  );
  out(`Turns by kind of thread: ${entries(summary.byThreadKind)}.`);
  out(`Turns by model: ${entries(summary.byModel)}.`);
  out(`Backup answered ${summary.backupAnswered} turn(s).`);
  out(
    `Tokens: ${summary.tokens.total ?? "not reported"} in total (prompt ${summary.tokens.prompt ?? "not reported"}, completion ${summary.tokens.completion ?? "not reported"}); reported for ${summary.tokens.reportedFor} of ${summary.turns} turn(s).`,
  );
  out(
    `Cache hits: ${summary.cacheHitTokens.total ?? "not reported"}; reported for ${summary.cacheHitTokens.reportedFor} of ${summary.turns} turn(s).`,
  );
  return 0;
}

/** The cache report: one block per kind of thread, counts and names only. */
function cacheReport(byKind: Record<string, CallSummary>, days: number, out: (line: string) => void): void {
  const kinds = Object.keys(byKind).sort();
  const calls = kinds.reduce((total, kind) => total + (byKind[kind]?.calls ?? 0), 0);
  out(`Cache, last ${days} day(s): ${calls} model call(s).`);
  if (kinds.length === 0) out("No model calls are recorded in this window.");
  for (const kind of kinds) {
    const summary = byKind[kind];
    if (summary === undefined) continue;
    out(
      `${kind}: ${summary.calls} call(s). Cache hit ${percent(summary.hitRatio)}, expected ${percent(summary.expectedRatio)} ` +
        `(from ${summary.measured} measured call(s)). Provider forgot ${summary.providerForgot}. Marks sent ${summary.marks}.`,
    );
    out(`  Parts that broke the cache, by count: ${entries(summary.breaks)}.`);
    const means: Record<string, number> = {};
    for (const [name, size] of Object.entries(summary.partSizes)) means[name] = size.meanChars;
    out(`  Mean characters per part: ${entries(means)}.`);
  }
}

function percent(ratio: number | undefined): string {
  return ratio === undefined ? "not measured" : `${Math.round(ratio * 100)}%`;
}

/** "name count" pairs, by name; "none" when there are none. */
function entries(counts: Record<string, number>): string {
  const names = Object.keys(counts).sort();
  return names.length === 0 ? "none" : names.map((name) => `${name} ${counts[name]}`).join(", ");
}
