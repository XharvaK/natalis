// "Your body now": the game's state for the Lar, at the top of every view, from the helper's portrait. It says what
// is true in plain words, with the game's own names and texts, and needs by their band, never by number. It never
// says what she should do, never ranks anything, and never speaks for her. A field that is missing or malformed is
// skipped; a portrait never makes the view fail.

import { BAND_WORDS, capitalised, plainName, textOrUndefined } from "./words.js";

/** The longest text of an open window the block shows, in characters. */
const WINDOW_TEXT_MAX = 160;
/** The most near conditions and situations the block names. */
const LISTED_MAX = 4;

type Record_ = Record<string, unknown>;

function record(value: unknown): Record_ | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : undefined;
}

function records(value: unknown): Record_[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record_ => item !== undefined) : [];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function metres(value: unknown): number | undefined {
  const text = textOrUndefined(value);
  if (text === undefined) return undefined;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function clockLine(portrait: Record_): string | undefined {
  const time = record(portrait.time);
  const clock = time && typeof time.weekday === "string" && Number.isInteger(time.hour) && Number.isInteger(time.minute)
    && (time.hour as number) >= 0 && (time.hour as number) <= 23 && (time.minute as number) >= 0 && (time.minute as number) <= 59
    ? `${time.weekday} ${twoDigits(time.hour as number)}:${twoDigits(time.minute as number)}`
    : undefined;
  const state = portrait.paused === true ? "paused" : portrait.paused === false ? "running" : undefined;
  const speed = textOrUndefined(portrait.clock_speed);
  if (clock === undefined) return state === undefined ? undefined : `The game is ${state}.`;
  return `Game time: ${clock}${state ? `, ${state}` : ""}${speed ? ` (clock speed ${speed})` : ""}.`;
}

function namesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => textOrUndefined(item)).filter((item): item is string => item !== undefined).map(plainName)
    : [];
}

function needsLine(needs: Record_ | undefined): string | undefined {
  if (!needs) return undefined;
  const items: string[] = [];
  for (const [id, entry] of Object.entries(needs)) {
    const band = textOrUndefined(record(entry)?.band);
    if (band === undefined) continue;
    items.push(`${plainName(id)} ${BAND_WORDS[band] ?? band}`);
  }
  return items.length ? `Needs: ${items.join(", ")}.` : undefined;
}

/** The people she can see (named) and the sounds she hears without seeing anyone. */
function companyLines(company: Record_[]): string[] {
  const seen = company.filter((item) => item.heard !== true && textOrUndefined(item.name) !== undefined);
  const heard = company.filter((item) => item.heard === true);
  const lines: string[] = [];
  const people = seen.map((item) => {
    const away = metres(item.distance_m);
    const doing = textOrUndefined(item.doing);
    const details = [away === undefined ? undefined : `${away} m away`, doing === undefined ? undefined : plainName(doing)]
      .filter((part): part is string => part !== undefined);
    return `${textOrUndefined(item.name)}${details.length ? ` (${details.join(", ")})` : ""}`;
  });
  lines.push(people.length ? `With you: ${people.join("; ")}.` : "With you: no one you can see.");
  if (heard.length) {
    const distances = heard.map((item) => metres(item.distance_m)).filter((item): item is number => item !== undefined);
    const nearest = distances.length ? ` (nearest ${Math.min(...distances)} m away)` : "";
    lines.push(`Heard but not seen: ${heard.length}${nearest}.`);
  }
  return lines;
}

/** Who is talking to her, by the name of the person she can see; someone she cannot see is "someone". */
function talkingLines(addressedBy: Record_[], company: Record_[]): string[] {
  const names = new Map<string, string>();
  for (const item of company) {
    const name = textOrUndefined(item.name);
    if (item.heard !== true && name !== undefined) names.set(String(item.id ?? ""), name);
  }
  return addressedBy.slice(0, LISTED_MAX).map((item) => {
    const by = textOrUndefined(item.by);
    const who = (by !== undefined ? names.get(by) : undefined) ?? "someone";
    const act = textOrUndefined(item.interaction);
    return `Talking to you: ${who}${act ? ` (${plainName(act)})` : ""}.`;
  });
}

function windowLines(asked: Record_[]): string[] {
  return asked.map((item) => {
    const title = textOrUndefined(item.title) ?? "a window";
    const text = textOrUndefined(item.text);
    const tail = text === undefined ? "" : ` ${clip(text, WINDOW_TEXT_MAX)}`;
    if (item.whose === "the User's") return `Open on your summoner's screen: ${title}.`;
    if (item.whose === "hers") {
      const held = item.held === true ? "held for you" : "not held for you";
      const answers = item.answers_itself === true ? " It answers itself." : "";
      return `Open for you: ${title} (${held}).${tail}${answers}`;
    }
    return `Open: ${title}.${tail}`;
  });
}

