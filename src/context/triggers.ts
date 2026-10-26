// Trigger words on notes: a note whose first line is "triggers: word, word" is loaded whole into the turn when a new
// row uses one of those words (whole word, any case). Loaded notes share one budget; a note that does not fit is not
// cut, it is named as not loaded so the Lar can read it herself. The words are her own, written in her own notes.

export const TRIGGER_PREFIX = "triggers:";
/** The most characters of triggered notes shown in one turn. */
export const TRIGGER_BUDGET_CHARS = 6000;
/** The most notes named as not loaded, so the section cannot grow without end. */
const MAX_LEFT_OUT = 10;

export type TriggerNote = { path: string; firstLine: string; text: string };

export function parseTriggers(firstLine: string): string[] {
  const line = firstLine.trim();
  if (!line.toLowerCase().startsWith(TRIGGER_PREFIX)) return [];
  return line
    .slice(TRIGGER_PREFIX.length)
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
}

function usesWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** The section text for the notes the words in `text` trigger, or "" when none do. */
export function triggeredText(notes: readonly TriggerNote[], text: string, budget = TRIGGER_BUDGET_CHARS): string {
  const hit = notes.filter((note) => parseTriggers(note.firstLine).some((word) => usesWord(text, word)));
  if (hit.length === 0) return "";
  const shown: string[] = [];
  const left: string[] = [];
  let used = 0;
  for (const note of hit) {
    const block = `### ${note.path}\n${note.text.trim()}`;
    if (used + block.length <= budget) {
      shown.push(block);
      used += block.length;
    } else left.push(note.path);
  }
  const parts = ["Notes of yours whose trigger words came up in the new messages:", ...shown];
  if (left.length > 0) parts.push(`Triggered but not loaded (no room; read them if you need them): ${left.slice(0, MAX_LEFT_OUT).join(", ")}.`);
  return parts.join("\n\n");
}
