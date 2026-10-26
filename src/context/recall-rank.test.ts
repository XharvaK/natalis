import { describe, expect, it } from "vitest";
import { decayOf, rankRecall, RECALL_HALF_LIFE_MS } from "./recall-rank.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27);
const hit = (seq: number, ageMs: number, matches: number) => ({ seq, atMs: NOW - ageMs, matches });

describe("recall ranking with time decay", () => {
  it("decays by half each half-life, and a future time counts as now", () => {
    expect(decayOf(NOW, NOW)).toBe(1);
    expect(decayOf(NOW - RECALL_HALF_LIFE_MS, NOW)).toBeCloseTo(0.5);
    expect(decayOf(NOW + DAY, NOW)).toBe(1);
  });

  it("more matched words still win over newer rows with fewer", () => {
    const order = rankRecall([hit(1, 400 * DAY, 2), hit(2, 0, 1)], NOW).map((h) => h.seq);
    expect(order).toEqual([1, 2]);
  });

  it("among equal matches a fresher row wins, as before", () => {
    expect(rankRecall([hit(1, 10 * DAY, 1), hit(2, 1 * DAY, 1)], NOW).map((h) => h.seq)).toEqual([2, 1]);
  });

  it("a very old row with one more match loses to fresh rows with two more matches against it only when decay is large", () => {
    // 3 matches a year ago against 2 matches today: today's 2 * 1 = 2 vs 3 * (0.5 + 0.5 * tiny) ~ 1.5.
    expect(rankRecall([hit(1, 365 * DAY, 3), hit(2, 0, 2)], NOW).map((h) => h.seq)).toEqual([2, 1]);
  });
});
