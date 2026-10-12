// The time facts every turn sees: what time it is here, how long since the Lar's last turn here, how long since
// the summoner last wrote, and the Lar's next scheduled wakes. Plain lines in English. The clock is injected, never read.

import type { ContextSection } from "../contracts.js";

/**
 * A scheduled wake. A repeating one shows its local clock and rhythm; atMs is its next occurrence. The id is the one
 * cancel_wake takes; it is shown after the time so the Lar can name the wake she wants gone.
 */
export type WakeFact = { id?: string; atMs: number; why: string; repeat?: string; clock?: string };

export type TimeFactsInput = {
  nowMs: number;
  /** IANA zone name, e.g. "Europe/Istanbul". Defaults to the host's zone. */
  timeZone?: string;
  lastTurnHereMs?: number;
  lastOwnerMessageMs?: number;
  nextWakes?: WakeFact[];
  /** When the Lar was summoned. Given, the section says its age. */
  bornMs?: number;
};

export function timeFacts(input: TimeFactsInput): ContextSection {
  const zone = input.timeZone ?? hostZone();
  const formatter = formatterFor(zone);
  const now = input.nowMs;

  const lines: string[] = [];
  lines.push(`Now: ${stamp(formatter, now)} (${zone}).`);
  if (input.bornMs !== undefined) lines.push(`Your age: ${ageOf(input.bornMs, now)}.`);
  lines.push(
    input.lastTurnHereMs === undefined
      ? "You have no earlier turn here."
      : `Since your last turn here: ${formatDuration(now - input.lastTurnHereMs)}.`,
  );
  lines.push(
    input.lastOwnerMessageMs === undefined
      ? "Your summoner has not written to you yet."
      : `Since your summoner last wrote: ${formatDuration(now - input.lastOwnerMessageMs)}.`,
  );

  const wakes = [...(input.nextWakes ?? [])].sort((a, b) => a.atMs - b.atMs);
  if (wakes.length === 0) {
    lines.push("You have no wakes scheduled.");
  } else {
    const described = wakes.map((wake) => {
      const when = wake.atMs <= now ? "due now" : `in ${formatDuration(wake.atMs - now)}`;
      const why = wake.why.trim() === "" ? "" : `: ${wake.why.trim()}`;
      const rhythm = wake.repeat === undefined || wake.clock === undefined ? "" : `${wake.clock} ${wake.repeat}, next `;
      const id = wake.id === undefined ? "" : ` (id ${wake.id})`;
      return `${rhythm}${stamp(formatter, wake.atMs)} (${when})${id}${why}`;
    });
    lines.push(`Your next wakes: ${described.join("; ")}.`);
  }

  return { name: "time", text: lines.join("\n"), priority: 100, core: true };
}

/** "under a minute", "25 min", "3 h 12 min", "3 h", "2 d 5 h", "2 d". Negative spans read as under a minute. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}

/** Age in whole days, weeks, months or years. Coarse on purpose: it changes at most once a day. */
export function ageOf(bornMs: number, nowMs: number): string {
  const days = Math.max(0, Math.floor((nowMs - bornMs) / 86_400_000));
  if (days < 1) return "less than a day";
  if (days < 14) return plural(days, "day");
  if (days < 61) return plural(Math.floor(days / 7), "week");
  if (days < 730) return plural(Math.floor(days / 30.44), "month");
  return plural(Math.floor(days / 365.25), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new RangeError(`Unknown time zone: ${zone}.`);
  }
}

/** "Sunday 2026-10-11 14:05" in the formatter's zone. */
function stamp(formatter: Intl.DateTimeFormat, ms: number): string {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return `${parts["weekday"] ?? ""} ${parts["year"] ?? ""}-${parts["month"] ?? ""}-${parts["day"] ?? ""} ${parts["hour"] ?? ""}:${parts["minute"] ?? ""}`;
}