function flagLines(portrait: Record_): string[] {
  const flags: Array<[boolean, string]> = [
    [portrait.building === true, "Build mode is on."],
    [portrait.fire_on_lot === true, "A fire is burning on the lot."],
    [portrait.user_plays_another === true, "Your summoner is playing another Sim of the household, so your acts are refused for now."],
    [portrait.company_complete === false, "The company list missed someone in this sample."],
    [portrait.more_nearby === true, "More Sims are nearby than the list shows."],
  ];
  return flags.filter(([on]) => on).map(([, text]) => text);
}

/** Whether the game is attached when the view is shown; when not, the last time it was attached, if ever. */
export type AttachmentNow = { attached: true } | { attached: false; lastAttachedMs: number | undefined; nowMs: number };

export function attachmentLine(attachment: AttachmentNow): string {
  if (attachment.attached) return "The game is attached.";
  if (attachment.lastAttachedMs === undefined) return "The game is not attached.";
  const minutes = Math.floor(Math.max(0, attachment.nowMs - attachment.lastAttachedMs) / 60_000);
  return minutes < 1
    ? "The game is not attached (last seen under a minute ago)."
    : `The game is not attached (last seen ${minutes} minutes ago).`;
}

/**
 * The block's lines, in order: whether the game is attached (when known), then what the portrait holds. Empty when
 * there is neither. Never throws.
 */
export function bodyLines(portrait: unknown, attachment?: AttachmentNow): string[] {
  const p = record(portrait);
  const lines: string[] = attachment ? [attachmentLine(attachment)] : [];
  if (!p) return lines;
  const clock = clockLine(p);
  if (clock) lines.push(clock);
  const room = textOrUndefined(record(p.zone)?.room_label);
  if (room) lines.push(`Room: ${room}.`);
  const posture = textOrUndefined(p.posture);
  if (posture) lines.push(`Posture: ${plainName(posture)}.`);
  if (Array.isArray(p.running)) {
    const running = namesOf(p.running);
    lines.push(running.length ? `Doing: ${running.join(", ")}.` : "Doing: nothing.");
  }
  const queued = namesOf(p.queued);
  if (queued.length) lines.push(`Queued: ${queued.join(", ")}.`);
  const mood = textOrUndefined(p.mood);
  if (mood) lines.push(`Mood: ${plainName(mood)}.`);
  const moodlets = records(p.moodlets).map((item) => textOrUndefined(item.text) ?? (textOrUndefined(item.name) ? plainName(textOrUndefined(item.name)!) : undefined))
    .filter((item): item is string => item !== undefined);
  if (moodlets.length) lines.push(`Moodlets: ${moodlets.join("; ")}.`);
  const needs = needsLine(record(p.needs));
  if (needs) lines.push(needs);
  if (Array.isArray(p.company)) lines.push(...companyLines(records(p.company)));
  lines.push(...talkingLines(records(p.addressed_by), records(p.company)));
  lines.push(...windowLines(records(p.asked)));
  const recent = records(p.windows).map((item) => {
    const event = textOrUndefined(item.event);
    const code = textOrUndefined(item.code);
    const ago = typeof item.ago_min === "number" && Number.isFinite(item.ago_min) ? Math.max(0, Math.round(item.ago_min)) : undefined;
    if (event === undefined) return undefined;
    return `${plainName(event)}${code ? ` (${plainName(code)})` : ""}${ago === undefined ? "" : `, ${ago} min ago`}`;
  }).filter((item): item is string => item !== undefined);
  if (recent.length) lines.push(`Recent windows: ${recent.join("; ")}.`);
  const near = records(p.near_conditions).slice(0, LISTED_MAX).map((item) => {
    const object = textOrUndefined(item.object);
    const states = namesOf(item.states);
    return object === undefined ? undefined : `${plainName(object)}${states.length ? ` (${states.join(", ")})` : ""}`;
  }).filter((item): item is string => item !== undefined);
  if (near.length) lines.push(`Near you: ${near.join("; ")}.`);
  lines.push(...flagLines(p));
  const place = record(p.place);
  if (place) {
    if (place.her_home === true) lines.push("This is her home.");
    else if (place.her_home === false) lines.push("This is not her home.");
    const household = Array.isArray(place.household_here)
      ? place.household_here.map((item) => textOrUndefined(item)).filter((item): item is string => item !== undefined)
      : [];
    if (household.length) lines.push(`Household here: ${household.join(", ")}.`);
    const heard = typeof place.household_heard === "number" && place.household_heard > 0 ? place.household_heard : 0;
    if (heard) lines.push(`${heard} more of the household is out of sight.`);
  }
  const situations = records(p.situations)
    .map((item) => textOrUndefined(item.role) ?? textOrUndefined(item.name))
    .filter((item): item is string => item !== undefined)
    .slice(0, LISTED_MAX);
  if (situations.length) lines.push(`Situations: ${situations.map((item) => capitalised(item)).join(", ")}.`);
  return lines;
}
