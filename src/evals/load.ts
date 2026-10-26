// Reads eval case files (*.json) from a folder, sorted by file name.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCase, type EvalCase } from "./case.js";

export function loadEvalCases(dir: string): EvalCase[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return parseEvalCase(JSON.parse(readFileSync(join(dir, name), "utf8")));
      } catch (err) {
        throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}
