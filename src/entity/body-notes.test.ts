import { describe, expect, it } from "vitest";
import type { RiverRow } from "../contracts.js";
import { bodyNotesBlock, domusReceipts } from "./body-notes.js";

// Invented rows only. Times in UTC, shown as ISO by the test formatter.
const T = Date.UTC(2026, 9, 26, 4, 58, 37);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
let seq = 0;
function row(input: Partial<RiverRow> & { thread: string }): RiverRow {
  seq += 1;
  return { kind: "event", source: "outside", atMs: T, seq, ...input } as RiverRow;
}
const view = (atMs: number, clock: string) =>
  row({ thread: "domus:slot8", atMs, text: `Your sim is home.\n${clock}\nOptions...`, data: { view: "domus" } });
const detach = (atMs: number) => row({ thread: "domus:slot8", atMs, source: "body", text: "The game is no longer attached.", data: { attached: false } });

describe("domusReceipts (N2c)", () => {
  it("states the last session's first and last view, the detach after it, and the clock of the last view, with seqs", () => {
    seq = 100;
    const rows = [
      view(T - 86_400_000, "Game time: Sunday 08:00, running (clock speed NORMAL)."),
      detach(T - 86_000_000),
      view(T, "Game time: Monday 08:00, running (clock speed NORMAL)."),
      row({ thread: "dm:owner", atMs: T + 1000, text: "hi" }),
      view(T + 193_000, "Game time: Monday 09:00, paused (clock speed NORMAL)."),
      detach(T + 202_000),
    ];
    const receipts = domusReceipts([...rows].reverse(), fmt);
    expect(receipts).toEqual([
      "Domus: attached from 2026-10-26 04:58:37 (seq 103) to the last view at 2026-10-26 05:01:50 (seq 105); not attached since 2026-10-26 05:01:59 (seq 106).",
      "Domus clock at the last view (seq 105): Game time: Monday 09:00, paused (clock speed NORMAL).",
    ]);
  });

  it("says still attached at the last view when no detach came after it", () => {
    seq = 0;
    const rows = [view(T, "The game is running.")];
    expect(domusReceipts(rows, fmt)).toEqual([
      "Domus: attached from 2026-10-26 04:58:37 (seq 1) to the last view at 2026-10-26 04:58:37 (seq 1); no detach after it.",
      "Domus clock at the last view (seq 1): The game is running.",
    ]);
  });

  it("says nothing when there is no Domus view, and skips forgotten rows", () => {
    seq = 0;
    expect(domusReceipts([row({ thread: "dm:owner", text: "hello" })], fmt)).toEqual([]);
    const forgotten = { ...view(T, "Game time: Monday 08:00, running."), forgotten: true };
    expect(domusReceipts([forgotten], fmt)).toEqual([]);
  });

  it("never judges her text: the block is receipts only, under one heading, at most five lines", () => {
    const block = bodyNotesBlock(["a", "b", "c", "d", "e", "f"]);
    expect(block.split("\n")).toHaveLength(6);
    expect(block.startsWith("Body notes (receipts the host keeps; yours to compare):")).toBe(true);
    expect(block).not.toMatch(/disagree/i);
    expect(bodyNotesBlock([])).toBe("");
  });
});
