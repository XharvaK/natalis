// Builds the system text for one turn, sized to the model's window.
// Core sections are always kept, in the order given. Other sections are kept by descending priority while
// they fit whole; a section that does not fit is dropped entirely, never cut. Kept sections are emitted in
// their original order. When anything was dropped, one trailing line names it, so the mind knows.
// Sizes are estimated as characters divided by charsPerToken; the window is the model's declared size minus
// reserveTokens (room for the history and the reply).

import type { ContextSection } from "../contracts.js";

export type AssembleOptions = {
  /** Tokens kept free for history and output. Default 8000. */
  reserveTokens?: number;
  /** Rough characters per token. Default 4. */
  charsPerToken?: number;
};

export type Assembled = {
  text: string;
  /** Names of the non-core sections that were not shown, in their original order. */
  dropped: string[];
  /** Estimated tokens of `text`. */
  usedTokens: number;
};

export function assembleSystem(
  sections: ContextSection[],
  contextTokens: number,
  options: AssembleOptions = {},
): Assembled {
  const reserveTokens = options.reserveTokens ?? 8000;
  const charsPerToken = options.charsPerToken ?? 4;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    throw new RangeError(`contextTokens must be a positive number, got ${contextTokens}.`);
  }
  if (!(charsPerToken > 0)) throw new RangeError(`charsPerToken must be positive, got ${charsPerToken}.`);

  const maxChars = Math.max(0, Math.floor((contextTokens - reserveTokens) * charsPerToken));
  const rendered = sections.map((section) => `## ${section.name}\n${section.text}`);
  const coreIndexes = sections.flatMap((section, i) => (section.core ? [i] : []));
  const optionalByPriority = sections
    .flatMap((section, i) => (section.core ? [] : [i]))
    .sort((a, b) => (sections[b]?.priority ?? 0) - (sections[a]?.priority ?? 0) || a - b);

  // Greedy pick of optional sections, measured in characters of the joined text.
  const pack = (limitChars: number): { keep: Set<number>; dropped: number[] } => {
    const keep = new Set<number>(coreIndexes);
    let total = 0;
    let count = 0;
    for (const i of coreIndexes) {
      total = joinedLength(total, count, rendered[i] ?? "");
      count += 1;
    }
    const dropped: number[] = [];
    for (const i of optionalByPriority) {
      const candidate = joinedLength(total, count, rendered[i] ?? "");
      if (candidate <= limitChars) {
        keep.add(i);
        total = candidate;
        count += 1;
      } else {
        dropped.push(i);
      }
    }
    return { keep, dropped: dropped.sort((a, b) => a - b) };
  };

  const build = (keep: Set<number>, note: string): string => {
    const parts = sections.flatMap((_section, i) => (keep.has(i) ? [rendered[i] ?? ""] : []));
    if (note !== "") parts.push(note);
    return parts.join("\n\n");
  };

  const noteFor = (dropped: number[]): string =>
    dropped.length === 0
      ? ""
      : `(Not shown this turn for space: ${dropped.map((i) => sections[i]?.name ?? "").join(", ")}.)`;

  // The trailing note takes room too. Re-pack with room reserved for it until the note fits.
  let reserve = 0;
  let packed = pack(maxChars);
  while (packed.dropped.length > 0) {
    const note = noteFor(packed.dropped);
    const need = build(packed.keep, note).length - build(packed.keep, "").length;
    if (need <= reserve) break;
    reserve = need;
    packed = pack(maxChars - reserve);
  }

  const text = build(packed.keep, noteFor(packed.dropped));
  return {
    text,
    dropped: packed.dropped.map((i) => sections[i]?.name ?? ""),
    usedTokens: Math.ceil(text.length / charsPerToken),
  };
}

function joinedLength(total: number, count: number, rendered: string): number {
  return total + (count > 0 ? 2 : 0) + rendered.length;
}
