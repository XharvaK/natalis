import { describe, expect, it } from "vitest";
import { planRetry, QUOTA_BACKOFF_CAP_MS, RESET_MARGIN_MS } from "./retry-plan.js";

const DELAYS = [30_000, 60_000, 120_000, 300_000, 600_000];
const NOW = Date.UTC(2026, 9, 25, 20, 4, 58);
const base = { delays: DELAYS, failed: 6, unknownQuotaFails: 0, nowMs: NOW, random: () => 0.5 };

describe("planRetry", () => {
  it("waits a named weekly reset out, plus the margin and some jitter, instead of every 10 min", () => {
    const resetAtMs = NOW + 14_102_000;
    const plan = planRetry({ ...base, kind: "out_of_credit", quota: { limit: "weekly", resetAtMs } });
    expect(plan.basis).toBe("reset");
    expect(plan.delayMs).toBe(14_102_000 + RESET_MARGIN_MS + 30_000);
    expect(plan.reason).toContain("weekly limit");
  });

  it("uses the reset for a rate limit too, and a reset already past waits only the margin", () => {
    const plan = planRetry({ ...base, kind: "rate_limit", quota: { resetAtMs: NOW - 5_000 }, random: () => 0 });
    expect(plan).toMatchObject({ basis: "reset", delayMs: RESET_MARGIN_MS });
  });

  it("backs off 10, 20, 40, 80 min then every 2 h when a quota is spent and its reset is unknown", () => {
    const waits = [0, 1, 2, 3, 4, 5].map(
      (unknownQuotaFails) => planRetry({ ...base, kind: "out_of_credit", quota: { limit: "5-hour" }, unknownQuotaFails }).delayMs,
    );
    expect(waits).toEqual([600_000, 1_200_000, 2_400_000, 4_800_000, QUOTA_BACKOFF_CAP_MS, QUOTA_BACKOFF_CAP_MS]);
  });

  it("keeps the normal schedule for other failures and for a rate limit with no reset", () => {
    expect(planRetry({ ...base, failed: 0, kind: "unavailable", quota: undefined })).toMatchObject({ basis: "schedule", delayMs: 30_000 });
    expect(planRetry({ ...base, kind: "rate_limit", quota: { limit: "weekly" } })).toMatchObject({ basis: "schedule", delayMs: 600_000 });
    expect(planRetry({ ...base, kind: "timeout", quota: { resetAtMs: NOW + 1e9 } })).toMatchObject({ basis: "schedule" });
  });
});
