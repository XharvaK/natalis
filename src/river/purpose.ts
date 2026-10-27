// Why a turn ran: live (the real Lar), reflect (the real Lar thinking on its own), eval (a scenario eval on a throwaway
// Lar) or replay (a copy re-run on a virtual clock). Stamped on turn rows. A row with no purpose, or one this code does
// not know, reads as live, so a counter that keeps only live rows never leaves a real turn out.

export type Purpose = "live" | "reflect" | "eval" | "replay";

export function purposeOf(row: { data?: Record<string, unknown> | undefined }): Purpose {
  const value = row.data?.["purpose"];
  return value === "reflect" || value === "eval" || value === "replay" ? value : "live";
}

/** Only an eval or a replay turn is not the real Lar's: a reflect turn is the Lar's own, so it counts as live. */
export function isLive(row: { data?: Record<string, unknown> | undefined }): boolean {
  const purpose = purposeOf(row);
  return purpose !== "eval" && purpose !== "replay";
}
