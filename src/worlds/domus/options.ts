// The option table of a game view: what the game offers the Lar to do, each act with a short ref (a1, a2 ...)
// the Lar names. The world reads the table from the stored view and renders it as plain words. It never picks
// an option, ranks anything or says what the Lar should do.

import type { Found, OptionObject, AnswerRules } from "./answers.js";
import { answerRulesOf } from "./answers.js";
import type { Percept } from "./wire.js";

/** The longest the rendered view may be, in characters. The rest is said as a count. */
export const VIEW_TEXT_MAX = 6000;
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

const BAND_WORDS: Readonly<Record<string, string>> = { distress: "very low", low: "low", ok: "fine", high: "full", full: "full" };
const ORIGIN_WORDS: Readonly<Record<string, string>> = { her_choice: "your act", script: "your act", game: "the game", native_reaction: "the game, on its own" };

function textOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A game name in plain words: the tuning name of a class string, with camel case, "_" and "-" as spaces, lower case. */
export function plainName(text: string): string {
  const tuning = /<class '([^']*)'>/.exec(text)?.[1] ?? text;
  const last = tuning.split(".").pop() ?? tuning;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function capitalised(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
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
    case "gap":
      return "Part of the game's feed was missed.";
    default:
      return undefined;
  }
}

/**
 * The plain text of a game view for the Lar: what the game shows, then the choices it offers, each with its ref.
 * Shows the ref and the game's words only; no id, no matcher hint, no advice.
 */
export function renderView(input: { world: string; percepts: readonly Percept[]; options: readonly OptionObject[] }): string {
  const lines: string[] = [`The game (${input.world}) shows:`];
  let shown = 0;
  let used = lines[0]!.length;
  for (const percept of input.percepts) {
    const sentence = perceptSentence(percept);
    const label = percept.kind.replace(/_/g, " ");
    const facts = factsText(percept.facts);
    const line = sentence !== undefined ? `- ${sentence}` : `- ${label}${facts ? `: ${facts}` : ""}`;
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
  lines.push("", "Choices you can name with game_act, by ref:");
  for (const object of input.options) {
    const where = object.where ? ` (${object.where})` : "";
    const noWay = typeof object.noWay === "string" ? ` [${object.noWay}]` : "";
    const acts = object.acts
      .filter((act) => act && typeof act === "object" && typeof act.ref === "string" && typeof act.text === "string")
      .map((act) => `${act.ref} ${act.text}${typeof act.opens === "string" ? ` [${act.opens}]` : ""}`)
      .join("; ");
    lines.push(`- ${object.object}${where}${noWay}: ${acts}`);
    const rules = answerRulesOf(object);
    if (rules) lines.push(`  Answer rules: ${describeRules(rules)}.`);
  }
  return lines.join("\n");
}
