// The option table of a game view: what the game offers the Lar to do, each act with a short ref (a1, a2 ...)
// the Lar names. The world reads the table from the stored view and renders it as plain words. It never picks
// an option, ranks anything or says what the Lar should do.

import type { Found, OptionObject, AnswerRules } from "./answers.js";
import { answerRulesOf } from "./answers.js";
import type { OptionsCut, Percept } from "./wire.js";
import { type AttachmentNow, bodyLines, clockLine, needFeeling, needGradeOfBand, needGradeOfValue } from "./body.js";
import { DAY_BRIEF_LINE, dayRecordLines } from "./day-record.js";
import { capitalised, dropTokens, ORIGIN_WORDS, plainName, textOrUndefined } from "./words.js";

/** The longest the rendered view may be, in characters. The rest is said as a count. */
export const VIEW_TEXT_MAX = 20_000;
/** The longest an older view's brief may be, in characters. The rest is said as a count. */
export const BRIEF_MAX = 1_000;
const FACT_MAX = 80;
/** The helper's id and where for her queue (its acts are the ones she has queued). */
const QUEUE_OBJECT_ID = "queue:her";
const QUEUE_WHERE = "your queue";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The options of a stored view, exactly as the helper sent them; anything malformed offers nothing. */
export function optionsOf(options: unknown): OptionObject[] {
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is OptionObject => !!item && typeof item === "object"
    && typeof (item as Record<string, unknown>).object === "string"
    && typeof (item as Record<string, unknown>).object_id === "string"
    && Array.isArray((item as Record<string, unknown>).acts));
}

/** Every ref in a table, in the order the game listed them. */
export function refsOf(options: readonly OptionObject[]): string[] {
  const refs: string[] = [];
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && typeof act.ref === "string" && typeof act.guid64 === "string" && typeof act.text === "string") {
        refs.push(act.ref);
      }
    }
  }
  return refs;
}

/** The act with this ref and its object, or null. A ref is only ever matched exactly. */
export function findOption(options: readonly OptionObject[], ref: string): Found | null {
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && act.ref === ref && typeof act.guid64 === "string" && typeof act.text === "string") {
        return { object, act };
      }
    }
  }
  return null;
}

/** The label an act is known by in the notebook and in the events it produces: its words and its object. */
export function labelOf(found: Found): string {
  return `${found.act.text} (${found.object.object})`.slice(0, 200);
}

function describeRules(rules: AnswerRules): string {
  const parts: string[] = [];
  if (rules.select) {
    parts.push(`pick ${rules.select.min} to ${rules.select.max === 0 ? "any number of" : rules.select.max} row(s)`);
  }
  if (rules.counts) {
    parts.push(`up to ${rules.counts.max_in_row} of one row, at most ${rules.counts.max_rows} row(s)`);
  }
  for (const field of rules.text ?? []) {
    const bounds = field.max_length === null ? `at least ${field.min_length}` : `${field.min_length} to ${field.max_length}`;
    const numeric = field.numeric ? `, a whole number from ${field.min_value ?? "?"} to ${field.max_value ?? "?"}` : "";
    parts.push(`type "${field.name}" (${field.label}), ${bounds} characters${numeric}`);
  }
  return parts.length ? parts.join("; ") : "none";
}

function factsText(facts: Record<string, unknown>): string {
  return Object.entries(facts)
    .map(([key, value]) => {
      const shown = typeof value === "string" ? dropTokens(value)
        : typeof value === "number" || typeof value === "boolean" || value === null ? String(value)
          : JSON.stringify(value) ?? "";
      return `${key} ${clip(shown, FACT_MAX)}`;
    })
    .join(", ");
}

/** A text the game sent, trimmed; anything that is not text, or is empty, is undefined. */
function said(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = dropTokens(value);
  return text === "" ? undefined : text;
}

