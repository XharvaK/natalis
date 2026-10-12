// The answers a Lar may give to a game question: rows picked by ref (with counts) and words typed into fields.
// Checked against the answer_rules the game's question carried in the newest view. Anything wrong is refused
// with a plain sentence; nothing is trimmed, guessed or substituted. Ported from the old listener's acts.

import { GUID64_PATTERN, isRecord } from "./wire.js";

/** Answer bounds: rows and fields per answer, the count per row, the length of one typed value (characters). */
export const ANSWER_ROWS = 16;
export const ANSWER_COUNT = 99;
export const ANSWER_FIELDS = 8;
export const ANSWER_TEXT = 256;
const REF = /^[A-Za-z0-9._-]{1,16}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,32}$/;

/** One answer as the Lar writes it: rows by option ref (with counts), and typed words by field name. */
export type AnswerClaim = { rows?: Array<{ option: string; count?: number }>; text?: Record<string, string> };

export type TextRule = {
  name: string; label: string; min_length: number; max_length: number | null; numeric: boolean;
  min_value: number | null; max_value: number | null; profanity_checked: boolean; restricted?: boolean;
};

/** What a game question accepts. Absent for a window that is not a question an answer can be given to. */
export type AnswerRules = {
  /** In select and counts, a maximum of 0 means no limit (the game's own convention). */
  select?: { min: number; max: number };
  counts?: { max_in_row: number; max_rows: number };
  text?: TextRule[];
};

export type OptionAct = { ref: string; guid64: string; text: string; opens?: string };
export type OptionObject = {
  object: string; object_id: string; where?: string; acts: OptionAct[]; noWay?: string; answer_rules?: unknown;
  /** The room the object is in, by its name; absent when the helper does not know it. */
  room?: string;
  /** True for an object near her (the helper's own reckoning). */
  near?: boolean;
  /** True for a Sim (a person): the only kind of option her words to them go with (S1). */
  person?: boolean;
};
export type Found = { object: OptionObject; act: OptionAct };
/** The answer as it is kept and sent to the helper: rows by the game's own option ids, counts resolved, text as typed. */
export type StoredAnswer = { rows?: Array<{ option_id: string; count: number }>; text?: Record<string, string> };

export type AnswerResult = { stored: true; json: string; label: string } | { refused: { code: string; reason: string } };

/** The shape only: rows or text (or both); rows 1..16 with refs and counts 1..99; text 1..8 named fields of 1..256 characters. */
export function isAnswerClaim(value: unknown): value is AnswerClaim {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "rows" || key === "text")) return false;
  if (value.rows === undefined && value.text === undefined) return false;
  const rowsOk = value.rows === undefined || (Array.isArray(value.rows) && value.rows.length >= 1 && value.rows.length <= ANSWER_ROWS
    && value.rows.every((row) => isRecord(row) && Object.keys(row).every((key) => key === "option" || key === "count")
      && typeof row.option === "string" && REF.test(row.option)
      && (row.count === undefined || (Number.isInteger(row.count) && (row.count as number) >= 1 && (row.count as number) <= ANSWER_COUNT))));
  const entries = isRecord(value.text) ? Object.entries(value.text) : undefined;
  const textOk = value.text === undefined || (entries !== undefined && entries.length >= 1 && entries.length <= ANSWER_FIELDS
    && entries.every(([name, text]) => FIELD_NAME.test(name) && typeof text === "string"
      && [...text].length >= 1 && [...text].length <= ANSWER_TEXT));
  return rowsOk && textOk;
}

/**
 * The answer rules of one option object, read defensively: a malformed rule set counts as none, so a claim
 * against it is refused rather than checked against guessed bounds.
 */
export function answerRulesOf(object: OptionObject): AnswerRules | undefined {
  const rules = object.answer_rules;
  if (!isRecord(rules)) return undefined;
  const integer = (value: unknown): value is number => Number.isSafeInteger(value);
  const nullableInteger = (value: unknown): value is number | null => value === null || integer(value);
  const out: AnswerRules = {};
  if (rules.select !== undefined) {
    const select = rules.select;
    if (!isRecord(select) || !integer(select.min) || !integer(select.max)) return undefined;
    out.select = { min: select.min, max: select.max };
  }
  if (rules.counts !== undefined) {
    const counts = rules.counts;
    if (!isRecord(counts) || !integer(counts.max_in_row) || !integer(counts.max_rows)) return undefined;
    out.counts = { max_in_row: counts.max_in_row, max_rows: counts.max_rows };
  }
  if (rules.text !== undefined) {
    if (!Array.isArray(rules.text)) return undefined;
    const fields: TextRule[] = [];
    for (const field of rules.text) {
      if (!isRecord(field) || typeof field.name !== "string" || typeof field.label !== "string" || !integer(field.min_length)
        || !nullableInteger(field.max_length) || typeof field.numeric !== "boolean" || !nullableInteger(field.min_value)
        || !nullableInteger(field.max_value) || typeof field.profanity_checked !== "boolean"
        || (field.restricted !== undefined && typeof field.restricted !== "boolean")) return undefined;
      fields.push({
        name: field.name, label: field.label, min_length: field.min_length, max_length: field.max_length, numeric: field.numeric,
        min_value: field.min_value, max_value: field.max_value, profanity_checked: field.profanity_checked,
        ...(field.restricted !== undefined ? { restricted: field.restricted } : {}),
      });
    }
    out.text = fields;
  }
  return out;
}

