// The replay files: events.jsonl (what the world did, in order), reference.jsonl and transcript.jsonl (what the
// entity said). Plain JSON lines. Every line is checked; a bad line stops with its file and line number.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RiverSource } from "../contracts.js";

export const EVENTS_FILE = "events.jsonl";
export const REFERENCE_FILE = "reference.jsonl";
export const TRANSCRIPT_FILE = "transcript.jsonl";

/** One thing that happened in a world, as the entity received it. Field names follow WorldEvent. */
export type CapturedEvent = {
  world: string;
  place: string;
  thread: string;
  actor?: string;
  source: RiverSource;
  text?: string;
  data?: Record<string, unknown>;
  atMs: number;
};

/** One thing the entity said, with the place and the time it was said. */
export type SayLine = {
  atMs: number;
  place: string;
  text: string;
  thread?: string;
  replyTo?: string;
};

const SOURCES: readonly RiverSource[] = ["owner", "outside", "self", "body"];

/** Reads events.jsonl. Returns the events in time order (equal times keep file order). */
export function readEventFile(path: string): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  for (const { line, value } of readJsonLines(path)) {
    const block = objectAt(value, path, line);
    const world = textAt(block, "world", path, line);
    const place = textAt(block, "place", path, line);
    const thread = block["thread"] === undefined ? place : textAt(block, "thread", path, line);
    const source = block["source"];
    if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
      throw lineError(path, line, "source must be owner, outside, self or body");
    }
    const atMs = block["atMs"];
    if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) throw lineError(path, line, "atMs must be a whole number");
    const event: CapturedEvent = { world, place, thread, source: source as RiverSource, atMs };
    if (block["actor"] !== undefined) event.actor = textAt(block, "actor", path, line);
    if (block["text"] !== undefined) {
      if (typeof block["text"] !== "string") throw lineError(path, line, "text must be text");
      event.text = block["text"];
    }
    if (block["data"] !== undefined) {
      if (typeof block["data"] !== "object" || block["data"] === null || Array.isArray(block["data"])) {
        throw lineError(path, line, "data must be an object");
      }
      event.data = block["data"] as Record<string, unknown>;
    }
    events.push(event);
  }
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.atMs - b.event.atMs || a.index - b.index)
    .map((entry) => entry.event);
}

/**
 * Reads what the entity said. `path` is a run folder (its transcript.jsonl) or a .jsonl file. Wake rows and
 * other non-say rows are skipped.
 */
export function readSayFile(path: string): SayLine[] {
  const file = existsSync(join(path, TRANSCRIPT_FILE)) ? join(path, TRANSCRIPT_FILE) : path;
  if (!existsSync(file)) throw new Error(`No says to read: ${file} does not exist.`);
  const says: SayLine[] = [];
  for (const { line, value } of readJsonLines(file)) {
    const block = objectAt(value, file, line);
    if (block["wake"] !== undefined || block["wake_cancelled"] !== undefined) continue;
    const atMs = block["atMs"];
    if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) throw lineError(file, line, "atMs must be a whole number");
    const say: SayLine = {
      atMs,
      place: textAt(block, "place", file, line),
      text: textAt(block, "text", file, line),
    };
    if (block["thread"] !== undefined) say.thread = textAt(block, "thread", file, line);
    if (block["replyTo"] !== undefined) say.replyTo = textAt(block, "replyTo", file, line);
    says.push(say);
  }
  return says;
}

export function writeJsonLines(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

export type JsonLine = { line: number; value: unknown };

/** Parses a .jsonl file. Blank lines are skipped; line numbers are file lines. */
export function readJsonLines(path: string): JsonLine[] {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  const out: JsonLine[] = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      if (raw.trim() === "") return;
      try {
        out.push({ line: index + 1, value: JSON.parse(raw) as unknown });
      } catch {
        throw lineError(path, index + 1, "is not valid JSON");
      }
    });
  return out;
}

export function lineError(file: string, line: number, message: string): Error {
  return new Error(`${file} line ${line}: ${message}.`);
}

function objectAt(value: unknown, file: string, line: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw lineError(file, line, "must be one JSON object");
  }
  return value as Record<string, unknown>;
}

function textAt(block: Record<string, unknown>, key: string, file: string, line: number): string {
  const value = block[key];
  if (typeof value !== "string" || value.trim() === "") throw lineError(file, line, `${key} must be text`);
  return value;
}
