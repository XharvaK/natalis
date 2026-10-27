// Builds the system text for one turn, sized to the model's window.
// Core sections are always kept, in the order given. Other sections are kept by descending priority while
// they fit whole; a section without items that does not fit is dropped entirely, never cut. A section made of
// items is filled with whole items best first and a pointer for the rest (Q19). An item is never cut; an item
// bigger than the room left gets a pointer only. Kept sections are emitted in their original order. When a
// section was dropped entirely, one trailing line names it, so the mind knows.
// Sizes are estimated as characters divided by charsPerToken; the window is the model's declared size minus
// reserveTokens (room for the history and the reply).

import type { ContextSection } from "../contracts.js";

export type AssembleOptions = {
  /** Tokens kept free for history and output. Default 8000. */
  reserveTokens?: number;
  /** Rough characters per token. Default 4. */
  charsPerToken?: number;
};

/**
 * Q19: the whole items an optional section is made of, best first, and the one line that names the items that
 * did not fit. The pointer names its items (a seq or a path); it never repeats or rewrites their text.
 */
export type SectionItems = {
  /** Whole items, best first. */
  items: readonly string[];
  /** One key per item, in the same order: the seq number or note path the pointer names. */
  keys: readonly string[];
  /** The one pointer line for the items that did not fit. */
  pointer: (keys: readonly string[]) => string;
  /** Text shown before the items, whenever any part of the section is shown. */
  lead?: string;
  /** What joins the lead, the items and the pointer. Default "\n". */
  sep?: string;
};

/** A section the assembler can fill item by item. A section without items is kept or dropped whole, as before. */
export type AssemblableSection = ContextSection & { items?: SectionItems };

export type AssembledPart = { name: string; text: string };

export type Assembled = {
  text: string;
  /** Names of the non-core sections that were not shown, in their original order. */
  dropped: string[];
  /** Estimated tokens of `text`. */
  usedTokens: number;
  /** The rendered text of each section that was shown, whole or in part, in the original order. */
  shown: AssembledPart[];
};

/** The body of a section made of whole items: its lead, the first `shown` items, and a pointer for the rest. */
export function itemsText(items: SectionItems, shown: number): string {
  const sep = items.sep ?? "\n";
  const count = Math.max(0, Math.min(shown, items.items.length));
  const parts: string[] = [];
  if (items.lead !== undefined && items.lead !== "") parts.push(items.lead);
  parts.push(...items.items.slice(0, count));
  if (count < items.items.length) parts.push(items.pointer(items.keys.slice(count)));
  return parts.join(sep);
}

export function assembleSystem(
  sections: AssemblableSection[],
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
  const rendered = sections.map((section) => {
    const body = section.items === undefined ? section.text : itemsText(section.items, section.items.items.length);
    return `## ${section.name}\n${body}`;
  });
  const coreIndexes = sections.flatMap((section, i) => (section.core ? [i] : []));
  const optionalByPriority = sections
    .flatMap((section, i) => (section.core ? [] : [i]))
    .sort((a, b) => (sections[b]?.priority ?? 0) - (sections[a]?.priority ?? 0) || a - b);

  type Packed = { shown: Map<number, string>; dropped: number[] };

  // Greedy pick of optional sections, measured in characters of the joined text. A section that does not fit
  // whole is filled with as many of its whole items as fit, with a pointer line for the rest.
  const pack = (limitChars: number): Packed => {
    const shown = new Map<number, string>();
    let total = 0;
    let count = 0;
    const add = (i: number, text: string): void => {
      total = joinedLength(total, count, text);
      count += 1;
      shown.set(i, text);
    };
    for (const i of coreIndexes) add(i, rendered[i] ?? "");
    const dropped: number[] = [];
    for (const i of optionalByPriority) {
      const section = sections[i];
      if (section === undefined) continue;
      const room = limitChars - total - (count > 0 ? 2 : 0);
      const whole = rendered[i] ?? "";
      if (whole.length <= room) {
        add(i, whole);
        continue;
      }
      const items = section.items;
      if (items === undefined || items.items.length === 0) {
        dropped.push(i);
        continue;
      }
      // The most whole items that fit, with the pointer line for the rest. Zero items is still a section when
      // the pointer fits: an item bigger than the room left gets a pointer only, never a cut.
      let chosen: string | undefined;
      for (let k = items.items.length - 1; k >= 0; k--) {
        const text = `## ${section.name}\n${itemsText(items, k)}`;
        if (text.length <= room) {
          chosen = text;
          break;
        }
      }
      if (chosen === undefined) dropped.push(i);
      else add(i, chosen);
    }
    return { shown, dropped: dropped.sort((a, b) => a - b) };
  };

  const build = (packed: Packed, note: string): string => {
    const parts = sections.flatMap((_section, i) => {
      const text = packed.shown.get(i);
      return text === undefined ? [] : [text];
    });
    if (note !== "") parts.push(note);
    return parts.join("\n\n");
  };

  const noteFor = (dropped: number[]): string =>
    dropped.length === 0 ? "" : droppedNote(dropped.map((i) => sections[i]?.name ?? ""));

  // The trailing note takes room too. Re-pack with room reserved for it until the note fits.
  let reserve = 0;
  let packed = pack(maxChars);
  while (packed.dropped.length > 0) {
    const note = noteFor(packed.dropped);
    const need = build(packed, note).length - build(packed, "").length;
    if (need <= reserve) break;
    reserve = need;
    packed = pack(maxChars - reserve);
  }

  const text = build(packed, noteFor(packed.dropped));
  return {
    text,
    dropped: packed.dropped.map((i) => sections[i]?.name ?? ""),
    usedTokens: Math.ceil(text.length / charsPerToken),
    shown: sections.flatMap((section, i) => {
      const shownText = packed.shown.get(i);
      return shownText === undefined ? [] : [{ name: section.name, text: shownText }];
    }),
  };
}

/** The one trailing line that names the optional sections a turn did not show. */
export function droppedNote(names: string[]): string {
  return `(Not shown this turn for space: ${names.join(", ")}.)`;
}

function joinedLength(total: number, count: number, rendered: string): number {
  return total + (count > 0 ? 2 : 0) + rendered.length;
}
