// The honesty check: one short model call, with no tools, that asks whether a message makes a claim about the
// speaker's own life that their record contradicts. The body reads only the reply's shape. It never decides what
// the claim means; the model does, and the body holds the words only when the model says they contradict the record.
// The model must copy exact pieces: a quote the body cannot find in its source is an error, never a guess.

export const HONESTY_SYSTEM =
  "You check one message against one speaker's record of their own life. Decide only this: does the message make a " +
  "claim about the speaker's OWN life (where they live, their work, their accounts, things they did) that the record " +
  "contradicts? Claims about other people, the world, opinions, plans and feelings are not contradictions, and a " +
  "claim the record does not mention is not a contradiction. Reply with JSON only, with no other text: " +
  '{"contradicts": true or false, "claim_quote": "an exact piece copied from the message", "record_quote": "an exact piece copied from the record"}. ' +
  "Copy each piece word for word, with no paraphrase and no added words. " +
  "When nothing is contradicted, use false, and empty strings for claim_quote and record_quote.";

export type HonestyVerdict =
  | { contradicts: false }
  | { contradicts: true; claim_quote: string; record_quote: string }
  | { error: string };

/** The most code points a quote may take in a receipt, so one huge quote cannot bury the rest of the message. */
export const QUOTE_MAX_CHARS = 1000;
const QUOTE_TRUNCATED_MARKER = " […truncated]";

/**
 * A quote as a receipt shows it: whole when it fits, and its first QUOTE_MAX_CHARS code points followed by the marker
 * when it does not. Code points are counted, so an emoji counts as one and never as two. The substring check runs
 * on the full quote before this cap.
 */
export function capQuote(quote: string): string {
  const points = [...quote];
  if (points.length <= QUOTE_MAX_CHARS) return quote;
  return points.slice(0, QUOTE_MAX_CHARS).join("") + QUOTE_TRUNCATED_MARKER;
}

/** Reads the model's reply. Anything that is not the agreed shape is an error, never a guess. */
export function parseHonestyReply(content: string | null): HonestyVerdict {
  if (content === null || content.trim() === "") return { error: "the reply was empty" };
  // Models often wrap JSON in a code fence; the fence is not the problem, so it is taken off first.
  const body = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "the reply was not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "the reply was not an object" };
  }
  const root = parsed as Record<string, unknown>;
  const flag = root["contradicts"];
  if (typeof flag !== "boolean") return { error: "the reply had no contradicts flag" };
  if (!flag) return { contradicts: false };
  const claim = root["claim_quote"];
  const record = root["record_quote"];
  if (typeof claim !== "string" || claim.trim() === "" || typeof record !== "string" || record.trim() === "") {
    return { error: "the reply left out the claim quote or the record quote" };
  }
  return { contradicts: true, claim_quote: claim, record_quote: record };
}

/**
 * Accepts the model's quotes only when each one is a real substring of its own source, after folding every run of
 * whitespace to one space on both sides. Case, punctuation and quote style must match. The verdict carries each
 * quote exactly as its source spells it, so a receipt can show the original text and never the model's retyping.
 */
export function checkHonestyQuotes(
  claimQuote: string,
  recordQuote: string,
  message: string,
  record: string,
): HonestyVerdict {
  const claim = quoteInSource(message, claimQuote);
  if (claim === undefined) return { error: "the claim quote was not found in the message" };
  const held = quoteInSource(record, recordQuote);
  if (held === undefined) return { error: "the record quote was not found in the life record" };
  return { contradicts: true, claim_quote: claim, record_quote: held };
}

/** The quote exactly as the source spells it, or undefined when folding whitespace does not find it. */
export function quoteInSource(source: string, quote: string): string | undefined {
  return quoteMatches(source, quote)[0]?.text;
}

export type QuoteMatch = {
  /** Where the match starts in the source. */
  start: number;
  /** Where the match ends in the source, after its last character. */
  end: number;
  /** The match exactly as the source spells it. */
  text: string;
};

/**
 * Every place the folded quote appears in the source, in file order. Offsets point into the source, so a caller can
 * look around a match without searching for the quote again.
 */
export function quoteMatches(source: string, quote: string): QuoteMatch[] {
  const needle = fold(quote);
  if (needle === "") return [];
  const folded = foldWithOffsets(source);
  const matches: QuoteMatch[] = [];
  let at = folded.text.indexOf(needle);
  while (at >= 0) {
    const start = folded.starts[at];
    const end = folded.ends[at + needle.length - 1];
    if (start !== undefined && end !== undefined) matches.push({ start, end, text: source.slice(start, end) });
    at = folded.text.indexOf(needle, at + 1);
  }
  return matches;
}

/** The nearest markdown heading line above a source offset, or undefined when there is none. */
export function headingAt(source: string, offset: number): string | undefined {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lines = source.slice(0, lineStart).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("#")) return line;
  }
  return undefined;
}

/**
 * The nearest markdown heading line above the first place a quote appears in the record, or undefined when there is
 * none. The line is shown as the record spells it, with only the spaces around it removed.
 */
export function headingAbove(source: string, quote: string): string | undefined {
  const first = quoteMatches(source, quote)[0];
  return first === undefined ? undefined : headingAt(source, first.start);
}

/**
 * The words a receipt uses for where a record quote sits: the heading above it, every heading when the same words
 * appear under more than one, or none. Headings are named once each, in the order they appear in the file.
 */
export function headingPhrase(source: string, quote: string): string {
  const headings = quoteMatches(source, quote).map((match) => headingAt(source, match.start));
  const named = headings.filter((heading): heading is string => heading !== undefined);
  const distinct = [...new Set(named)];
  const place =
    distinct.length === 0
      ? "with no heading above it in your record"
      : distinct.length === 1
        ? `under the heading "${distinct[0]!}"`
        : `under the headings ${quotedList(distinct)}`;
  const moreThanOnePlace = headings.length > 1 && (distinct.length > 1 || named.length < headings.length);
  return moreThanOnePlace && distinct.length > 0 ? `${place} (the same words appear in more than one place)` : place;
}

function quotedList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  const last = quoted.pop() ?? "";
  return quoted.length === 0 ? last : `${quoted.join(", ")} and ${last}`;
}

function fold(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Folded = { text: string; starts: number[]; ends: number[] };

/** Folds whitespace the same way as `fold`, and keeps where each folded character began and ended in the source. */
function foldWithOffsets(source: string): Folded {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source.charAt(i))) {
      let end = i + 1;
      while (end < source.length && /\s/.test(source.charAt(end))) end += 1;
      starts.push(i);
      ends.push(end);
      text += " ";
      i = end;
    } else {
      starts.push(i);
      ends.push(i + 1);
      text += source.charAt(i);
      i += 1;
    }
  }
  return { text, starts, ends };
}