/** A text the game sent as one sentence: a full stop is added only when it has none of its own. */
function sentence(value: unknown): string | undefined {
  const text = said(value);
  return text === undefined ? undefined : /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * One percept as one plain sentence, from its fixed form. Returns undefined for a kind it does not know, or a
 * percept missing what its sentence needs; the caller then keeps the old "kind: facts" line, so nothing is lost.
 */
export function perceptSentence(percept: Percept): string | undefined {
  const facts = percept.facts;
  switch (percept.kind) {
    case "phone": {
      // W13: a notice on her phone (about a phone act of hers, when the game names it), or a call held for her, by the
      // name of the caller (the game's name, never a guess).
      const what = textOrUndefined(facts.what);
      if (what === "notice") {
        const act = textOrUndefined(facts.act);
        return `Your phone shows a new notification.${act ? ` It is about: ${act}.` : ""}`;
      }
      if (what === "call") return `${textOrUndefined(facts.from) ?? "Someone"} is calling you.`;
      return undefined;
    }
    case "need": {
      // N4: a need reaches her as its feeling, graded by its value when the game gives one, else by its band. A need that
      // is not felt (ok) has no words, so the view does not show it.
      const subject = textOrUndefined(facts.subject);
      if (!subject) return undefined;
      const value = typeof facts.value === "number" && Number.isFinite(facts.value) ? facts.value : undefined;
      const grade = value !== undefined ? needGradeOfValue(value) : needGradeOfBand(textOrUndefined(facts.band));
      return grade === undefined ? undefined : needFeeling(subject, grade);
    }
    case "moodlet": {
      const to = textOrUndefined(facts.to);
      if (!to) return undefined;
      const from = textOrUndefined(facts.from);
      const mood = (text: string) => plainName(text.replace(/^Mood_/, ""));
      return `Mood: ${mood(to)} now${from ? ` (was ${mood(from)})` : ""}.`;
    }
    case "interaction": {
      const bucket = textOrUndefined(facts.bucket);
      if (!bucket) return undefined;
      const affordance = textOrUndefined(facts.affordance_text) ?? textOrUndefined(facts.tuning_name);
      const name = affordance ? plainName(affordance) : plainName(bucket);
      const origin = textOrUndefined(facts.origin);
      const from = origin ? ORIGIN_WORDS[origin] : undefined;
      const coded = [
        textOrUndefined(facts.code) ? `Result code ${textOrUndefined(facts.code)}` : undefined,
        textOrUndefined(facts.detail) ? `detail ${textOrUndefined(facts.detail)}` : undefined,
      ].filter((part): part is string => part !== undefined);
      const tail = coded.length ? ` ${coded.join(", ")}.` : "";
      return `${capitalised(plainName(bucket))}: ${name}${from ? ` (${from})` : ""}.${tail}`;
    }
    case "presence": {
      const bucket = textOrUndefined(facts.bucket);
      if (!bucket) return undefined;
      const verb = bucket === "arrived" ? "arrived" : bucket === "left" ? "left" : bucket === "on_lot" ? "is on the lot" : undefined;
      if (!verb) return undefined;
      const name = textOrUndefined(facts.name) ?? "Someone";
      const metres = Number(textOrUndefined(facts.distance_m));
      const parts = [
        Number.isFinite(metres) && textOrUndefined(facts.distance_m) !== undefined ? `${Math.round(metres)} m away` : undefined,
        textOrUndefined(facts.doing) ? plainName(textOrUndefined(facts.doing)!) : undefined,
      ].filter((part): part is string => part !== undefined);
      const role = textOrUndefined(facts.role);
      return `${name} ${verb}${parts.length ? `, ${parts.join(", ")}` : ""}${role ? ` (${role})` : ""}.`;
    }
    case "posture": {
      const posture = textOrUndefined(facts.bucket);
      return posture ? `Posture: ${plainName(posture)}.` : undefined;
    }
    case "social": {
      // SS4-v3: the helper's sentence for what was said to her; without one, who is talking to her and the act.
      // A number is never shown: an id the helper did not name is "Someone".
      const text = sentence(facts.sentence);
      if (text !== undefined) return text;
      const by = textOrUndefined(facts.by);
      const who = by === undefined || /^\d+$/.test(by) ? "Someone" : capitalised(by);
      const interaction = textOrUndefined(facts.interaction);
      return interaction ? `${who} is talking to you (${plainName(interaction)}).` : `${who} is talking to you.`;
    }
    case "env":
      return facts.from_room !== undefined ? "You moved rooms." : undefined;
    case "sleep_onset":
      return "You fell asleep.";
    case "lineage": {
      const lineage = textOrUndefined(facts.bucket);
      const reason = textOrUndefined(facts.reason);
      return `Your life line changed${lineage ? ` (${plainName(lineage)})` : ""}${reason ? `: ${reason}` : ""}.`;
    }
    case "notice": {
      const text = sentence(facts.text);
      const title = facts.title === undefined ? "" : said(facts.title);
      if (text === undefined || title === undefined) return undefined;
      return `The game says: ${title ? `${title}: ` : ""}${text}`;
    }
    case "self":
      return sentence(facts.text);
    case "look":
      return "This is the look you asked for.";
    case "gap":
      return "Part of the game's feed was missed.";
    default:
      return undefined;
  }
}

/**
 * One percept's line in a view: its plain sentence. A percept with no words (a kind it does not know, or one missing
 * what its sentence needs) has no line: its raw "kind: facts" text is not shown to her.
 */
export function perceptLine(percept: Percept): string | undefined {
  const sentence = perceptSentence(percept);
  return sentence === undefined ? undefined : `- ${sentence}`;
}

/**
 * The brief of an older view, kept in its row: the percept lines only, in the words the view shows them, and one line
 * when the view carried the game's record of the day. No body and no choices. "An earlier view." when there is neither.
 */
export function viewBrief(percepts: readonly Percept[], dayRecord = false): string {
  if (percepts.length === 0 && !dayRecord) return "An earlier view.";
  const all = percepts.map(perceptLine).filter((line): line is string => line !== undefined);
  const lines: string[] = [];
  let used = 0;
  for (const line of all) {
    if (used + line.length > BRIEF_MAX) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < all.length) lines.push(`- (${all.length - lines.length} more not shown)`);
  if (dayRecord) lines.push(DAY_BRIEF_LINE);
  return lines.length === 0 ? "An earlier view." : lines.join("\n");
}

/**
 * The plain text of a game view for the Lar: what the game shows, then the choices it offers, each with its ref.
 * Shows the ref and the game's words only; no id, no matcher hint, no advice.
 */
export function renderView(input: {
  world: string; percepts: readonly Percept[]; options: readonly OptionObject[]; portrait?: unknown; attachment?: AttachmentNow;
  /** Her attention, the first line of the body block (see attentionLine). */
  attention?: string;
  /** The count line of her lists (see listCountLine), shown after her money. */
  counts?: string;
  /** The game's record of the day, when the view carries one. Its section comes after the body block (see day-record.ts). */
  day?: unknown;
  /** The choices of the last view rendered on this thread (see choicesSignature), or undefined when there was none. */
  lastChoices?: string;
  optionsCut?: OptionsCut;
}): string {
  const body = withCountLine(bodyLines(input.portrait, input.attachment, input.attention), input.counts);
  const record = dayRecordLines(input.day);
  const head = [
    ...(body.length ? ["Your body now:", ...body, ""] : []),
    ...(record.length ? [...record, ""] : []),
    `The game (${input.world}) shows:`,
  ];
  const lines: string[] = [...head];
  const all = input.percepts.map(perceptLine).filter((line): line is string => line !== undefined);
  let shown = 0;
  let used = head.reduce((sum, line) => sum + line.length + 1, 0);
  for (const line of all) {
    if (used + line.length > VIEW_TEXT_MAX) break;
    lines.push(line);
    used += line.length;
    shown++;
  }
  if (shown < all.length) lines.push(`- (${all.length - shown} more not shown)`);
  if (input.options.length === 0) {
    lines.push("", "The game offers no choices in this view.");
    return lines.join("\n");
  }
  const cut = optionsCutLine(input.optionsCut);
  if (input.lastChoices !== undefined && input.lastChoices === choicesSignature(input.options)) {
    lines.push("", "Choices: the same as in the last view.");
    if (cut) lines.push(cut);
    return lines.join("\n");
  }
  lines.push("", "Choices you can name with game_act, by ref:");
  for (const object of input.options.filter(isNear)) lines.push(...objectLines(object));
  const elsewhere = input.options.filter((object) => !isNear(object));
  // Her queue is not in a room: it is its own group, right after the near objects, and never under a room heading.
  const queue = elsewhere.filter(isQueue);
  if (queue.length) {
    lines.push("What you are doing now:");
    for (const object of queue) lines.push(...objectLines(object));
  }
  const rest = elsewhere.filter((object) => !isQueue(object));
  if (rest.length) {
    lines.push("Elsewhere on the lot:");
    const rooms = new Map<string, OptionObject[]>();
    for (const object of rest) {
      const room = typeof object.room === "string" && object.room !== "" ? object.room : "Other rooms";
      rooms.set(room, [...(rooms.get(room) ?? []), object]);
    }
    for (const [room, objects] of rooms) {
      lines.push(`${room}:`);
      for (const object of objects) lines.push(...objectLines(object));
    }
  }
  if (cut) lines.push(cut);
  return lines.join("\n");
}

/** The count line goes right after her money line; with no money line, it closes the body block. */
function withCountLine(lines: string[], counts: string | undefined): string[] {
  if (counts === undefined) return lines;
  const money = lines.findIndex((line) => line.startsWith("Money: "));
  if (money === -1) return [...lines, counts];
  return [...lines.slice(0, money + 1), counts, ...lines.slice(money + 1)];
}

/** Near her: the helper's near flag, or a where that starts "here" (what older helpers send). */
function isNear(object: OptionObject): boolean {
  return object.near === true || (typeof object.where === "string" && object.where.startsWith("here"));
}

/** Her queue: the helper's queue object, which has no room (its where is "your queue"). */
function isQueue(object: OptionObject): boolean {
  const hasRoom = typeof object.room === "string" && object.room !== "";
  return !hasRoom && (object.object_id === QUEUE_OBJECT_ID || object.where === QUEUE_WHERE);
}

/** The helper's words for a refused act the game gave no reason for (see the helper's refusal lines). */
const NO_REASON = ": refused: no reason given";
/** The helper's words for an act left out of the menu: "<act>: left out: <reason>". */
const LEFT_OUT = /^(.*?): left out: (.*)$/;

/**
 * The refusals and left-out acts of one object, in plain words. A refusal with a reason stays word for word. The refusals
 * the game gave no reason for become one count line. The left-out acts of her phone become one line, grouped by reason.
 */
function awayLines(refused: readonly string[], leftOut: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  const words: string[] = [];
  let withoutReason = 0;
  for (const raw of [...refused, ...leftOut]) {
    const line = dropTokens(raw);
    const left = LEFT_OUT.exec(line);
    if (left) {
      const [, act = "", reason = ""] = left;
      groups.set(reason, [...(groups.get(reason) ?? []), act]);
    } else if (line.endsWith(NO_REASON)) {
      withoutReason++;
    } else {
      words.push(line);
    }
  }
  const lines: string[] = [...words];
  if (withoutReason > 0) {
    lines.push(`${withoutReason} more ${withoutReason === 1 ? "act" : "acts"} the game does not offer here now.`);
  }
  if (groups.size) {
    const parts = [...groups].map(([reason, acts]) => `${acts.join(", ")} (${reason})`);
    lines.push(`Left out of your phone: ${parts.join(", ")}.`);
  }
  return lines;
}

/** One object's line, its states, the game's reasons and the acts left out under it, and its answer rules when it is a question. */
function objectLines(object: OptionObject): string[] {
  const where = object.where ? ` (${object.where})` : "";
  const noWay = typeof object.noWay === "string" ? ` [${object.noWay}]` : "";
  const acts = object.acts
    .filter((act) => act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string")
    .map((act) => `${act.ref} ${dropTokens(act.text)}${act.needs_sim === true ? " (needs a Sim: name one with sim)" : ""}${typeof act.opens === "string" ? ` [${act.opens}]` : ""}`)
    .join("; ");
  const lines = [`- ${dropTokens(object.object)}${where}${noWay}: ${acts}`];
  if (object.states?.length) lines.push(`  States: ${object.states.map((state) => dropTokens(state)).join(", ")}.`);
  for (const line of awayLines(object.refused ?? [], object.left_out ?? [])) lines.push(`  ${line}`);
  const rules = answerRulesOf(object);
  if (rules) lines.push(`  Answer rules: ${describeRules(rules)}.`);
  return lines;
}

/**
 * The choices as a set of (ref, words, no-way, opens, room, near, states, refusals, left-out acts), ignoring distances; "" when
 * there are none. A move from one room to another, or into or out of near, is a change of choices (C7). So is a change of a
 * state, a refusal or a left-out act: the choices are listed again then (T3).
 */
export function choicesSignature(options: readonly OptionObject[]): string {
  const rows = new Set<string>();
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string") {
        const noWay = typeof object.noWay === "string" ? object.noWay : null;
        const opens = typeof act.opens === "string" ? act.opens : null;
        const room = typeof object.room === "string" ? object.room : null;
        const words = [object.states ?? null, object.refused ?? null, object.left_out ?? null];
        rows.add(JSON.stringify([act.ref, act.text, noWay, opens, room, isNear(object), ...words]));
      }
    }
  }
  return [...rows].sort().join("\n");
}

