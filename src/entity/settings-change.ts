// What changed in entity.json between two starts, as one note for the Lar. A record, not a rule: nothing here decides
// anything for her. The view leaves out addresses and keys, since those are not hers to read.

import type { EntityConfig } from "./config.js";

/** Keys left out of the view at any depth: addresses, key names and headers are not hers to read. */
export const HIDDEN_SETTING_KEYS: ReadonlySet<string> = new Set(["baseUrl", "apiKeyEnv", "headers"]);

/**
 * Keys of entity.json the view shows. Every key config.ts accepts is in this set or in HIDDEN_SETTING_KEYS, and a test
 * fails on one in neither, so a new field is classified before it can reach her river note.
 */
export const VISIBLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "alias", "api", "cacheMarks", "ceiling", "contextTokens", "effort", "effortMap", "effortParam", "fallback", "holds",
  "honesty", "idleTimeoutMs", "impersonation", "incremental", "inputPerMillion", "lifeViewChars", "lifeWarnChars",
  "limits", "maxModelCalls", "maxToolCalls", "model", "name", "nativeTools", "outputPerMillion", "owner", "price",
  "reflectBudget", "rhythm", "stream", "summoner", "timeZone", "timeoutMs", "tools", "turnsPerDay", "vision",
  "wholeResultsChars", "worldModels",
]);

/** The most changes one note lists. */
export const SETTINGS_NOTE_MAX = 20;

/** The most code points of one value in a change line. */
export const SETTING_VALUE_MAX = 80;

/** The one line settingsChanges gives when the earlier view cannot be read. */
const UNREADABLE = "The record of your earlier settings could not be read, so what changed is not known.";

/** The settings as one canonical JSON text: hidden keys gone at every depth, keys sorted, undefined dropped. */
export function settingsView(config: EntityConfig): string {
  return JSON.stringify(canonical(config));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (HIDDEN_SETTING_KEYS.has(key)) continue;
    const inner = (value as Record<string, unknown>)[key];
    if (inner === undefined) continue;
    out[key] = canonical(inner);
  }
  return out;
}

/** The changes between two views, one line each, in path order; equal texts give none. */
export function settingsChanges(before: string, after: string): string[] {
  let beforeValue: unknown;
  try {
    beforeValue = JSON.parse(before);
  } catch {
    return [UNREADABLE];
  }
  const earlier = leavesOf(beforeValue);
  const later = leavesOf(JSON.parse(after) as unknown);
  const changes: string[] = [];
  for (const path of [...new Set([...earlier.keys(), ...later.keys()])].sort()) {
    const was = earlier.get(path);
    const now = later.get(path);
    if (was === now) continue;
    if (was !== undefined && now !== undefined) changes.push(`${path}: ${cutValue(was)} → ${cutValue(now)}`);
    else if (now !== undefined) changes.push(`${path}: (not set) → ${cutValue(now)}`);
    else if (was !== undefined) changes.push(`${path}: ${cutValue(was)} → (not set)`);
  }
  return changes;
}

/** Every leaf of a parsed JSON text, by its dotted path: objects recurse, everything else is one leaf. */
function leavesOf(value: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      leavesOf(inner, path === "" ? key : `${path}.${key}`, out);
    }
    return out;
  }
  if (path !== "") out.set(path, JSON.stringify(value) ?? "null");
  return out;
}

/** A value as one change line shows it: at most SETTING_VALUE_MAX code points, cut with an ellipsis. */
function cutValue(value: string): string {
  const points = Array.from(value);
  return points.length > SETTING_VALUE_MAX ? `${points.slice(0, SETTING_VALUE_MAX).join("")}…` : value;
}

/**
 * A fact about tools she already has, added once: only to the note where limits.reflectBudget goes from not set to a
 * value, which is when reflection turns become possible. Not a rule or a quota.
 */
export const MEMORY_TOOLS_LINE =
  "Besides your notebook, you have these memory tools: mark (flag rows that matter; enough marked weight brings a quiet turn to reflect, where record_observation is offered), record_fact and close_fact (store a dated fact that cites river rows, and close it later), and link_notes (record how two notes relate).";

const REFLECT_TURNED_ON = "limits.reflectBudget: (not set) → ";

/** The note for the river: a heading, then one line per change, and a count of the rest past SETTINGS_NOTE_MAX. */
export function settingsNoteText(changes: readonly string[]): string {
  const listed = changes.slice(0, SETTINGS_NOTE_MAX);
  const more = changes.length - listed.length;
  const lines = listed.map((change) => `\n- ${change}`).join("");
  const tools = changes.some((change) => change.startsWith(REFLECT_TURNED_ON)) ? `\n${MEMORY_TOOLS_LINE}` : "";
  return `The settings you run under changed since your last start:${lines}${more > 0 ? `\n- and ${more} more.` : ""}${tools}`;
}
