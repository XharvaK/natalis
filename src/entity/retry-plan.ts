// When a failed turn is tried again. A spent quota whose reset the provider named is waited out to that reset plus a
// small margin, but a plain rate limit whose reset is shorter than that margin waits max(reset + 5 s + 0-5 s jitter, the normal step), ramping to the margin by twice the margin; a spent quota with no known reset backs off (10, 20, 40, 80 min, then every 2 h); anything else keeps the
// runtime's normal schedule (30 s, 1, 2, 5 min, then every 10 min). The in-call Retry-After cap (60 s) is separate.

import type { ModelErrorKind, QuotaWindow } from "../contracts.js";

/** Added after a named reset, so the provider's own clock has surely passed it. */
export const RESET_MARGIN_MS = 3 * 60_000;
/** Added to a short plain rate-limit reset instead of the margin and jitter. */
export const SHORT_RESET_PAD_MS = 5_000;
/** Up to this much jitter on a short plain rate-limit reset. */
export const SHORT_RESET_JITTER_MS = 5_000;
/** Up to this much more, at random, so retries after a reset do not all land in the same second. */
export const RESET_JITTER_MS = 60_000;
/** The longest wait for a named reset (a monthly limit can be weeks away; the daily wake and new events still run). */
export const RESET_WAIT_CAP_MS = 8 * 24 * 60 * 60_000;
/** The backoff while a quota is spent and its reset is not known. */
export const QUOTA_BACKOFF_START_MS = 10 * 60_000;
export const QUOTA_BACKOFF_CAP_MS = 2 * 60 * 60_000;

/** The limits quotaWindow names: each lasts hours or more. */
const NAMED_LIMITS: ReadonlySet<string> = new Set(["5-hour", "daily", "weekly", "monthly"]);

export type RetryInput = {
  /** The runtime's normal schedule, and how many turns in this thread failed in a row before this one. */
  delays: readonly number[];
  failed: number;
  kind: ModelErrorKind | undefined;
  quota: QuotaWindow | undefined;
  /** Failures in a row in this thread that were a spent quota with no known reset, before this one. */
  unknownQuotaFails: number;
  nowMs: number;
  random?: () => number;
  /** Overrides for the margins and the backoff (tests use small ones). */
  tuning?: QuotaRetryTuning;
};

export type QuotaRetryTuning = { marginMs?: number; jitterMs?: number; backoffStartMs?: number; backoffCapMs?: number };

export type RetryPlan = {
  delayMs: number;
  /** "reset" (waited to a named reset), "quota_backoff" (spent quota, reset unknown) or "schedule" (the normal one). */
  basis: "reset" | "quota_backoff" | "schedule";
  /** One plain line for the journal: why this wait. */
  reason: string;
};

export function planRetry(input: RetryInput): RetryPlan {
  const { kind, quota, nowMs } = input;
  const quotaKind = kind === "out_of_credit" || kind === "rate_limit";
  const limit = quota?.limit === undefined ? "" : ` (${quota.limit} limit)`;
  const scheduleMs = input.delays[Math.min(input.failed, input.delays.length - 1)] ?? 0;
  const named = quota?.limit !== undefined && NAMED_LIMITS.has(quota.limit);
  const margin = input.tuning?.marginMs ?? RESET_MARGIN_MS;
  // A plain rate limit (not a quota, no named limit) resets in seconds: the 3-min margin and jitter would only add delay.
  // Below the margin it waits reset + 5 s + 0-5 s jitter; from the margin to twice it the pad and jitter ramp up to the
  // margin and 60 s, so there is no cliff at the margin (R8 S2). The normal step is the floor.
  if (kind === "rate_limit" && !named && quota?.resetAtMs !== undefined && quota.resetAtMs - nowMs < 2 * margin) {
    const untilReset = Math.max(0, quota.resetAtMs - nowMs);
    const ramp = Math.min(1, Math.max(0, (untilReset - margin) / margin));
    const pad = SHORT_RESET_PAD_MS + ramp * Math.max(0, margin - SHORT_RESET_PAD_MS);
    const jitterMax = SHORT_RESET_JITTER_MS + ramp * Math.max(0, (input.tuning?.jitterMs ?? RESET_JITTER_MS) - SHORT_RESET_JITTER_MS);
    const resetMs = Math.round(untilReset + pad + (input.random ?? Math.random)() * jitterMax);
    if (scheduleMs >= resetMs) {
      return { delayMs: scheduleMs, basis: "schedule", reason: `rate_limit, short provider reset, normal schedule step ${input.failed + 1}` };
    }
    return { delayMs: resetMs, basis: "reset", reason: `rate_limit, short provider reset, waiting ${resetMs} ms` };
  }
  if (quotaKind && quota?.resetAtMs !== undefined) {
    const jitter = Math.floor((input.random ?? Math.random)() * (input.tuning?.jitterMs ?? RESET_JITTER_MS));
    const delayMs = Math.min(RESET_WAIT_CAP_MS, Math.max(0, quota.resetAtMs - nowMs) + margin + jitter);
    const at = new Date(quota.resetAtMs);
    const resetText = Number.isFinite(at.getTime()) ? at.toISOString() : "an out-of-range time";
    return { delayMs, basis: "reset", reason: `${kind}${limit}, provider reset at ${resetText}, waiting past it` };
  }
  // A named hours-scale limit is a spent quota whatever the kind, so a weekly 429 with no reset is not retried every 30 s.
  if (kind === "out_of_credit" || (quotaKind && named)) {
    const start = input.tuning?.backoffStartMs ?? QUOTA_BACKOFF_START_MS;
    const cap = input.tuning?.backoffCapMs ?? QUOTA_BACKOFF_CAP_MS;
    const delayMs = Math.min(cap, start * 2 ** Math.min(input.unknownQuotaFails, 20));
    return { delayMs, basis: "quota_backoff", reason: `${kind}${limit}, reset unknown, backoff step ${input.unknownQuotaFails + 1}` };
  }
  return { delayMs: scheduleMs, basis: "schedule", reason: `${kind ?? "error"}, normal schedule step ${input.failed + 1}` };
}
