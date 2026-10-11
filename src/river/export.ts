// The monthly mirror: a plain-text view of the river, one file per UTC month. It is derived, so every
// export overwrites the file. Nothing reads it back; the river is the only truth.

import fs from "node:fs";
import path from "node:path";
import type { River, RiverRow } from "../contracts.js";

const PAGE_SIZE = 500;

/** True when the row's text was forgotten (see StoredRiverRow in sqlite-river.ts). */
export function isForgotten(row: RiverRow): boolean {
  return (row as Partial<{ forgotten: boolean }>).forgotten === true;
}

/** The UTC month of a time, as "YYYY-MM". */
export function monthKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 7);
}

/** One block of the mirror: a header line, then the text (or a placeholder), then compact data. */
export function formatBlock(row: RiverRow): string {
  const actor = row.actor ?? "-";
  const lines = [
    `### ${new Date(row.atMs).toISOString()}  ${row.thread}  ${row.kind}  source=${row.source}  actor=${actor}  seq=${row.seq}`,
  ];
  if (row.kind === "tombstone") {
    const data = row.data ?? {};
    lines.push(`(tombstone: ${String(data.count ?? "?")} rows, by ${String(data.by ?? "?")})`);
  } else if (isForgotten(row)) {
    lines.push("(forgotten)");
  } else if (row.text !== undefined) {
    lines.push(row.text);
  }
  if (row.data !== undefined && !isForgotten(row)) {
    lines.push(JSON.stringify(row.data));
  }
  return lines.join("\n");
}

export function formatMonth(rows: RiverRow[]): string {
  return rows.map((row) => `${formatBlock(row)}\n`).join("\n");
}

/** Every row of the river, in seq order, read in pages. */
function scanAll(river: River): RiverRow[] {
  const rows: RiverRow[] = [];
  let cursor = 0;
  for (;;) {
    const page = river.read({ sinceSeq: cursor, limit: PAGE_SIZE });
    rows.push(...page);
    const last = page[page.length - 1];
    if (!last || page.length < PAGE_SIZE) break;
    cursor = last.seq + 1;
  }
  return rows;
}

function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, file);
}

/** Writes `<dir>/YYYY-MM.md` for one UTC month. Returns the file path. */
export function exportMonth(river: River, dir: string, year: number, month: number): string {
  if (!Number.isSafeInteger(year) || year < 1970 || year > 9999) throw new Error("year must be 1970..9999");
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) throw new Error("month must be 1..12");
  const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  const rows = scanAll(river).filter((row) => monthKey(row.atMs) === key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.md`);
  writeFileAtomic(file, formatMonth(rows));
  return file;
}

/** Writes one file per UTC month present in the river. Returns the file paths, oldest month first. */
export function exportAll(river: River, dir: string): string[] {
  const byMonth = new Map<string, RiverRow[]>();
  for (const row of scanAll(river)) {
    const key = monthKey(row.atMs);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(row);
    else byMonth.set(key, [row]);
  }
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const key of [...byMonth.keys()].sort()) {
    const file = path.join(dir, `${key}.md`);
    writeFileAtomic(file, formatMonth(byMonth.get(key) ?? []));
    files.push(file);
  }
  return files;
}