/**
 * A look that changed nothing answers in one line (D2): the look is the only thing the game sent, the choices are the same
 * as the last view's, and the view carries no day record. "Changed" means what the game sent as change, its feed; the
 * body block of the last view still stands, except for the clock, which the line gives. Undefined when the view is not that.
 */
export function unchangedLookLine(input: {
  percepts: readonly Percept[]; options: readonly OptionObject[] | undefined; lastChoices: string | undefined;
  portrait: unknown; hasDay: boolean;
}): string | undefined {
  if (input.hasDay || input.options === undefined || input.lastChoices === undefined) return undefined;
  if (!input.percepts.some((item) => item.kind === "look") || input.percepts.some((item) => item.kind !== "look")) return undefined;
  if (choicesSignature(input.options) !== input.lastChoices) return undefined;
  const portrait = input.portrait !== null && typeof input.portrait === "object" && !Array.isArray(input.portrait)
    ? input.portrait as Record<string, unknown> : {};
  const clock = clockLine(portrait);
  return `Your look: no change in the game since your last view, and the choices are the same.${clock ? ` ${clock}` : ""}`;
}

/** The line that says how many choice objects the game left out of the table, and in which rooms. */
function optionsCutLine(cut: OptionsCut | undefined): string | undefined {
  if (!cut || cut.objects <= 0) return undefined;
  const rooms = cut.rooms.length ? cut.rooms.join(", ") : "rooms it did not name";
  return `The game left out ${cut.objects} more choice object(s) on the lot, in ${rooms}.`;
}
