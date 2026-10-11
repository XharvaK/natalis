// In-memory River for tests. It follows the River contract in src/contracts.ts and is not for production.
// Choices this fake makes where the contract is silent:
// - read: sinceSeq is exclusive (seq > sinceSeq), untilSeq is inclusive (seq <= untilSeq).
//   An empty kinds list means "no kind filter".
// - read and search return copies. An erased row comes back without text, data, place or actor.
// - search: case-insensitive substring over row text, most occurrences first, then newest first.
// - forget: when both seqs and text are given, a row must match both. An empty text matches nothing.
//   A tombstone row is appended only when at least one row was erased.

import type { River, RiverHit, RiverQuery, RiverRow, RiverRowInput } from "../contracts.js";

export type MemoryRiverOptions = { nowMs?: () => number };

export class MemoryRiver implements River {
  private readonly rows: RiverRow[] = [];
  private readonly erased = new Set<number>();
  private nextSeq = 1;
  private readonly nowMs: () => number;

  constructor(options: MemoryRiverOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  append(input: RiverRowInput): RiverRow {
    const row: RiverRow = {
      ...input,
      data: input.data === undefined ? undefined : structuredClone(input.data),
      seq: this.nextSeq++,
      atMs: input.atMs ?? this.nowMs(),
    };
    this.rows.push(row);
    return copyRow(row);
  }

  read(query: RiverQuery): RiverRow[] {
    const ordered = this.rows
      .filter((row) => matches(row, query))
      .sort((a, b) => (query.newestFirst ? b.seq - a.seq : a.seq - b.seq));
    const limited = query.limit === undefined ? ordered : ordered.slice(0, query.limit);
    return limited.map(copyRow);
  }

  search(text: string, options: { limit?: number; thread?: string } = {}): RiverHit[] {
    const needle = text.toLowerCase();
    if (needle === "") return [];
    const hits: RiverHit[] = [];
    for (const row of this.rows) {
      if (!this.searchable(row)) continue;
      if (options.thread !== undefined && row.thread !== options.thread) continue;
      const score = countOccurrences((row.text ?? "").toLowerCase(), needle);
      if (score > 0) hits.push({ row: copyRow(row), score });
    }
    hits.sort((a, b) => b.score - a.score || b.row.seq - a.row.seq);
    return options.limit === undefined ? hits : hits.slice(0, options.limit);
  }

  forget(match: { seqs?: number[]; text?: string }, by: "owner" | "self", reason: string): number {
    if (match.seqs === undefined && match.text === undefined) return 0;
    if (match.text === "") return 0;
    const needle = match.text?.toLowerCase();
    const seqs = match.seqs === undefined ? undefined : new Set(match.seqs);
    const targets = this.rows.filter((row) => {
      if (!this.searchable(row)) return false;
      if (seqs !== undefined && !seqs.has(row.seq)) return false;
      if (needle !== undefined && !(row.text ?? "").toLowerCase().includes(needle)) return false;
      return true;
    });
    if (targets.length === 0) return 0;

    for (const row of targets) {
      delete row.text;
      delete row.data;
      delete row.place;
      delete row.actor;
      this.erased.add(row.seq);
    }
    const threads = new Set(targets.map((row) => row.thread));
    this.rows.push({
      thread: threads.size === 1 ? [...threads][0] ?? "self" : "self",
      kind: "tombstone",
      source: by === "owner" ? "owner" : "self",
      data: { erased: targets.length, seqs: targets.map((row) => row.seq), by, reason },
      seq: this.nextSeq++,
      atMs: this.nowMs(),
    });
    return targets.length;
  }

  lastSeq(): number {
    return this.nextSeq - 1;
  }

  close(): void {
    // Nothing to release in memory.
  }

  private searchable(row: RiverRow): boolean {
    return row.kind !== "tombstone" && !this.erased.has(row.seq);
  }
}

function matches(row: RiverRow, query: RiverQuery): boolean {
  if (query.thread !== undefined && row.thread !== query.thread) return false;
  if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(row.kind)) return false;
  if (query.sinceSeq !== undefined && row.seq <= query.sinceSeq) return false;
  if (query.untilSeq !== undefined && row.seq > query.untilSeq) return false;
  if (query.sinceMs !== undefined && row.atMs < query.sinceMs) return false;
  return true;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function copyRow(row: RiverRow): RiverRow {
  return { ...row, data: row.data === undefined ? undefined : structuredClone(row.data) };
}
