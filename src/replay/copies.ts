// Replay and eval copies under the Lar's own folder. A forget purges them, because each holds a river.db clone (and, for
// a replay, a notebook clone) made before the words were forgotten. Backups are not copies: they age out on their own
// schedule and are never deleted here. Nothing outside the Lar folder is touched.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** The Lar's own folders, never a copy: a note or a world store may sit in them. */
const LAR_FOLDERS = new Set(["notebook", "home", "domus", "media", "vault", "trash"]);

/** Removes every replay or eval run folder under `dir`. Returns the folders removed, sorted. */
export function purgeCopiesUnder(dir: string): string[] {
  const root = resolve(dir);
  const removed: string[] = [];
  walk(root);
  return removed.sort();

  function walk(folder: string): void {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const child = join(folder, entry.name);
      if (folder === root && (LAR_FOLDERS.has(entry.name) || entry.name.startsWith("."))) continue;
      if (isEvalRun(child) || isReplayRun(child) || isEntityCopy(child)) {
        rmSync(child, { recursive: true, force: true });
        removed.push(child);
        continue;
      }
      walk(child);
    }
  }
}

/** writeEvalReport's folder: summary.json and results.jsonl (with cases/ when the report wrote them). */
function isEvalRun(folder: string): boolean {
  return existsSync(join(folder, "summary.json")) && existsSync(join(folder, "results.jsonl"));
}

/** runReplay's folder: transcript.jsonl and an entity/river.db copy. */
function isReplayRun(folder: string): boolean {
  return existsSync(join(folder, "transcript.jsonl")) && existsSync(join(folder, "entity", "river.db"));
}

/** copyForReplay's folder, or a copy placed on its own: entity.json, state.json and river.db together. */
function isEntityCopy(folder: string): boolean {
  return existsSync(join(folder, "entity.json")) && existsSync(join(folder, "state.json")) && existsSync(join(folder, "river.db"));
}
