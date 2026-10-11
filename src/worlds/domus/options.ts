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

/**
 * The plain text of a game view for the Lar: what the game shows, then the choices it offers, each with its ref.
 * Shows the ref and the game's words only; no id, no matcher hint, no advice.
 */
export function renderView(input: { world: string; percepts: readonly Percept[]; options: readonly OptionObject[] }): string {
  const lines: string[] = [`The game (${input.world}) shows:`];
  let shown = 0;
  let used = lines[0]!.length;
  for (const percept of input.percepts) {
    const label = percept.kind.replace(/_/g, " ");
    const facts = factsText(percept.facts);
    const line = `- ${label}${facts ? `: ${facts}` : ""}`;
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
