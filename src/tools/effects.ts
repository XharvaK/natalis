// Which tools only read. Every tool not named here is a write unless it declares idempotent: a missing label fails
// closed (stubbed in a dry run, never retried), and a tool cannot declare itself a read (NIT-2).

import type { ToolEffect, ToolSpec } from "../contracts.js";

export const READ_TOOLS: ReadonlySet<string> = new Set([
  "read_note",
  "list_notes",
  "recall",
  "look",
  "read_history",
]);

export function effectOf(spec: ToolSpec): ToolEffect {
  if (READ_TOOLS.has(spec.name)) return spec.effect === undefined || spec.effect === "read" ? "read" : spec.effect;
  return spec.effect === "idempotent" ? "idempotent" : "write";
}
