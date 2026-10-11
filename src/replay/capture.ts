// Capture: reads an entity's river for one time window and writes the two replay files. events.jsonl holds what
// the worlds sent in (the inputs); reference.jsonl holds what the entity said back (the baseline). Forgotten rows
// are skipped. The window runs from `sinceMs` (inclusive) to `untilMs` (exclusive).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openRiver } from "../river/index.js";
import type { RiverRow } from "../contracts.js";
import { EVENTS_FILE, REFERENCE_FILE, writeJsonLines, type CapturedEvent, type SayLine } from "./files.js";
import { RIVER_FILE } from "../import/folder.js";

const PAGE = 500;

export type CaptureOptions = {
  /** The entity folder. Its river is read; nothing is written to it. */
  dir: string;
  sinceMs: number;
  untilMs: number;
  /** Where events.jsonl and reference.jsonl go. Created if missing. */
  outDir: string;
};

export type CaptureResult = { events: number; says: number; forgotten: number; eventsFile: string; referenceFile: string };

export function captureWindow(options: CaptureOptions): CaptureResult {
  if (!Number.isSafeInteger(options.sinceMs) || !Number.isSafeInteger(options.untilMs)) {
    throw new Error("The window needs whole-millisecond start and end times.");
  }
  if (options.untilMs <= options.sinceMs) throw new Error("--until must be later than --since.");
  const river = openRiver(join(options.dir, RIVER_FILE));
  let events: Array<{ seq: number; event: CapturedEvent }>;
  let says: Array<{ seq: number; say: SayLine }>;
  let forgotten = 0;
  try {
    events = [];
    says = [];
    for (const row of pages(river, "event")) {
      if (!inWindow(row, options)) continue;
      // An erased row keeps its time but not its words, so it cannot be replayed.
      if (row.forgotten) {
        forgotten += 1;
        continue;
      }
      events.push({ seq: row.seq, event: toEvent(row) });
    }
    for (const row of pages(river, "say")) {
      if (!inWindow(row, options)) continue;
      if (row.forgotten) {
        forgotten += 1;
        continue;
      }
      if (row.text === undefined) continue;
      says.push({ seq: row.seq, say: { atMs: row.atMs, place: row.place ?? row.thread, text: row.text, thread: row.thread } });
    }
  } finally {
    river.close();
  }

  mkdirSync(options.outDir, { recursive: true });
  const eventsFile = join(options.outDir, EVENTS_FILE);
  const referenceFile = join(options.outDir, REFERENCE_FILE);
  // Time order, with the river's own order breaking ties, so a replay feeds events the way they happened.
  const orderedEvents = events.sort((a, b) => a.event.atMs - b.event.atMs || a.seq - b.seq).map((entry) => entry.event);
  const orderedSays = says.sort((a, b) => a.say.atMs - b.say.atMs || a.seq - b.seq).map((entry) => entry.say);
  writeJsonLines(eventsFile, orderedEvents);
  writeJsonLines(referenceFile, orderedSays);
  return { events: orderedEvents.length, says: orderedSays.length, forgotten, eventsFile, referenceFile };
}

/** Every row of one kind, a page at a time, in seq order. */
function* pages(river: ReturnType<typeof openRiver>, kind: "event" | "say"): Generator<RiverRow & { forgotten: boolean }> {
  let cursor = 0;
  for (;;) {
    const rows = river.read({ kinds: [kind], sinceSeq: cursor, limit: PAGE });
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    cursor = rows[rows.length - 1]?.seq ?? cursor;
    if (rows.length < PAGE) return;
  }
}

function inWindow(row: RiverRow, options: CaptureOptions): boolean {
  return row.atMs >= options.sinceMs && row.atMs < options.untilMs;
}

/** The world is the part of the place before the first colon ("discord:dm:owner" is in "discord"). */
export function worldOf(place: string): string {
  const colon = place.indexOf(":");
  return colon > 0 ? place.slice(0, colon) : place;
}

function toEvent(row: RiverRow): CapturedEvent {
  const place = row.place ?? row.thread;
  const event: CapturedEvent = {
    world: worldOf(place),
    place,
    thread: row.thread,
    source: row.source,
    atMs: row.atMs,
  };
  if (row.actor !== undefined) event.actor = row.actor;
  if (row.text !== undefined) event.text = row.text;
  if (row.data !== undefined) event.data = row.data;
  return event;
}