function refuse(code: string, reason: string): AnswerResult {
  return { refused: { code, reason } };
}

/** A game maximum of 0 is no limit. */
function overLimit(value: number, max: number): boolean {
  return max > 0 && value > max;
}

/** Printable as the helper's game side reads it: no control, format or separator characters except the plain space. */
const UNPRINTABLE = /(?! )[\p{C}\p{Z}]/u;
const RESTRICTED_SAFE = /^[A-Za-z0-9 ]*$/;

/** One typed value against its field's rules: the first problem found, as a short code. */
function textProblem(field: TextRule, value: string): string | null {
  if (UNPRINTABLE.test(value)) return "text_control";
  if (field.restricted && !RESTRICTED_SAFE.test(value)) return "text_restricted";
  if (field.max_length === null) return "text_no_limit";
  const length = [...value].length;
  if (length > field.max_length) return "text_too_long";
  if (length < field.min_length) return "text_too_short";
  if (!field.numeric) return null;
  if (!/^-?[0-9]{1,15}$/.test(value)) return "text_not_integer";
  if (field.min_value === null || field.max_value === null) return "text_no_range";
  const amount = Number(value);
  return amount < field.min_value || amount > field.max_value ? "text_out_of_range" : null;
}

const TEXT_REASON: Record<string, string> = {
  text_control: "contains a control or invisible character",
  text_restricted: "uses characters this field does not take (letters, digits and spaces only)",
  text_no_limit: "this field has no length limit the listener can check",
  text_too_long: "is longer than the field allows",
  text_too_short: "is shorter than the field requires",
  text_not_integer: "must be a whole number",
  text_no_range: "has no range the listener can check",
  text_out_of_range: "is outside the range the field allows",
};

/**
 * Checks the Lar's answer against the question it was given in. The stored answer keeps the game's own row ids and
 * the typed words; the label says what was answered, with only the field names and lengths (never the words).
 */
export function answerFor(found: Found, answer: AnswerClaim): AnswerResult {
  if (!found.object.object_id.startsWith("dialog:")) return refuse("not_a_dialog", "That option is not a game question, so it takes no answer.");
  const rules = answerRulesOf(found.object);
  if (!rules) return refuse("no_rules", "That question carries no answer rules, so an answer cannot be checked against it.");
  if (found.act.guid64 !== "ok") return refuse("not_ok", "An answer goes with the question's ok option, not with another button.");
  const rows = answer.rows ?? [];
  if (rows.length || rules.select) {
    const select = rules.select ?? { min: 1, max: rules.counts?.max_rows ?? 1 };
    if (rows.length < select.min) return refuse("too_few_rows", `The question needs at least ${select.min} row(s); you gave ${rows.length}.`);
    if (overLimit(rows.length, select.max)) return refuse("too_many_rows", `The question takes at most ${select.max} row(s); you gave ${rows.length}.`);
    if (rules.counts && overLimit(rows.length, rules.counts.max_rows)) {
      return refuse("too_many_rows", `The question takes at most ${rules.counts.max_rows} row(s); you gave ${rows.length}.`);
    }
  }
  const picked = new Set<string>();
  const resolved: Array<{ option_id: string; count: number }> = [];
  const parts: string[] = [];
  for (const row of rows) {
    const target = found.object.acts.find((item) => item && typeof item === "object" && item.ref === row.option);
    if (!target || typeof target.guid64 !== "string" || typeof target.text !== "string") {
      return refuse("row_not_in_question", `${row.option} is not a row of this question.`);
    }
    if (!GUID64_PATTERN.test(target.guid64)) return refuse("not_a_row", `${row.option} is not a row the game can take.`);
    if (picked.has(target.ref)) return refuse("row_repeated", `${row.option} is named more than once.`);
    picked.add(target.ref);
    if (row.count !== undefined) {
      if (!rules.counts) return refuse("count_not_allowed", "This question takes one of each row; it has no counts.");
      if (overLimit(row.count, rules.counts.max_in_row)) {
        return refuse("count_too_high", `${row.option} takes at most ${rules.counts.max_in_row}; you gave ${row.count}.`);
      }
    }
    const count = row.count ?? 1;
    resolved.push({ option_id: target.guid64, count });
    parts.push(count > 1 ? `${target.text} x${count}` : target.text);
  }
  const typed = answer.text ?? {};
  const fields = rules.text ?? [];
  for (const [name, value] of Object.entries(typed)) {
    const field = fields.find((item) => item.name === name);
    if (!field) return refuse("unknown_field", `${name} is not a field of this question.`);
    const problem = textProblem(field, value);
    if (problem) return refuse(problem, `The ${name} field ${TEXT_REASON[problem] ?? "is not valid"}.`);
    parts.push(`${name} ${[...value].length} chars`);
  }
  // Every field gets a value, then ok: the game refuses a window with a field left out.
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(typed, field.name)) {
      return refuse("text_missing", `The ${field.name} field needs a value.`);
    }
  }
  const stored: StoredAnswer = {
    ...(resolved.length ? { rows: resolved } : {}),
    ...(Object.keys(typed).length ? { text: { ...typed } } : {}),
  };
  return { stored: true, json: JSON.stringify(stored), label: `answered ${found.object.object}: ${parts.join(", ")}`.slice(0, 200) };
}
