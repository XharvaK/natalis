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
  const needle = fold(quote);
  if (needle === "") return undefined;
  const folded = foldWithOffsets(source);
  const at = folded.text.indexOf(needle);
  if (at < 0) return undefined;
  const start = folded.starts[at];
  const end = folded.ends[at + needle.length - 1];
  if (start === undefined || end === undefined) return undefined;
  return source.slice(start, end);
}

/**
 * The nearest markdown heading line above a quote in the record, or undefined when there is none. The line is shown
 * as the record spells it, with only the spaces around it removed.
 */
export function headingAbove(source: string, quote: string): string | undefined {
  const at = source.indexOf(quote);
  if (at < 0) return undefined;
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const lines = source.slice(0, lineStart).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("#")) return line;
  }
  return undefined;
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
