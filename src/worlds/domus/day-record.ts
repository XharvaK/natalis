// The game's record of a day: the helper's diary digest for one night (its frames, its acts, and counts of the rest),
// carried on a view that sleeps her. It is shown in her full view after her body block, in plain words, as facts only.
// Nothing here judges an act (no good or bad, no advice), and a part it cannot read is skipped. It never throws.

import { DAY_ORIGIN_WORDS, dropTokens, ORIGIN_WORDS, plainName, textOrUndefined } from "./words.js";

/** The longest the section may be, in characters. The lines past it are said as a count. */
export const DAY_RECORD_MAX = 4_000;
export const DAY_RECORD_HEADING = "The game's record of your day (facts only):";
/** The one line an older view's brief gains when the view carries the record. */
export const DAY_BRIEF_LINE = "- The game's record of your day came with this view.";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** A lookup that answers only for the table's own keys (never an inherited name). */
function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The hour and minute of a game calendar text ("07:05:00.000 day:0 week:2" gives "07:05"), or undefined. */
export function clockOf(value: unknown): string | undefined {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})/.exec(value.trim()) : null;
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : undefined;
}

/** Who started the act, in words; a origin the table does not name is left out. */
function originWord(by: unknown): string | undefined {
  const origin = text(by);
  if (origin === undefined) return undefined;
  return own(DAY_ORIGIN_WORDS, origin) ?? own(ORIGIN_WORDS, origin);
}

/** The needs that moved, signed, by the game's stat name: "gloop +30, zing -10". */
function needsWords(needs: unknown): string | undefined {
  const items = Object.entries(rec(needs) ?? {}).map(([stat, value]) => {
    const name = plainName(stat);
    if (!name || typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return `${name} ${value > 0 ? "+" : ""}${value}`;
  }).filter(defined);
  return items.length ? items.join(", ") : undefined;
}

/** A text the game sent, trimmed and without game tokens; anything that is not a non-empty string is undefined (a number is not a name). */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = dropTokens(value);
  return trimmed === "" ? undefined : trimmed;
}

/** The game's words for a list of names (moodlets, reactions), in plain words; empty when none is readable. */
function namesOf(value: unknown): string[] {
  return list(value).map(text).filter(defined).map(plainName).filter((name) => name !== "");
}

/** One person of an act: the one it was for, or the one who reacted. Anyone else is named without a role. */
function personWords(person: unknown): string | undefined {
  const item = rec(person);
  const who = item ? text(item.who) : undefined;
  if (who === undefined) return undefined;
  if (item?.role === "target") return `${who} (the one it was for)`;
  if (item?.role === "reactor") return `${who} (reacted)`;
  return who;
}

/**
 * One act as one plain line, without its "- ": when, how long, what, who started it, the needs that moved, what she felt,
 * the reactions, and the people. `dayPrefix` puts a day in front of the time (for a memory line). Undefined when the act
 * has no readable name.
 */
export function actText(act: unknown, dayPrefix?: string): string | undefined {
  const item = rec(act);
  const what = item ? text(item.what) : undefined;
  const name = what === undefined ? "" : plainName(what);
  if (!item || name === "") return undefined;
  const minutes = whole(item.minutes);
  const when = [dayPrefix, clockOf(item.at), minutes === undefined ? undefined : `${minutes} min`].filter(defined).join(", ");
  const origin = originWord(item.by);
  const head = `${when ? `${when}: ` : ""}${name}${origin ? ` (${origin})` : ""}`;
  const felt = namesOf(item.moodlets);
  const reactions = namesOf(item.reactions);
  const people = list(item.people).map(personWords).filter(defined);
  const parts = [
    needsWords(item.needs),
    felt.length ? `you felt: ${felt.join(", ")}` : undefined,
    reactions.length ? `reactions: ${reactions.join(", ")}` : undefined,
    people.length ? `with ${people.join(", ")}` : undefined,
  ].filter(defined);
  return `${head}${parts.length ? `; ${parts.join("; ")}` : ""}.`;
}

