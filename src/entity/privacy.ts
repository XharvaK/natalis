// The privacy list: words the summoner (the human who summoned the Lar) does not want sent outside the summoner's own
// places. The owner edits privacy.json in the entity's folder, outside notebook/, so the entity cannot write it.
// The body only checks bytes against the list. It never judges what a word means, and it never rewrites words.
//
// File shape: { "terms": [{ "term": "...", "category": "..." }], "categories": ["..."] }. Both keys are optional.
// A missing file is an empty list. A file that cannot be read or does not have that shape counts as empty, and
// the problem is kept so the now board can say so; nothing crashes.

import { readFileSync, statSync } from "node:fs";

export const PRIVACY_FILE = "privacy.json";

const ROOT_KEYS = ["terms", "categories"] as const;
const TERM_KEYS = ["term", "category"] as const;

export type PrivacyTerm = { term: string; category: string };
export type PrivacyList = { terms: PrivacyTerm[]; categories: string[] };
/** The list as read, and why it could not be read (when it could not). */
export type PrivacyLoad = { list: PrivacyList; problem?: string };

export const EMPTY_PRIVACY_LIST: PrivacyList = { terms: [], categories: [] };

/** Checks an already-parsed privacy file. Throws a plain error naming the first wrong part. */
export function parsePrivacyList(value: unknown): PrivacyList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the file must be an object");
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!(ROOT_KEYS as readonly string[]).includes(key)) throw new Error(`unknown field "${key}"`);
  }
  const rawTerms = root["terms"] ?? [];
  if (!Array.isArray(rawTerms)) throw new Error('"terms" must be a list');
  const terms = rawTerms.map((item, index) => parseTerm(item, index));
  const rawCategories = root["categories"] ?? [];
  if (!Array.isArray(rawCategories)) throw new Error('"categories" must be a list');
  const categories = rawCategories.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") throw new Error(`categories[${index}] must be non-empty text`);
    return item.trim();
  });
  return { terms, categories };
}

function parseTerm(item: unknown, index: number): PrivacyTerm {
  const where = `terms[${index}]`;
  if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`${where} must be an object`);
  const block = item as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!(TERM_KEYS as readonly string[]).includes(key)) throw new Error(`unknown field "${key}" in ${where}`);
  }
  const term = block["term"];
  const category = block["category"];
  if (typeof term !== "string" || term.trim() === "") throw new Error(`${where}.term must be non-empty text`);
  if (typeof category !== "string" || category.trim() === "") throw new Error(`${where}.category must be non-empty text`);
  return { term: term.trim(), category: category.trim() };
}

/** Reads the privacy file. Missing is an empty list with no problem; anything else wrong is an empty list plus a problem. */
export function readPrivacyFile(path: string): PrivacyLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { list: EMPTY_PRIVACY_LIST };
    return { list: EMPTY_PRIVACY_LIST, problem: `the file could not be read (${messageOf(err)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { list: EMPTY_PRIVACY_LIST, problem: `the file is not valid JSON (${messageOf(err)})` };
  }
  try {
    return { list: parsePrivacyList(parsed) };
  } catch (err) {
    return { list: EMPTY_PRIVACY_LIST, problem: messageOf(err) };
  }
}

export interface PrivacyWatch {
  /** The list as it is now. Reloads when the file's modification time or size has changed since the last read. */
  current(): PrivacyLoad;
}

export function createPrivacyWatch(path: string): PrivacyWatch {
  let stamp: string | undefined | null = null; // null: never read yet
  let loaded: PrivacyLoad = { list: EMPTY_PRIVACY_LIST };
  return {
    current(): PrivacyLoad {
      const next = fileStamp(path);
      if (next !== stamp) {
        stamp = next;
        loaded = readPrivacyFile(path);
      }
      return loaded;
    },
  };
}

function fileStamp(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/** The form words are compared in: compatibility letters folded, case folded, spaces collapsed. */
export function holdForm(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The first term on the list that appears in the text as a whole word or phrase. A letter, digit or mark directly
 * before or after the match means it is part of a longer word, so it does not count.
 */
export function privacyHit(text: string, list: PrivacyList): PrivacyTerm | undefined {
  const haystack = holdForm(text);
  for (const entry of list.terms) {
    const needle = holdForm(entry.term);
    if (needle === "") continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeForRegExp(needle)}(?![\\p{L}\\p{N}\\p{M}])`, "u");
    if (pattern.test(haystack)) return entry;
  }
  return undefined;
}

/** The categories shown to the entity: the listed ones first, then any that only a term names. No terms are shown. */
export function privacyCategories(list: PrivacyList): string[] {
  const seen = new Set<string>();
  for (const category of [...list.categories, ...list.terms.map((entry) => entry.category)]) {
    seen.add(category);
  }
  return [...seen];
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
