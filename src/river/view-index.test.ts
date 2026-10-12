import { describe, expect, it } from "vitest";
import type { River, RiverRow } from "../contracts.js";
import { indexedRiver, ViewIndex } from "./view-index.js";

function row(seq: number, kind: string, view?: string): RiverRow {
  return { seq, atMs: seq, thread: "domus:slot3", kind, source: "outside", ...(view === undefined ? {} : { data: { view } }) } as RiverRow;
}

describe("the view index (CORE3-6): the newest seq of a key at or before a seq, kept in memory", () => {
  it("finds the newest view of a key at or before a snapshot, and nothing before the first", () => {
    const index = new ViewIndex();
    for (const item of [row(2, "event", "game"), row(3, "event"), row(5, "event", "game"), row(7, "event", "game"), row(8, "say", "game")]) {
      index.note(item);
    }
    expect(index.atOrBefore("game", 6)).toBe(5);
    expect(index.atOrBefore("game", 7)).toBe(7);
    expect(index.atOrBefore("game", 100)).toBe(7);
    expect(index.atOrBefore("game", 1)).toBeUndefined();
    expect(index.atOrBefore("other", 100)).toBeUndefined();
  });

  it("builds from the river in pages, oldest first, and keeps up to date on each append", () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => row(index + 1, "event", index % 400 === 0 ? "game" : undefined));
    const river = {
      read(query: { sinceSeq?: number; limit?: number }) {
        const since = query.sinceSeq ?? 0;
        return rows.filter((item) => item.seq > since).slice(0, query.limit ?? 100);
      },
    } as unknown as River;
    const index = new ViewIndex();
    index.build(river);
    expect(index.atOrBefore("game", 1_199)).toBe(801);
    expect(index.atOrBefore("game", 400)).toBe(1);

    const appended: RiverRow[] = [];
    const wrapped = indexedRiver({ ...river, append: (input: { kind: string }) => {
      const stored = row(1_201, input.kind, "game");
      appended.push(stored);
      return stored;
    } } as unknown as River, index);
    wrapped.append({ kind: "event" } as never);
    expect(index.atOrBefore("game", 2_000)).toBe(1_201);
    expect(appended).toHaveLength(1);
  });
});
