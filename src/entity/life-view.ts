// Q21: the part of her life file a turn shows. Below the switch the whole file is shown. At or over the switch
// she sees the first part whole, then whole sections ranked by how many of this turn's words they share, then a
// pointer line for every heading that was not shown. Nothing here rewords or cuts the file: every section shown
// is the file's own text, and the honesty check still reads the whole file separately.
//
// The 9A ranker: a section's score is the number of distinct words of this turn's new rows and recent lines that
// the section also uses. Ties keep file order. Sections that do not fit are not shortened; their headings are named.

import { queryWords } from "../notebook/forget.js";
import { noteSections, type NoteSection } from "../notebook/sections.js";

export type LifeViewMode = "whole" | "sections";

export type LifeView = {
  /** The text shown under "your life". */
  text: string;
  mode: LifeViewMode;
  /** The text before the second heading, or before the first heading when the file starts with text. */
  firstPart: string;
  /** Whole sections shown, in the order they are shown (best match first). */
  shownSections: NoteSection[];
  /** Sections named at the end, in file order. */
  hiddenSections: NoteSection[];
  /** True when the file is over the switch and has no headings to split it by. */
  needsHeadings: boolean;
};

export type LifeViewOptions = {
  /** The file is shown whole below this many characters; at or over it, the sectioned view is used. */
  switchChars: number;
  /** The most characters of the switched view: the first part and the whole sections shown beside it. */
  viewChars: number;
  /**
   * N1: a line put under a section's heading, such as when it was last edited; undefined puts none. Only the view
   * carries it: the file is never changed, and the stamp does not count toward viewChars.
   */
  stampOf?: (section: NoteSection) => string | undefined;
};

/** N1: "(last edited YYYY-MM-DD, N days ago)", the date in the Lar's zone and N in whole days. */
export function editedStamp(editedMs: number, nowMs: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(editedMs));
  const days = Math.max(0, Math.floor((nowMs - editedMs) / 86_400_000));
  return `(last edited ${date}, ${days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`})`;
}

/** The text with each section's stamp on the line after its heading; the text itself is not changed. */
function withStamps(text: string, sections: readonly NoteSection[], stampOf: LifeViewOptions["stampOf"]): string {
  if (stampOf === undefined) return text;
  let out = text;
  for (const section of sections) {
    const stamp = stampOf(section);
    if (stamp === undefined) continue;
    const at = out.indexOf(section.heading);
    if (at === -1) continue;
    const lineEnd = out.indexOf("\n", at);
    out = lineEnd === -1 ? `${out}\n${stamp}` : `${out.slice(0, lineEnd)}\n${stamp}${out.slice(lineEnd)}`;
  }
  return out;
}

/** Characters as Unicode code points, so an emoji or an accented letter counts as one. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function lifeView(source: string, query: string, options: LifeViewOptions): LifeView {
  const whole = source.trim();
  const sections = noteSections(source);
  const over = charCount(source) >= options.switchChars;
  if (!over || sections.length === 0) {
    return {
      text: stampWhole(whole, sections, options.stampOf),
      mode: "whole",
      firstPart: whole,
      shownSections: [],
      hiddenSections: [],
      needsHeadings: over && sections.length === 0,
    };
  }

  const preambleEnd = sections[0]?.start ?? source.length;
  const startsWithHeading = source.slice(0, preambleEnd).trim() === "";
  const firstEnd = startsWithHeading ? (sections[1]?.start ?? source.length) : preambleEnd;
  const firstPart = source.slice(0, firstEnd).trim();
  const remaining = startsWithHeading ? sections.slice(1) : sections;
  const ranked = rankSections(remaining, query);

  const shown: NoteSection[] = [];
  let used = charCount(firstPart);
  for (const section of ranked) {
    const add = charCount(section.text) + (used === 0 ? 0 : 2);
    if (used + add > options.viewChars) break;
    shown.push(section);
    used += add;
  }
  const shownSet = new Set(shown);
  const hidden = remaining.filter((section) => !shownSet.has(section));
  const parts: string[] = [];
  if (firstPart !== "") parts.push(withStamps(firstPart, startsWithHeading && sections[0] ? [sections[0]] : [], options.stampOf));
  for (const section of shown) if (section.text !== "") parts.push(withStamps(section.text, [section], options.stampOf));
  if (hidden.length > 0) {
    parts.push(
      [
        "Sections not shown this turn, each opened whole with read_note:",
        ...hidden.map((section) => `- read_note self/life.md section: ${section.heading}`),
      ].join("\n"),
    );
  }
  return {
    text: parts.join("\n\n"),
    mode: "sections",
    firstPart,
    shownSections: shown,
    hiddenSections: hidden,
    needsHeadings: false,
  };
}

/**
 * The sections ordered by how many distinct words of `query` they use. Equal scores keep file order. A section
 * with no shared words still ranks, after the ones that share some.
 */
export function rankSections(sections: readonly NoteSection[], query: string): NoteSection[] {
  const wanted = new Set(queryWords(query).map(cleanWord).filter((word) => word !== ""));
  if (wanted.size === 0) return [...sections];
  return sections
    .map((section, index) => ({ section, index, score: sharedWords(section.text, wanted) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.section);
}

function sharedWords(text: string, wanted: ReadonlySet<string>): number {
  const words = new Set(queryWords(text).map(cleanWord).filter((word) => word !== ""));
  let count = 0;
  for (const word of wanted) if (words.has(word)) count += 1;
  return count;
}

/** A word without the punctuation around it, so "work?" and "Work" are the same word. */
function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** The whole file with every section stamped, one heading at a time from the end so earlier offsets hold. */
function stampWhole(whole: string, sections: readonly NoteSection[], stampOf: LifeViewOptions["stampOf"]): string {
  if (stampOf === undefined) return whole;
  const local = noteSections(whole);
  const parts: string[] = [];
  let cursor = whole.length;
  for (let index = local.length - 1; index >= 0; index -= 1) {
    const section = local[index] as NoteSection;
    const original = sections[index] ?? section;
    const piece = whole.slice(section.start, cursor);
    parts.unshift(withStamps(piece, [{ ...original, heading: section.heading }], stampOf));
    cursor = section.start;
  }
  parts.unshift(whole.slice(0, cursor));
  return parts.join("");
}
