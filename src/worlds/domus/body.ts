// "Your body now": the game's state for the Lar, at the top of every view, from the helper's portrait. It says what
// is true in plain words, with the game's own names and texts. Needs reach her as feelings, graded the way a person
// feels them: never a number, never a level word. It never says what she should do, never ranks anything, and never
// speaks for her. A field that is missing or malformed is skipped; a portrait never makes the view fail.

import { capitalised, plainName, textOrUndefined, withStop, withoutStop } from "./words.js";

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

/** The game's clock and whether it runs, in words; undefined when the portrait has neither. */
export function clockLine(portrait: Record_): string | undefined {
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

/**
 * Running or queued acts in words: the helper's sentence for an act of that state where it sent one (matched by the
 * name the view already shows), else the plain name.
 */
function actWords(value: unknown, doingSaid: Record_[], state: string): string[] {
  const sentences = new Map<string, string>();
  for (const item of doingSaid) {
    const name = textOrUndefined(item.name);
    const text = textOrUndefined(item.sentence);
    if (item.state === state && name !== undefined && text !== undefined) sentences.set(plainName(name), withoutStop(text));
  }
  return namesOf(value).map((name) => sentences.get(name) ?? name);
}

/**
 * How hard a need bites, as a grade: 1 is the mildest (below 60, from 40 to 59) and 4 the worst (0 to 5). A need at 60
 * or more is not felt, so it has no grade.
 */
export type NeedGrade = 1 | 2 | 3 | 4;

/** The feeling words of the game's needs, one per grade, mildest first. */
const NEED_FEELINGS: Readonly<Record<string, readonly [string, string, string, string]>> = {
  bladder: [
    "You'll need the toilet soon.",
    "You need the toilet.",
    "You badly need the toilet; you can't hold it much longer.",
    "You're about to wet yourself.",
  ],
  hunger: ["You're getting peckish.", "You're hungry.", "You're starving.", "You're so hungry you could faint."],
  energy: ["You're getting tired.", "You're tired.", "You're exhausted.", "You're about to fall asleep where you stand."],
  fun: ["You're a little bored.", "You're bored.", "You're very bored.", "You're bored out of your mind."],
  social: ["You'd like some company.", "You're lonely.", "You're very lonely.", "You're desperately lonely."],
  hygiene: ["You could use a wash.", "You feel grubby.", "You feel filthy.", "You smell awful, and people will notice."],
};

/** The words of a need the table does not name, by grade: "<need> is getting low." and so on. */
const OTHER_NEED_FEELINGS: readonly [string, string, string, string] = [
  "is getting low.",
  "is low.",
  "is very low.",
  "is about to give out.",
];

/** How many needs the block feels at most; the worst come first. */
const NEEDS_FELT_MAX = 2;

/** The grade of a need by its value (0 to 100); undefined at 60 or more. */
export function needGradeOfValue(value: number): NeedGrade | undefined {
  if (value >= 60) return undefined;
  if (value >= 40) return 1;
  if (value >= 20) return 2;
  if (value >= 6) return 3;
  return 4;
}

/** The grade of a need by its band, when its value is not there: distress is urgent (3), low is a need (2), ok says nothing. */
export function needGradeOfBand(band: string | undefined): NeedGrade | undefined {
  if (band === "distress") return 3;
  if (band === "low") return 2;
  return undefined;
}

/** The feeling of one need at a grade, in plain words: the need's own sentence, or "<need> is ..." for one the table does not name. */
export function needFeeling(id: string, grade: NeedGrade): string {
  const name = plainName(id);
  const words = NEED_FEELINGS[name];
  if (words) return words[grade - 1] ?? words[0];
  return `${capitalised(name)} ${OTHER_NEED_FEELINGS[grade - 1] ?? OTHER_NEED_FEELINGS[0]}`;
}

/**
 * The needs as feelings: the worst needs below 60 first, at most two, each in its words. With none below 60, "Nothing is
 * bothering you." A need's value grades it; its band grades it when the value is not there.
 */
function needsLine(needs: Record_ | undefined): string | undefined {
  if (!needs) return undefined;
  const felt: Array<{ id: string; grade: NeedGrade; value: number | undefined }> = [];
  let known = 0;
  for (const [id, entry] of Object.entries(needs)) {
    const item = record(entry);
    if (!item) continue;
    const value = typeof item.value === "number" && Number.isFinite(item.value) ? item.value : undefined;
    const band = textOrUndefined(item.band);
    if (value === undefined && band === undefined) continue;
    known++;
    const grade = value !== undefined ? needGradeOfValue(value) : needGradeOfBand(band);
    if (grade !== undefined) felt.push({ id, grade, value });
  }
  // A portrait with no needs in it says nothing about them, rather than that nothing bothers her.
  if (known === 0) return undefined;
  if (felt.length === 0) return "Nothing is bothering you.";
  felt.sort((a, b) => b.grade - a.grade || (a.value ?? 0) - (b.value ?? 0));
  return felt.slice(0, NEEDS_FELT_MAX).map((item) => needFeeling(item.id, item.grade)).join(" ");
}

/**
 * What the game holds between her and this Sim, in plain words: whether she knows them, the labels the game gives the
 * pair, and the friendship track (a word, or the track's name and value). Nothing is said for what the game did not send.
 */
function relationWords(relationship: unknown): string[] {
  const r = record(relationship);
  if (!r) return [];
  const known = r.known ?? r.met;
  const labels = Array.isArray(r.labels) ? r.labels.map(wordOf).filter((item): item is string => item !== undefined) : [];
  const track = wordOf(r.track);
  const tracks = record(r.tracks);
  const trackValues = tracks === undefined ? [] : Object.entries(tracks)
    .map(([name, value]) => (wordOf(name) === undefined || typeof value !== "number" ? undefined : `${plainName(name)} ${value}`))
    .filter((item): item is string => item !== undefined);
  return [
    ...(known === true ? ["known to you"] : known === false ? ["not met yet"] : []),
    ...labels,
    ...(track === undefined ? [] : [track]),
    ...trackValues,
  ];
}

/** The people she can see (named) and the sounds she hears without seeing anyone. */
function companyLines(company: Record_[]): string[] {
  const seen = company.filter((item) => item.heard !== true && textOrUndefined(item.name) !== undefined);
  const heard = company.filter((item) => item.heard === true);
  const lines: string[] = [];
  const people = seen.map((item) => {
    const name = textOrUndefined(item.name) ?? "someone";
    const away = metres(item.distance_m);
    const said = textOrUndefined(item.said);
    // W12 (E2): her role with them (a neighbour, a courier) and what the game holds between them, after the rest.
    const role = wordOf(item.role);
    // W13: a visitor waiting at her door (the company entry's waiting flag, from the visitor's situation job).
    const waiting = item.waiting === true ? "waiting at your door" : undefined;
    const extra = [role, waiting, ...relationWords(item.relationship)].filter((part): part is string => part !== undefined);
    if (said !== undefined) {
      // SS4-v3: what this Sim is saying or doing, in the helper's sentence, in brackets after the name (no dashes: she copies them).
      return `${name} (${away === undefined ? "" : `${away} m away: `}${withoutStop(said)}${extra.length ? `; ${extra.join(", ")}` : ""})`;
    }
    const doing = textOrUndefined(item.doing);
    const details = [away === undefined ? undefined : `${away} m away`, doing === undefined ? undefined : plainName(doing), ...extra]
      .filter((part): part is string => part !== undefined);
    return `${name}${details.length ? ` (${details.join(", ")})` : ""}`;
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
    const sentence = textOrUndefined(item.sentence);
    // SS4-v3: the helper's sentence, already said to her ("you"), when it sent one.
    if (sentence !== undefined) return `Talking to you: ${withStop(sentence)}`;
    const by = textOrUndefined(item.by);
    const who = (by !== undefined ? names.get(by) : undefined) ?? "someone";
    const act = textOrUndefined(item.interaction);
    return `Talking to you: ${who}${act ? ` (${plainName(act)})` : ""}.`;
  });
}

/** The time a held window has left before the User is handed it, in words: seconds under a minute, else whole minutes (A9). */
function holdLeftWords(value: unknown): string {
  const seconds = wholeOf(value);
  if (seconds === undefined || seconds < 0) return "";
  return seconds < 60 ? `, ${seconds} s left` : `, ${Math.ceil(seconds / 60)} min left`;
}

function windowLines(asked: Record_[]): string[] {
  return asked.map((item) => {
    const title = textOrUndefined(item.title) ?? "a window";
    const text = textOrUndefined(item.text);
    const tail = text === undefined ? "" : ` ${clip(text, WINDOW_TEXT_MAX)}`;
    if (item.whose === "the User's") return `Open on your summoner's screen: ${title}.`;
    if (item.whose === "hers") {
      const held = item.held === true ? `held for you${holdLeftWords(item.hold_left_s)}` : "not held for you";
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


/** A text the game gave, trimmed; anything else (a number, null, an empty string) is undefined. */
function wordOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A whole number from the game; anything else is undefined. */
function wholeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** A whole number with a comma between each group of three digits: 1234 is "1,234". */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function traitsLine(traits: unknown): string | undefined {
  const names = Array.isArray(traits) ? traits.map(wordOf).filter((item): item is string => item !== undefined) : [];
  return names.length ? `You are ${names.join(", ")}.` : undefined;
}

function skillsLine(skills: unknown): string | undefined {
  const items = records(skills).map((item) => {
    const skill = wordOf(item.skill);
    const level = wholeOf(item.level);
    return skill !== undefined && level !== undefined ? `${skill} ${level}` : undefined;
  }).filter((item): item is string => item !== undefined);
  return items.length ? `Skills: ${items.join(", ")}.` : undefined;
}

function moneyLine(funds: unknown): string | undefined {
  const amount = wholeOf(funds);
  return amount === undefined ? undefined : `Money: ${amount < 0 ? "-" : ""}§${grouped(Math.abs(amount))}.`;
}

/** "at work until 17:00" from the game minute her shift ends (until_min); "at work now" when the game did not say when. */
function atWorkWords(untilMin: unknown): string {
  const minute = wholeOf(untilMin);
  if (minute === undefined || minute < 0 || minute > 1439) return "; at work now";
  return `; at work until ${twoDigits(Math.floor(minute / 60))}:${twoDigits(minute % 60)}`;
}

/** Her jobs, one line each; an empty list is "No job."; an absent list says nothing. */
function jobLines(jobs: unknown): string[] {
  if (!Array.isArray(jobs)) return [];
  if (jobs.length === 0) return ["No job."];
  return records(jobs).map((item) => {
    const title = wordOf(item.title);
    const job = wordOf(item.job);
    const name = title !== undefined && job !== undefined ? `${title} (${job})` : title ?? job;
    if (name === undefined) return undefined;
    const level = wholeOf(item.level);
    return `Job: ${name}${level === undefined ? "" : `, level ${level}`}${item.at_work === true ? atWorkWords(item.until_min) : ""}.`;
  }).filter((item): item is string => item !== undefined);
}

/** One want as the panel lists it: its progress and deadline in brackets, its way in square brackets, and "(locked)". */
function wantText(item: Record_): string | undefined {
  const want = wordOf(item.want);
  if (want === undefined) return undefined;
  const progress = wordOf(item.progress);
  const until = wordOf(item.until);
  const detail = [progress, until === undefined ? undefined : `until ${until}`].filter((part): part is string => part !== undefined);
  const how = wordOf(item.how);
  return `${want}${detail.length ? ` (${detail.join(", ")})` : ""}${how ? ` [${how}]` : ""}${item.locked === true ? " (locked)" : ""}`;
}

/** Her wants and her fears, each list in the order the game gave it. */
function wantsLines(wants: unknown): string[] {
  const all = records(wants);
  const wanted = all.filter((item) => item.fear !== true).map(wantText).filter((item): item is string => item !== undefined);
  const feared = all.filter((item) => item.fear === true).map((item) => wordOf(item.want)).filter((item): item is string => item !== undefined);
  return [
    ...(wanted.length ? [`Wants: ${wanted.join("; ")}.`] : []),
    ...(feared.length ? [`Fears: ${feared.join("; ")}.`] : []),
  ];
}

/** The life facts that are true, and her age stage in plain words. */
function lifeLines(life: unknown): string[] {
  const facts = record(life);
  if (!facts) return [];
  const lines: string[] = [];
  if (facts.pregnant === true) lines.push("You are pregnant.");
  if (facts.sick === true) lines.push("You are sick.");
  if (facts.ghost === true) lines.push("You are a ghost.");
  const age = wordOf(facts.age);
  if (age !== undefined) lines.push(`Age: ${age.replace(/_/g, " ").toLowerCase()}.`);
  return lines;
}

/** Her aspiration, its objectives in the order given; a line needs its name. */
function aspirationLine(aspiration: unknown): string | undefined {
  const a = record(aspiration);
  const name = a ? wordOf(a.name) : undefined;
  if (!a || name === undefined) return undefined;
  const objectives = records(a.objectives).map((item) => {
    const text = wordOf(item.text);
    return text === undefined ? undefined : `${text}${item.done === true ? " (done)" : ""}`;
  }).filter((item): item is string => item !== undefined);
  return `Aspiration: ${name}${objectives.length ? `; now: ${objectives.join(", ")}` : ""}.`;
}

/** What she owes, whether the bills came in the mail, and whether they are late; none owed is said as such. */
function billsLine(bills: unknown): string | undefined {
  const b = record(bills);
  const owed = b ? wholeOf(b.owed) : undefined;
  if (!b || owed === undefined || owed < 0) return undefined;
  const late = b.late === true;
  if (owed === 0 && !late) return "No bills owed.";
  const parts = [
    `§${grouped(owed)} owed`,
    b.delivered === true ? "they came in the mail" : undefined,
    late ? "late" : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Bills: ${parts.join("; ")}.`;
}

/** What she carries; a count is said only when it is more than one. */
function carryLine(inventory: unknown): string | undefined {
  const items = records(inventory).map((item) => {
    const name = wordOf(item.item);
    const count = wholeOf(item.count);
    if (name === undefined || count === undefined || count < 1) return undefined;
    return count > 1 ? `${count} × ${name}` : name;
  }).filter((item): item is string => item !== undefined);
  return items.length ? `You carry: ${items.join(", ")}.` : undefined;
}

/** The season and the weather of the lot: the season first, then the weather words, all in plain words. */
function weatherLine(portrait: Record_): string | undefined {
  const season = wordOf(portrait.season);
  const weather = Array.isArray(portrait.weather)
    ? portrait.weather.map((item) => wordOf(item)?.replace(/_/g, " ").toLowerCase()).filter((item): item is string => item !== undefined)
    : [];
  const parts = [season?.replace(/_/g, " ").toLowerCase(), ...weather].filter((item): item is string => item !== undefined);
  return parts.length ? `${capitalised(parts.join(", "))}.` : undefined;
}

/** The "You" section from the helper's portrait of her Sim: each part is skipped when absent or malformed. */
function youLines(self: unknown): string[] {
  const s = record(self);
  if (!s) return [];
  return [
    traitsLine(s.traits),
    skillsLine(s.skills),
    moneyLine(s.funds),
    ...jobLines(s.jobs),
    ...wantsLines(s.wants),
    ...lifeLines(s.life),
    aspirationLine(s.aspiration),
    billsLine(s.bills),
    carryLine(s.inventory),
  ].filter((item): item is string => item !== undefined);
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
 * The block's lines, in order: her attention (when given), whether the game is attached (when known), then what the
 * portrait holds. Empty when there is none of these. Never throws.
 */
export function bodyLines(portrait: unknown, attachment?: AttachmentNow, attention?: string): string[] {
  const p = record(portrait);
  const lines: string[] = [...(attention === undefined ? [] : [attention]), ...(attachment ? [attachmentLine(attachment)] : [])];
  if (!p) return lines;
  const clock = clockLine(p);
  if (clock) lines.push(clock);
  const weather = weatherLine(p);
  if (weather) lines.push(weather);
  const room = textOrUndefined(record(p.zone)?.room_label);
  if (room) lines.push(`Room: ${room}.`);
  const posture = textOrUndefined(p.posture);
  if (posture) lines.push(`Posture: ${plainName(posture)}.`);
  const doingSaid = records(p.doing_said);
  if (Array.isArray(p.running)) {
    const running = actWords(p.running, doingSaid, "running");
    lines.push(running.length ? `Doing: ${running.join(", ")}.` : "Doing: nothing.");
  }
  const queued = actWords(p.queued, doingSaid, "queued");
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
    if (place.her_home === true) lines.push("This is your home.");
    else if (place.her_home === false) lines.push("This is not your home.");
    const household = Array.isArray(place.household_here)
      ? place.household_here.map((item) => textOrUndefined(item)).filter((item): item is string => item !== undefined)
      : [];
    if (household.length) lines.push(`Household here: ${household.join(", ")}.`);
    const heard = typeof place.household_heard === "number" && place.household_heard > 0 ? place.household_heard : 0;
    if (heard) lines.push(`${heard} more of the household is out of sight.`);
  }
  const situations = situationLine(p.situations);
  if (situations) lines.push(situations);
  lines.push(...youLines(p.self));
  return lines;
}

/**
 * The situations she is in, in plain words: each once, in the order the view gives them, with its count when it repeats
 * ("pivotal moment (×3)"). The tuning's Role_ prefix is not a word she needs. At most LISTED_MAX different ones.
 */
function situationLine(value: unknown): string | undefined {
  const counts = new Map<string, number>();
  for (const item of records(value)) {
    const text = textOrUndefined(item.role) ?? textOrUndefined(item.name);
    if (text === undefined) continue;
    const name = plainName(text).replace(/^role /, "");
    if (name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const items = [...counts].slice(0, LISTED_MAX).map(([name, count]) => (count > 1 ? `${name} (×${count})` : name));
  return items.length ? `Situations: ${items.join(", ")}.` : undefined;
}
