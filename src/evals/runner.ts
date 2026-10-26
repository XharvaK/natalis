// Runs an eval case: each iteration opens a fresh throwaway Lar in a temp folder (CLI world only, nothing delivered
// anywhere else), sends the case's messages, waits until idle, and checks the assertions on the river it wrote.
// Several iterations measure flakiness. The temp folder is removed after each iteration.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelPort } from "../contracts.js";
import type { EntityConfig } from "../entity/config.js";
import { openEntity } from "../entity/runtime.js";
import { createCliWorld } from "../worlds/cli.js";
import { checkAssertion, trajectoryOf, type Check, type Trajectory } from "./assertions.js";
import type { EvalCase } from "./case.js";

export type IterationResult = { trajectory: Trajectory; checks: Check[]; gatePassed: boolean };
export type CaseResult = {
  name: string;
  verdict: "passed" | "failed";
  iterations: IterationResult[];
  /** Share of soft checks that passed over all iterations, 0 to 1. 1 when there are none. */
  softPassRate: number;
};

export const EVAL_CONFIG: EntityConfig = {
  name: "Eval",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "eval", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
  rhythm: [],
};

export type RunOptions = { makeModel: () => ModelPort; config?: EntityConfig };

export async function runEvalCase(def: EvalCase, options: RunOptions): Promise<CaseResult> {
  const iterations: IterationResult[] = [];
  let soft = 0;
  let softOk = 0;
  for (let i = 0; i < def.iterations; i++) {
    const root = mkdtempSync(join(tmpdir(), "natalis-eval-"));
    try {
      const dir = join(root, "lar");
      mkdirSync(dir);
      const cli = createCliWorld({ onSay: () => {} });
      const entity = await openEntity({ dir, config: options.config ?? EVAL_CONFIG, model: options.makeModel(), worlds: [cli] });
      await entity.start();
      for (const text of def.events) {
        cli.send(text);
        await entity.idle();
      }
      const trajectory = trajectoryOf(entity.river.read({ limit: 100_000 }));
      await entity.stop();
      const checks = def.assertions.map((a) => checkAssertion(trajectory, a));
      for (const check of checks) {
        if (check.mode === "soft") {
          soft += 1;
          if (check.ok) softOk += 1;
        }
      }
      iterations.push({ trajectory, checks, gatePassed: checks.every((c) => c.mode !== "gate" || c.ok) });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  return {
    name: def.name,
    verdict: iterations.every((it) => it.gatePassed) ? "passed" : "failed",
    iterations,
    softPassRate: soft === 0 ? 1 : softOk / soft,
  };
}

/** summary.json, results.jsonl (one line per case) and cases/<n>.json, so runs can be diffed. Text only, no secrets. */
export function writeEvalReport(outDir: string, results: readonly CaseResult[]): void {
  mkdirSync(join(outDir, "cases"), { recursive: true });
  const passed = results.filter((r) => r.verdict === "passed").length;
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ cases: results.length, passed, failed: results.length - passed }, null, 2));
  writeFileSync(join(outDir, "results.jsonl"), results.map((r) => JSON.stringify({ name: r.name, verdict: r.verdict, softPassRate: r.softPassRate })).join("\n") + "\n");
  results.forEach((r, i) => writeFileSync(join(outDir, "cases", `${i + 1}.json`), JSON.stringify(r, null, 2)));
}
