// The option table of a game view: what the game offers the Lar to do, each act with a short ref (a1, a2 ...)
// the Lar names. The world reads the table from the stored view and renders it as plain words. It never picks
// an option, ranks anything or says what the Lar should do.

import type { Found, OptionObject, AnswerRules } from "./answers.js";
import { answerRulesOf } from "./answers.js";
import type { OptionsCut, Percept } from "./wire.js";
import { type AttachmentNow, bodyLines } from "./body.js";
import { BAND_WORDS, capitalised, plainName, textOrUndefined } from "./words.js";

/** The longest the rendered view may be, in characters. The rest is said as a count. */
export const VIEW_TEXT_MAX = 20_000;
/** The longest an older view's brief may be, in characters. The rest is said as a count. */
export const BRIEF_MAX = 1_000;
const FACT_MAX = 80;

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
      const shown = typeof value === "string" ? value
        : typeof value === "number" || typeof value === "boolean" || value === null ? String(value)
          : JSON.stringify(value) ?? "";
      return `${key} ${clip(shown, FACT_MAX)}`;
    })
    .join(", ");
}

const ORIGIN_WORDS: Readonly<Record<string, string>> = { her_choice: "your act", script: "your act", game: "the game", native_reaction: "the game, on its own" };

/** A text the game sent, trimmed; anything that is not text, or is empty, is undefined. */
function said(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
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
    case "need": {
      const subject = textOrUndefined(facts.subject);
      const band = textOrUndefined(facts.band);
      if (!subject || !band) return undefined;
      return `${capitalised(plainName(subject))}: ${BAND_WORDS[band] ?? band}.`;
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
    case "env":
      return facts.from_room !== undefined ? "She moved rooms." : undefined;
    case "sleep_onset":
      return "She fell asleep.";
    case "lineage": {
      const lineage = textOrUndefined(facts.bucket);
      const reason = textOrUndefined(facts.reason);
      return `Her life line changed${lineage ? ` (${plainName(lineage)})` : ""}${reason ? `: ${reason}` : ""}.`;
    }
    case "notice": {
      const text = sentence(facts.text);
      const title = facts.title === undefined ? "" : said(facts.title);
      if (text === undefined || title === undefined) return undefined;
      return `The game says: ${title ? `${title}: ` : ""}${text}`;
    }
    case "self":
      return sentence(facts.text);
    case "gap":
      return "Part of the game's feed was missed.";
    default:
      return undefined;
  }
}

/** One percept's line in a view: its plain sentence, or the old "kind: facts" line for a kind it does not know. */
export function perceptLine(percept: Percept): string {
  const sentence = perceptSentence(percept);
  const label = percept.kind.replace(/_/g, " ");
  const facts = factsText(percept.facts);
  return sentence !== undefined ? `- ${sentence}` : `- ${label}${facts ? `: ${facts}` : ""}`;
}

/**
 * The brief of an older view, kept in its row: the percept lines only, in the words the view shows them. No body and
 * no choices. "An earlier view." when there are no percept lines.
 */
export function viewBrief(percepts: readonly Percept[]): string {
  if (percepts.length === 0) return "An earlier view.";
  const lines: string[] = [];
  let used = 0;
  for (const percept of percepts) {
    const line = perceptLine(percept);
    if (used + line.length > BRIEF_MAX) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < percepts.length) lines.push(`- (${percepts.length - lines.length} more not shown)`);
  return lines.join("\n");
}

/**
 * The plain text of a game view for the Lar: what the game shows, then the choices it offers, each with its ref.
 * Shows the ref and the game's words only; no id, no matcher hint, no advice.
 */
export function renderView(input: {
  world: string; percepts: readonly Percept[]; options: readonly OptionObject[]; portrait?: unknown; attachment?: AttachmentNow;
  /** Her attention, the first line of the body block (see attentionLine). */
  attention?: string;
  /** The choices of the last view rendered on this thread (see choicesSignature), or undefined when there was none. */
  lastChoices?: string;
  optionsCut?: OptionsCut;
}): string {
  const body = bodyLines(input.portrait, input.attachment, input.attention);
  const head = [...(body.length ? ["Your body now:", ...body, ""] : []), `The game (${input.world}) shows:`];
  const lines: string[] = [...head];
  let shown = 0;
  let used = head.reduce((sum, line) => sum + line.length + 1, 0);
  for (const percept of input.percepts) {
    const line = perceptLine(percept);
    if (used + line.length > VIEW_TEXT_MAX) break;
    lines.push(line);
    used += line.length;
    shown++;
  }
  if (shown < input.percepts.length) lines.push(`- (${input.percepts.length - shown} more not shown)`);
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
  if (elsewhere.length) {
    lines.push("Elsewhere on the lot:");
    const rooms = new Map<string, OptionObject[]>();
    for (const object of elsewhere) {
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

/** Near her: the helper's near flag, or a where that starts "here" (what older helpers send). */
function isNear(object: OptionObject): boolean {
  return object.near === true || (typeof object.where === "string" && object.where.startsWith("here"));
}

/** One object's line, and its answer rules when it is a question. */
function objectLines(object: OptionObject): string[] {
  const where = object.where ? ` (${object.where})` : "";
  const noWay = typeof object.noWay === "string" ? ` [${object.noWay}]` : "";
  const acts = object.acts
    .filter((act) => act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string")
    .map((act) => `${act.ref} ${act.text}${typeof act.opens === "string" ? ` [${act.opens}]` : ""}`)
    .join("; ");
  const lines = [`- ${object.object}${where}${noWay}: ${acts}`];
  const rules = answerRulesOf(object);
  if (rules) lines.push(`  Answer rules: ${describeRules(rules)}.`);
  return lines;
}

/** The choices as a set of (ref, words, no-way, opens), ignoring distances; "" when there are none. */
export function choicesSignature(options: readonly OptionObject[]): string {
  const rows = new Set<string>();
  for (const object of options) {
    for (const act of object.acts) {
      if (act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string") {
        const noWay = typeof object.noWay === "string" ? object.noWay : null;
        const opens = typeof act.opens === "string" ? act.opens : null;
        rows.add(JSON.stringify([act.ref, act.text, noWay, opens]));
      }
    }
  }
  return [...rows].sort().join("\n");
}

/** The line that says how many choice objects the game left out of the table, and in which rooms. */
function optionsCutLine(cut: OptionsCut | undefined): string | undefined {
  if (!cut || cut.objects <= 0) return undefined;
  const rooms = cut.rooms.length ? cut.rooms.join(", ") : "rooms it did not name";
  return `The game left out ${cut.objects} more choice object(s) on the lot, in ${rooms}.`;
}
