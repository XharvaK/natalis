// The import plan: what a bundle would write into an entity folder, what it would leave out, and what stops it.
// Pure: it takes the bundle and the folder facts and answers. Nothing is written here.

import type { EntityFolderFacts } from "./folder.js";
import { SEEDED_NOTEBOOK_FILES } from "./folder.js";
import type { Bundle, BundleFile, BundleRow, BundleTombstone, Refusal } from "./bundle.js";

export type PlannedFile = {
  /** Notebook path, "/"-separated. */
  path: string;
  bytes: number;
  /** "new" for a file the notebook does not have; "replaces seed" for a seeded file the bundle overwrites. */
  action: "new" | "replaces seed";
  refused: boolean;
};

export type ImportPlan = {
  source: string;
  createdAt: string;
  target: EntityFolderFacts;
  notes: PlannedFile[];
  provenance: PlannedFile[];
  rows: {
    /** Rows that will be written. */
    written: number;
    /** Rows held back by the secret scan. */
    refused: number;
    /** Written rows per UTC month ("2026-03"), oldest first. */
    byMonth: Array<{ key: string; count: number }>;
    /** Written rows per kind and source, such as "say/self". */
    byKindSource: Array<{ key: string; count: number }>;
  };
  tombstones: { written: number; refused: number };
  refused: Refusal[];
  /** Things already in the way: existing files that are not seeds, a river that is not empty, colliding paths. */
  conflicts: string[];
  /** Why the import will not write. Empty means it can apply. */
  blocked: string[];
  skipRefused: boolean;
};

export type PlanOptions = { skipRefused: boolean };

export function makePlan(bundle: Bundle, refused: Refusal[], target: EntityFolderFacts, options: PlanOptions): ImportPlan {
  const conflicts: string[] = [];
  if (target.riverError !== undefined) {
    conflicts.push(`river.db could not be read (${target.riverError}); the importer will not write into it`);
  }
  if (target.riverLastSeq > 0) {
    conflicts.push(`the river already holds ${target.riverLastSeq} rows; an import needs an empty river`);
  }
  for (const file of target.notebookFiles) {
    if (!SEEDED_NOTEBOOK_FILES.has(file)) conflicts.push(`notebook/${file} already exists and is not a seed file`);
  }

  const notes = bundle.notes.map((file) => planFile(file, target));
  const provenance = bundle.provenance.map((file) => planFile(file, target));
  const seen = new Map<string, string>();
  for (const file of [...bundle.notes, ...bundle.provenance]) {
    const earlier = seen.get(file.path);
    if (earlier !== undefined) {
      conflicts.push(`two bundle files want notebook/${file.path}: ${earlier} and ${file.file}`);
    }
    seen.set(file.path, file.file);
  }

  const writtenRows = bundle.rows.filter((row) => !(row.refused && options.skipRefused));
  const writtenTombstones = bundle.tombstones.filter((item) => !(item.refused && options.skipRefused));
  const refusedRows = bundle.rows.filter((row) => row.refused).length;
  const refusedTombstones = bundle.tombstones.filter((item) => item.refused).length;

  const refusedCount = refused.length;
  const blocked: string[] = [];
  if (conflicts.length > 0) blocked.push(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} stop the import`);
  if (refusedCount > 0 && !options.skipRefused) {
    blocked.push(`${refusedCount} refused item${refusedCount === 1 ? "" : "s"}; run again with --skip-refused to leave them out`);
  }

  return {
    source: bundle.source,
    createdAt: bundle.createdAt,
    target,
    notes,
    provenance,
    rows: {
      written: writtenRows.length,
      refused: refusedRows,
      byMonth: countBy(writtenRows, (row) => new Date(row.atMs).toISOString().slice(0, 7)),
      byKindSource: countBy(writtenRows, (row) => `${row.kind}/${row.source}`),
    },
    tombstones: { written: writtenTombstones.length, refused: refusedTombstones },
    refused,
    conflicts,
    blocked,
    skipRefused: options.skipRefused,
  };
}

function planFile(file: BundleFile, target: EntityFolderFacts): PlannedFile {
  return {
    path: file.path,
    bytes: file.bytes,
    action: SEEDED_NOTEBOOK_FILES.has(file.path) && target.notebookFiles.includes(file.path) ? "replaces seed" : "new",
    refused: file.refused,
  };
}

/** Counts items by key, sorted by key (so months read oldest first). */
function countBy<T>(items: T[], keyOf: (item: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => ({ key, count }));
}
