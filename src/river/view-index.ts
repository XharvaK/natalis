// The seqs of the view rows, per view key, kept in memory. A view key names the newest game view a turn shows (the row's
// data holds it as "view"). The index is built by one scan at start and kept up to date on every append, so the newest
// view of a key at or before a snapshot is found without a scan of the river on each turn (CORE3-6). A row forgotten since
// it was indexed loses its key in the river, so a lookup that does not confirm its row says nothing, and the caller scans.

import type { River, RiverRow } from "../contracts.js";

/** The rows read at a time when the index is built. */
const BUILD_PAGE = 500;

/** The view key of a row, or undefined when it has none. */
export function viewKeyOfRow(row: { data?: Record<string, unknown> }): string | undefined {
  const view = row.data?.["view"];
  return typeof view === "string" ? view : undefined;
}

export class ViewIndex {
  /** Per key, the seqs of its event rows, oldest first (a seq is only ever added at the end: the river only appends). */
  private readonly seqs = new Map<string, number[]>();

  /** Notes a stored row: an event with a view key is added under that key. */
  note(row: RiverRow): void {
    if (row.kind !== "event") return;
    const key = viewKeyOfRow(row);
    if (key === undefined) return;
    const list = this.seqs.get(key);
    if (list === undefined) this.seqs.set(key, [row.seq]);
    else if (list[list.length - 1]! < row.seq) list.push(row.seq);
  }

  /** Builds the index from the whole river, oldest row first: one scan, page by page. */
  build(river: River): void {
    let since = 0;
    for (;;) {
      const page = river.read({ kinds: ["event"], sinceSeq: since, limit: BUILD_PAGE });
      if (page.length === 0) return;
      for (const row of page) this.note(row);
      since = page[page.length - 1]!.seq;
    }
  }

  /** The newest seq of a key at or before a seq, or undefined when the key has no row that early. */
  atOrBefore(key: string, seq: number): number | undefined {
    const list = this.seqs.get(key);
    if (list === undefined || list.length === 0 || list[0]! > seq) return undefined;
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (list[middle]! <= seq) low = middle;
      else high = middle - 1;
    }
    return list[low];
  }
}

/** A river that answers as the river does, and notes each row it appends in the index. */
export function indexedRiver(river: River, index: ViewIndex): River {
  return {
    ...river,
    append(row) {
      const stored = river.append(row);
      index.note(stored);
      return stored;
    },
  };
}
