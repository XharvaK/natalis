// Forgetting in the notebook: every current note line that holds all the query words is replaced by a marker.
// The body matches words only; it never judges what a line means. Files in trash/ are not searched, and the
// marker never matches again, so a second forget does not count it.

export const FORGOTTEN_LINE = "[forgotten by the owner]";

/** The words of a query, in the form lines are compared in. Empty when the query has no words. */
export function queryWords(query: string): string[] {
  return foldForm(query)
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** True when the line holds every word. With no words, nothing matches. */
export function lineHoldsWords(line: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const form = foldForm(line);
  return words.every((word) => form.includes(word));
}

/** Replaces each matching line with the marker. Returns the new text and how many lines were replaced. */
export function forgetLines(text: string, words: readonly string[]): { text: string; count: number } {
  let count = 0;
  const lines = text.split("\n").map((line) => {
    if (line === FORGOTTEN_LINE || line.trim() === "") return line;
    if (!lineHoldsWords(line, words)) return line;
    count += 1;
    return FORGOTTEN_LINE;
  });
  return { text: lines.join("\n"), count };
}

function foldForm(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}
