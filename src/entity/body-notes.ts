// N2 (option c): the "Body notes" block. Receipts only: what the host's own records say about a state it can check,
// each with the river seq that holds it. It never reads, quotes or judges her words; comparing is hers to do.

import type { RiverRow } from "../contracts.js";

/** The view key a Domus view row carries (domus-world GAME_VIEW). */
const DOMUS_VIEW = "domus";
/** The most lines the block holds. */
export const BODY_NOTES_MAX = 5;
const HEAD = "Body notes (receipts the host keeps; yours to compare):";

function isDomus(row: RiverRow): boolean {
  return row.thread.startsWith("domus:") && row.forgotten !== true;
}

function isView(row: RiverRow): boolean {
  return isDomus(row) && row.data?.["view"] === DOMUS_VIEW;
}

function isDetach(row: RiverRow): boolean {
  return isDomus(row) && row.data?.["attached"] === false;
}

/** The clock line of a view row, as the host rendered it; undefined when the view had none. */
function clockOf(row: RiverRow): string | undefined {
  const match = /(Game time: [^\n]*?\.|The game is (?:paused|running)\.)(?=\s|$)/.exec(row.text ?? "");
  return match?.[1];
}

/**
 * The Domus receipts, from rows read newest first: when the last session's views began and ended, the detach after
 * them, and the clock of the last view. Empty when no Domus view is in the rows.
 */
export function domusReceipts(newestFirst: readonly RiverRow[], format: (ms: number) => string): string[] {
  let lastView: RiverRow | undefined;
  let detachAfter: RiverRow | undefined;
  let firstView: RiverRow | undefined;
  for (const row of newestFirst) {
    if (lastView === undefined) {
      if (isDetach(row)) detachAfter = row;
      else if (isView(row)) {
        lastView = row;
        firstView = row;
      }
      continue;
    }
    if (isDetach(row)) break;
    if (isView(row)) firstView = row;
  }
  if (lastView === undefined || firstView === undefined) return [];
  const end = detachAfter === undefined
    ? "no detach after it."
    : `not attached since ${format(detachAfter.atMs)} (seq ${detachAfter.seq}).`;
  const lines = [
    `Domus: attached from ${format(firstView.atMs)} (seq ${firstView.seq}) to the last view at ${format(lastView.atMs)} (seq ${lastView.seq}); ${end}`,
  ];
  const clock = clockOf(lastView);
  if (clock !== undefined) lines.push(`Domus clock at the last view (seq ${lastView.seq}): ${clock}`);
  return lines;
}

/** The block under its heading, at most BODY_NOTES_MAX lines; empty when there is nothing to state. */
export function bodyNotesBlock(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return [HEAD, ...lines.slice(0, BODY_NOTES_MAX).map((line) => `- ${line}`)].join("\n");
}
