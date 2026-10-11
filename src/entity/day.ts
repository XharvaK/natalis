// Local days for an entity: a day runs from midnight to midnight in the entity's zone, or the host's zone when the
// entity names none. The daily turn limit and the dates the summoner's commands write both use these.

/** The host's zone name, for words that must say which zone a time is in. */
export function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The local calendar day of a moment, as YYYY-MM-DD. */
export function dayKey(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Milliseconds from a moment until the next local midnight. Never less than one second. */
export function msUntilNextDay(ms: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const intoDayMs = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000 + (((ms % 1000) + 1000) % 1000);
  return Math.max(1000, 86_400_000 - intoDayMs);
}
