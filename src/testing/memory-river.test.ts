import { describe, expect, it } from "vitest";
import { MemoryRiver } from "./memory-river.js";

// Invented fixtures only: a garden room and two people.
function riverWithRows(): MemoryRiver {
  const river = new MemoryRiver({ nowMs: () => 1_000 });
  river.append({ thread: "dm:owner", kind: "event", source: "owner", actor: "owner", text: "Mara brought the seeds." });
  river.append({ thread: "room:garden", kind: "say", source: "self", text: "The seeds are in the garden room." });
  river.append({ thread: "dm:owner", kind: "tool_call", source: "self", text: "read_note", data: { args: "{}" } });
  river.append({ thread: "room:garden", kind: "event", source: "outside", actor: "tomas", text: "Tomas says hello, SEEDS and all." });
  return river;
}

describe("MemoryRiver", () => {
  it("gives rows increasing seq numbers, the clock time, and keeps them in order", () => {
    const river = riverWithRows();
    const rows = river.read({});

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.atMs === 1_000)).toBe(true);
    expect(river.lastSeq()).toBe(4);
  });

  it("filters by thread, kind, seq window and time, and limits newest first when asked", () => {
    const river = riverWithRows();

    expect(river.read({ thread: "room:garden" }).map((r) => r.seq)).toEqual([2, 4]);
    expect(river.read({ kinds: ["tool_call"] }).map((r) => r.seq)).toEqual([3]);
    expect(river.read({ sinceSeq: 2 }).map((r) => r.seq)).toEqual([3, 4]);
    expect(river.read({ untilSeq: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    expect(river.read({ sinceMs: 2_000 })).toEqual([]);
    expect(river.read({ newestFirst: true, limit: 2 }).map((r) => r.seq)).toEqual([4, 3]);
    expect(river.read({ limit: 1 }).map((r) => r.seq)).toEqual([1]);
  });

  it("returns copies, so a caller cannot change what was written", () => {
    const river = riverWithRows();
    const [first] = river.read({ kinds: ["tool_call"] });
    if (first?.data) first.data["args"] = "changed";

    expect(river.read({ kinds: ["tool_call"] })[0]?.data).toEqual({ args: "{}" });
  });

  it("searches row text case-insensitively, most matches first, and skips rows with no text", () => {
    const river = riverWithRows();

    const hits = river.search("seeds");
    expect(hits.map((h) => h.row.seq)).toEqual([4, 2, 1]);
    expect(hits[0]?.score).toBe(1);
    expect(river.search("")).toEqual([]);
    // Only text is searched, never data, and a row with no text cannot match.
    river.append({ thread: "dm:owner", kind: "turn", source: "body", data: { phase: "start" } });
    expect(river.search("start")).toEqual([]);
    expect(river.search("seeds", { thread: "dm:owner", limit: 5 }).map((h) => h.row.seq)).toEqual([1]);
    expect(river.search("seeds", { limit: 1 })).toHaveLength(1);
  });

  it("forgets by text: erases text and data, keeps seq, time, thread and kind, and writes one tombstone", () => {
    const river = riverWithRows();

    const erased = river.forget({ text: "SEEDS" }, "self", "Not mine to keep.");

    expect(erased).toBe(3);
    const rows = river.read({});
    const kept = rows.find((r) => r.seq === 2);
    expect(kept).toMatchObject({ seq: 2, atMs: 1_000, thread: "room:garden", kind: "say" });
    expect(kept?.text).toBeUndefined();
    expect(river.read({ sinceSeq: 4 })).toHaveLength(1);
    expect(river.read({ sinceSeq: 4 })[0]).toMatchObject({ kind: "tombstone", source: "self", data: { erased: 3, by: "self", reason: "Not mine to keep." } });
    expect(river.read({ sinceSeq: 4 })[0]?.text).toBeUndefined();
    expect(river.search("seeds")).toEqual([]);
    expect(river.lastSeq()).toBe(5);
  });

  it("forgets by seq, marks the owner as the one who forgot, and does not erase twice", () => {
    const river = riverWithRows();

    expect(river.forget({ seqs: [1, 2] }, "owner", "Owner asked.")).toBe(2);
    expect(river.forget({ seqs: [1, 2] }, "owner", "Owner asked again.")).toBe(0);
    expect(river.read({ sinceSeq: 4 })[0]).toMatchObject({ kind: "tombstone", source: "owner" });
  });

  it("matches both seqs and text when both are given", () => {
    const river = riverWithRows();

    expect(river.forget({ seqs: [1, 2], text: "garden" }, "self", "Narrow.")).toBe(1);
    expect(river.read({}).find((r) => r.seq === 1)?.text).toBe("Mara brought the seeds.");
  });

  it("erases nothing and writes no tombstone when nothing matches, or the text is empty", () => {
    const river = riverWithRows();
    const before = river.lastSeq();

    expect(river.forget({ text: "pumpkins" }, "self", "None.")).toBe(0);
    expect(river.forget({ text: "" }, "self", "Empty.")).toBe(0);
    expect(river.forget({}, "self", "Nothing given.")).toBe(0);
    expect(river.lastSeq()).toBe(before);
  });

  it("is a no-op to close", () => {
    expect(() => riverWithRows().close()).not.toThrow();
  });
});
