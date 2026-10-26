// How a moment reads in the entity's context: a time alone for today, and a date with its age for any earlier day, so
// an old line is never mistaken for one from today. Days are local to the entity's zone, or Europe/Istanbul.

import { dayKey } from "./day.js";

/** The zone used when the entity names none. */
export const DEFAULT_TIME_ZONE = "Europe/Istanbul";

const DAY_MS = 86_400_000;

/** "14:05" for today; "2026-10-24 14:05, 1 day ago" (or "N days ago") for an earlier day, in the given zone. */
export function whenText(atMs: number, nowMs: number, timeZone: string | undefined): string {
  const zone = timeZone ?? DEFAULT_TIME_ZONE;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(atMs),
  );
  const day = dayKey(atMs, zone);
  const today = dayKey(nowMs, zone);
  if (day === today) return time;
  const days = Math.max(1, Math.round(Math.abs(Date.parse(today) - Date.parse(day)) / DAY_MS));
  const span = days === 1 ? "1 day" : `${days} days`;
  // A later day (clock skew or a bad stamp) is dated too, so it is never read as today.
  return day > today ? `${day} ${time}, ${span} ahead` : `${day} ${time}, ${span} ago`;
}
