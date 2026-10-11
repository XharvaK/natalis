// Writes an approved plan into an entity folder. Order matters: the river first, then the notebook, then the
// forgotten list, and state.json last. If the import stops early, state.json is missing, so the entity refuses
// to start (the runtime's own check) instead of running on half an import.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openNotebook, seedNotebook } from "../notebook/index.js";
import { openRiver } from "../river/index.js";
import { ENTITY_STUBS, seedStub, STATE_FILE } from "../entity/runtime.js";
import type { Notebook } from "../contracts.js";
import type { Bundle, BundleRow, BundleTombstone } from "./bundle.js";
import { FORGOTTEN_NOTE } from "./bundle.js";
import { NOTEBOOK_DIR, RIVER_FILE } from "./folder.js";
import type { ImportPlan } from "./plan.js";

export type ApplyCounts = {
  rows: number;
  tombstones: number;
  notes: number;
  provenance: number;
  lastSeq: number;
};

/** Writes everything the plan allows. Items marked refused are left out. The caller checks the plan first. */
export async function applyImport(dir: string, bundle: Bundle, plan: ImportPlan): Promise<ApplyCounts> {
  if (plan.blocked.length > 0) throw new Error(`The import is blocked: ${plan.blocked.join("; ")}.`);
  mkdirSync(dir, { recursive: true });

  const river = openRiver(join(dir, RIVER_FILE));
  try {
    if (river.lastSeq() !== 0) throw new Error("The river is not empty any more. Nothing was written.");
    const rows = bundle.rows.filter((row) => !row.refused);
    const tombstones = bundle.tombstones.filter((item) => !item.refused);
    for (const entry of chronological(rows, tombstones)) {
      if (entry.kind === "row") {
        const row = entry.row;
        river.append({
          thread: row.thread,
          kind: row.kind,
          source: row.source,
          atMs: row.atMs,
          ...(row.place === undefined ? {} : { place: row.place }),
          ...(row.actor === undefined ? {} : { actor: row.actor }),
          ...(row.text === undefined ? {} : { text: row.text }),
          ...(row.data === undefined ? {} : { data: row.data }),
        });
      } else {
        river.appendTombstone({ atMs: entry.item.atMs, by: entry.item.by, data: tombstoneData(entry.item) });
      }
    }
    const lastSeq = river.lastSeq();

    const notebook = await openNotebook(join(dir, NOTEBOOK_DIR));
    await seedNotebook(notebook);
    for (const stub of ENTITY_STUBS) await seedStub(notebook, stub.path, stub.text, stub.reason);

    const reason = `Imported from ${bundle.source}`;
    const notes = bundle.notes.filter((file) => !file.refused);
    const provenance = bundle.provenance.filter((file) => !file.refused);
    for (const file of notes) await notebook.write(file.path, file.text, reason, "body");
    for (const file of provenance) await notebook.write(file.path, file.text, reason, "body");
    await notebook.write(
      FORGOTTEN_NOTE,
      forgottenText(tombstones),
      "Record what was forgotten before the import",
      "body",
    );

    writeStateFile(join(dir, STATE_FILE), buildState(lastSeq, rows));
    return {
      rows: rows.length,
      tombstones: tombstones.length,
      notes: notes.length,
      provenance: provenance.length,
      lastSeq,
    };
  } finally {
    river.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Order of the river

type Entry = { kind: "row"; row: BundleRow; atMs: number } | { kind: "tombstone"; item: BundleTombstone; atMs: number };

/** Rows and tombstones in time order. Equal times keep the row before the tombstone, then file order. */
export function chronological(rows: BundleRow[], tombstones: BundleTombstone[]): Entry[] {
  const entries: Entry[] = [
    ...rows.map((row): Entry => ({ kind: "row", row, atMs: row.atMs })),
    ...tombstones.map((item): Entry => ({ kind: "tombstone", item, atMs: item.atMs })),
  ];
  // Array.prototype.sort is stable, so equal keys keep the order they were put in: rows first.
  return entries.sort((a, b) => a.atMs - b.atMs);
}

function tombstoneData(item: BundleTombstone): Record<string, unknown> {
  const data: Record<string, unknown> = { by: item.by, reason: item.reason, imported: true };
  if (item.count !== undefined) data["count"] = item.count;
  if (item.what !== undefined) data["what"] = item.what;
  return data;
}

// ---------------------------------------------------------------------------------------------------
// Notebook and state

function forgottenText(tombstones: BundleTombstone[]): string {
  const lines = [
    "# Forgotten before the import",
    "",
    "Things that were forgotten in the system this history came from. Only the time, who forgot it, the reason and",
    "the count are kept here. The forgotten words are not.",
    "",
  ];
  if (tombstones.length === 0) {
    lines.push("Nothing was forgotten before this import.");
  } else {
    const sorted = [...tombstones].sort((a, b) => a.atMs - b.atMs);
    for (const item of sorted) {
      const when = new Date(item.atMs).toISOString().slice(0, 16).replace("T", " ");
      const extras = [
        item.count === undefined ? undefined : `count ${item.count}`,
        item.what === undefined ? undefined : `kind ${item.what}`,
      ].filter((part): part is string => part !== undefined);
      const tail = extras.length === 0 ? "" : ` (${extras.join(", ")})`;
      lines.push(`- ${when} UTC, by ${item.by}: ${item.reason}${tail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Same shape as the runtime's state.json (its checkState reads exactly these fields). */
export type ImportedState = {
  lastSeq: number;
  threads: Record<string, { seenSeq: number }>;
  asks: [];
  wakes: [];
  mood: null;
  lastOwnerMs?: number;
};

/** The state an imported entity starts with: calm, every imported thread caught up, no asks, wakes or mood. */
export function buildState(lastSeq: number, rows: BundleRow[]): ImportedState {
  const threads: Record<string, { seenSeq: number }> = {};
  let lastOwnerMs: number | undefined;
  for (const row of rows) {
    threads[row.thread] = { seenSeq: lastSeq };
    if (row.source === "owner" && (lastOwnerMs === undefined || row.atMs > lastOwnerMs)) lastOwnerMs = row.atMs;
  }
  const state: ImportedState = { lastSeq, threads, asks: [], wakes: [], mood: null };
  if (lastOwnerMs !== undefined) state.lastOwnerMs = lastOwnerMs;
  return state;
}

function writeStateFile(path: string, state: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