/** One frame: a game day, when she slept and woke, who was around, and what the body did on its own. */
function frameText(frame: Rec): string | undefined {
  const day = whole(frame.day);
  if (day === undefined) return undefined;
  const slept = list(frame.slept).map(clockOf).filter(defined);
  const woke = list(frame.woke).map(clockOf).filter(defined);
  const sleep = [
    ...(slept.length ? [`slept ${slept.join(", ")}`] : []),
    ...(woke.length ? [`woke ${woke.join(", ")}`] : []),
  ];
  const company = list(frame.company).map(text).filter(defined);
  const alone = countsOf(frame.body_on_its_own);
  const parts = [
    sleep.length ? sleep.join(", ") : undefined,
    company.length ? `with ${company.join(", ")}` : undefined,
    alone.length ? `your body on its own: ${alone.join(", ")}` : undefined,
  ].filter(defined);
  const acts = whole(frame.acts) ?? 0;
  return parts.length ? `Day ${day}: ${parts.join("; ")}.` : `Day ${day}: ${acts} act(s).`;
}

/** Name ×count for each name in a table of counts; a name or count that is not readable is left out. */
function countsOf(value: unknown): string[] {
  return Object.entries(rec(value) ?? {}).map(([name, count]) => {
    const label = plainName(name);
    const n = whole(count);
    return label === "" || n === undefined || n < 1 ? undefined : `${label} ×${n}`;
  }).filter(defined);
}

/**
 * The section for a view's day record: a heading, one line per frame and per act, the rest as counts, and a count of
 * what the cap left out. Empty when the record holds no frame and no act that can be read.
 */
export function dayRecordLines(day: unknown): string[] {
  const record = rec(day);
  if (!record) return [];
  const body = [
    ...list(record.frames).map(rec).filter(defined).map(frameText).filter(defined),
    ...list(record.acts).map((item) => actText(item)).filter(defined),
  ];
  if (body.length === 0) return [];
  const also = countsOf(record.also);
  const omitted = whole(record.omitted) ?? 0;
  const tail = [also.length ? `Also: ${also.join(", ")}.` : undefined, omitted > 0 ? `(${omitted} more not listed.)` : undefined]
    .filter(defined).join(" ");
  const all = [...body.map((line) => `- ${line}`), ...(tail ? [tail] : [])];
  const kept: string[] = [];
  let used = DAY_RECORD_HEADING.length + 1;
  for (const line of all) {
    if (used + line.length + 1 > DAY_RECORD_MAX) break;
    kept.push(line);
    used += line.length + 1;
  }
  const left = all.length - kept.length;
  if (left > 0) kept.push(`- (${left} more not shown.)`);
  return [DAY_RECORD_HEADING, ...kept];
}

/** Whether a view's day record can be shown at all. */
export function hasDayRecord(day: unknown): boolean {
  return dayRecordLines(day).length > 0;
}

/**
 * One person of a memory answer as a line: how many acts they were in together, and when the last was (the stamp is the
 * caller's: the Lar's zone). Undefined when the person has no readable name.
 */
export function personLine(person: unknown, stamp: (ms: number) => string): string | undefined {
  const item = rec(person);
  const who = item ? text(item.who) : undefined;
  if (!item || who === undefined) return undefined;
  const acts = whole(item.acts);
  const last = typeof item.last_at_ms === "number" && Number.isSafeInteger(item.last_at_ms) ? item.last_at_ms : undefined;
  const tail = [
    acts === undefined ? undefined : `${acts} act${acts === 1 ? "" : "s"} together`,
    last === undefined ? undefined : `last at ${stamp(last)}`,
  ].filter(defined).join(", ");
  return tail === "" ? `${who}.` : `${who}: ${tail}.`;
}

/** One act of a memory answer as a line: the act's day in front of its time. Undefined when the act has no readable name. */
export function memoryActLine(act: unknown): string | undefined {
  const day = whole(rec(act)?.day);
  return actText(act, day === undefined ? undefined : `Day ${day}`);
}

/** A wall time as "2026-10-12 14:20" in the Lar's zone (the host's zone when none is given, or the zone is not known). */
export function localStamp(ms: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", { ...options, ...(timeZone === undefined ? {} : { timeZone }) });
  } catch {
    format = new Intl.DateTimeFormat("en-GB", options);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]}`;
}
