// Recall ranking: rows are scored by how many of the new words they match, weighted by age. The weight is
// 0.5 + 0.5 * 2^(-age / half-life), so an old row keeps at least half its weight and more matched words still win
// over a small age difference; among equal matches the fresher row wins. Ties fall back to the newest seq.
// A row the Lar marked important carries a weight of 1 to 3; the score is multiplied by 1 + 0.5 * weight. An
// unmarked row (weight 0) keeps exactly today's score and order.

export const RECALL_HALF_LIFE_MS = 90 * 86_400_000;

export type RecallCandidate = { seq: number; atMs: number; matches: number; weight?: number };

export function decayOf(atMs: number, nowMs: number, halfLifeMs = RECALL_HALF_LIFE_MS): number {
  const age = Math.max(0, nowMs - atMs);
  return Math.pow(2, -age / halfLifeMs);
}

export function recallScore(c: RecallCandidate, nowMs: number): number {
  return c.matches * (0.5 + 0.5 * decayOf(c.atMs, nowMs)) * (1 + 0.5 * (c.weight ?? 0));
}

export function rankRecall<T extends RecallCandidate>(candidates: readonly T[], nowMs: number): T[] {
  return [...candidates].sort((a, b) => recallScore(b, nowMs) - recallScore(a, nowMs) || b.seq - a.seq);
}
