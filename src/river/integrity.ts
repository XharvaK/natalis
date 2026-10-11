// Startup check: a river that came back shorter than it was must not run. A store that silently
// reopened empty (or older) would let the entity act on a memory it no longer has.

import type { River } from "../contracts.js";

export type IntegrityResult = { ok: true } | { ok: false; reason: string };

/** `expected.minSeq` is the last seq the caller knows was written (its last known count). */
export function checkRiver(river: River, expected: { minSeq: number }): IntegrityResult {
  if (!Number.isSafeInteger(expected.minSeq) || expected.minSeq < 0) {
    throw new Error("expected.minSeq must be a whole number, 0 or more");
  }
  const last = river.lastSeq();
  if (!Number.isSafeInteger(last) || last < 0) {
    return { ok: false, reason: `the river reports an unreadable last seq (${String(last)})` };
  }
  if (last < expected.minSeq) {
    return {
      ok: false,
      reason: `the river ends at seq ${last}, but seq ${expected.minSeq} was known to exist; it may have come back empty or older. Not starting.`,
    };
  }
  return { ok: true };
}
