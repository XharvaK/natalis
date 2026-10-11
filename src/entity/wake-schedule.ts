// The rhythm of a repeating wake: the next local occurrence of a daily or weekly wake in the Lar's zone. Pure date math:
// the clock is never read here, every instant is passed in. A wall-clock time is kept as text ("09:00") so it stays
// the same across daylight-saving changes. A local time that does not exist (the clocks jump forward over it) takes the
// first instant after it; a local time that happens twice takes the first of the two.

export type WakeRepeat = "daily" | "weekly";

/** The most wakes the Lar may hold at once, repeating or not. A resource limit, not a judgment. */
export const WAKE_LIMIT = 100;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether a repeat value is one the body keeps: "daily" or "weekly". */
export function isWakeRepeat(value: unknown): value is WakeRepeat {
  return value === "daily" || value === "weekly";
}

/** "HH:MM" when the text is a clock time of the day, else undefined. */
export function parseClock(text: string): string | undefined {
  return CLOCK.test(text) ? text : undefined;
}

/** The local clock of an instant in a zone, as "HH:MM". Zone undefined means the host's zone. */
export function clockOf(ms: number, timeZone: string | undefined): string {
  const parts = zoneParts(ms, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** The local calendar day of an instant in a zone, as YYYY-MM-DD. */
export function localDayOf(ms: number, timeZone: string | undefined): string {
  const parts = zoneParts(ms, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * The first occurrence of a repeating wake strictly after both `fromMs` and `afterMs`. `fromMs` is the occurrence that
 * fired (or the one just set); its local calendar day is the series' day, so each step keeps the clock and the weekday.
 * A host that was down across several occurrences gets only the next future one: nothing is replayed.
 */
export function nextOccurrence(input: {
  fromMs: number;
  afterMs: number;
  repeat: WakeRepeat;
  clock: string;
  timeZone: string | undefined;
}): number {
  const { fromMs, repeat, clock, timeZone } = input;
  const limit = Math.max(fromMs, input.afterMs);
  const day = zoneParts(fromMs, timeZone);
  const stepDays = repeat === "weekly" ? 7 : 1;
  const stepMs = stepDays * DAY_MS;
  // Every occurrence lands within an hour of its nominal time, so starting one step short of the elapsed count never
  // skips an occurrence that is due: a long downtime costs one loop step, not one per missed occurrence.
  const elapsedSteps = Math.floor(Math.max(0, limit - fromMs) / stepMs);
  let k = Math.max(1, elapsedSteps - 1);
  for (;;) {
    const candidate = instantOfLocal(addDays(day.year, day.month, day.day, k * stepDays), clock, timeZone);
    if (candidate > limit) return candidate;
    k += 1;
  }
}

/**
 * The first instant a daily wake at a local clock time fires, strictly after `afterMs`: today's occurrence if it is still
 * ahead, else tomorrow's. The body uses it for the rhythm a Lar is given on its first start.
 */
export function firstDailyOccurrence(input: { afterMs: number; clock: string; timeZone: string | undefined }): number {
  const { afterMs, clock, timeZone } = input;
  const today = zoneParts(afterMs, timeZone);
  for (let k = 0; k <= 2; k += 1) {
    const candidate = instantOfLocal(addDays(today.year, today.month, today.day, k), clock, timeZone);
    if (candidate > afterMs) return candidate;
  }
  throw new RangeError(`No occurrence of ${clock} follows the instant given.`);
}

/** The instant of a local wall-clock time on a calendar day, in a zone. Zone undefined means the host's zone. */
export function instantOfLocal(
  day: { year: number; month: number; day: number },
  clock: string,
  timeZone: string | undefined,
): number {
  const match = CLOCK.exec(clock);
  if (match === null) throw new RangeError(`Not a clock time: ${clock}.`);
  const target = Date.UTC(day.year, day.month - 1, day.day, Number(match[1]), Number(match[2]));
  const before = offsetAt(target - DAY_MS, timeZone);
  const after = offsetAt(target + DAY_MS, timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => target - offset)
    .filter((candidate) => offsetAt(candidate, timeZone) === target - candidate);
  if (valid.length > 0) return Math.min(...valid);
  // The local time falls in a gap. The first instant whose wall clock has reached it is the moment the gap starts.
  return firstReaching(target, before, after, timeZone);
}

/** Binary search for the first instant whose local wall clock is at least `target`, in the window around a gap. */
function firstReaching(target: number, before: number, after: number, timeZone: string | undefined): number {
  let low = target - Math.max(before, after) - HOUR_MS;
  let high = target - Math.min(before, after) + HOUR_MS;
  const reached = (ms: number): boolean => ms + offsetAt(ms, timeZone) >= target;
  if (reached(low) || !reached(high)) return target - before;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (reached(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** The offset of a zone from UTC at an instant, in milliseconds (whole seconds). */
function offsetAt(ms: number, timeZone: string | undefined): number {
  const parts = zoneParts(ms, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zoneParts(ms: number, timeZone: string | undefined): ZoneParts {
  const formatter = formatterFor(timeZone);
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"] ?? 0,
    month: values["month"] ?? 1,
    day: values["day"] ?? 1,
    hour: values["hour"] ?? 0,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0,
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      ...(timeZone === undefined ? {} : { timeZone }),
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** The calendar day `days` after a calendar date (days may be negative), as plain numbers. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A date, with an optional time (T or a space between), and no offset. */
const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * The instant an at_iso names. A date and time with no offset is read in the Lar's own zone, the zone its clock and its
 * repeating wakes use; one with an offset or Z is read as it is. NaN when the text is not a date and time.
 */
export function parseAtIso(text: string, timeZone: string | undefined): number {
  const match = LOCAL_ISO.exec(text.trim());
  if (match === null) return Date.parse(text);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  // Date.UTC rolls an impossible day (such as February 30) over; a round trip that does not match is refused.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const real = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  if (!real || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return instantOfLocal({ year, month, day }, clock, timeZone) + second * 1000;
}
