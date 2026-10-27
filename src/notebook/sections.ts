// Markdown sections in a note: a heading line begins a section, and the section runs to the next heading line.
// The parser only reads the shape of the file; it never rewords or cuts text. A line whose first non-space
// character is "#" is a heading, which is the same rule the honesty check uses to name a heading.

export type NoteSection = {
  /** The heading line as the note spells it, with only the spaces around it removed. */
  heading: string;
  /** The heading without its leading hash marks, trimmed. */
  title: string;
  /** How many hash marks the heading has. */
  level: number;
  /** Where the heading line starts in the note. */
  start: number;
  /** Where the next heading starts, or the end of the note. */
  end: number;
  /** The whole section, heading and body, as the note spells it, without the whitespace around it. */
  text: string;
};

/** Every section of a note, in file order. A note with no headings has no sections. */
export function noteSections(source: string): NoteSection[] {
  const found: Array<{ start: number; heading: string }> = [];
  let at = 0;
  while (at <= source.length) {
    const newline = source.indexOf("\n", at);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(at, lineEnd).replace(/\r$/, "");
    if (/^[ \t]*#/.test(line)) found.push({ start: at, heading: line.trim() });
    if (newline === -1) break;
    at = newline + 1;
  }
  return found.map(({ start, heading }, index) => {
    const end = found[index + 1]?.start ?? source.length;
    const marks = /^#+/.exec(heading)?.[0] ?? "";
    return {
      heading,
      title: heading.slice(marks.length).trim(),
      level: marks.length,
      start,
      end,
      text: source.slice(start, end).trim(),
    };
  });
}

/**
 * The section under a heading, by its heading line ("## Work") or its bare title ("Work"). The first match
 * in file order is returned, whole. A heading the note does not have gives undefined.
 */
export function sectionOf(source: string, heading: string): NoteSection | undefined {
  const wanted = heading.trim();
  if (wanted === "") return undefined;
  const sections = noteSections(source);
  const exact = sections.find((section) => section.heading === wanted);
  if (exact !== undefined) return exact;
  const title = wanted.replace(/^#+/, "").trim().toLowerCase();
  if (title === "") return undefined;
  return sections.find((section) => section.title.toLowerCase() === title);
}
