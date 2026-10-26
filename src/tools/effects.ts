// Which tools only read. Every tool not named here, and not declaring its own effect, is a write: a missing label
// fails closed (stubbed in a dry run, never retried).

import type { ToolEffect, ToolSpec } from "../contracts.js";

export const READ_TOOLS: ReadonlySet<string> = new Set([
  "read_note",
  "list_notes",
  "recall",
  "look",
  "read_history",
  "game_look",
  "game_snapshot",
]);

export function effectOf(spec: ToolSpec): ToolEffect {
  return spec.effect ?? (READ_TOOLS.has(spec.name) ? "read" : "write");
}
