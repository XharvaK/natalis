// Which tools only read, and which may be repeated safely. Both lists are keyed by the world that offers a tool and
// its name: a world tool named "look" is not the body's look (NIT-B). Every tool not named here is a write unless it
// declares idempotent and is on the idempotent list: a missing or off-list label fails closed (stubbed in a dry run,
// never retried), and a tool cannot declare itself a read or idempotent (NIT-2, NIT-B).

import type { Tool, ToolEffect, ToolSpec } from "../contracts.js";

/** The world key for the body's own tools: the notebook and the tools the runtime builds itself. */
export const BODY_WORLD = "body";

export const READ_TOOLS: ReadonlySet<string> = new Set([
  `${BODY_WORLD}/read_note`,
  `${BODY_WORLD}/list_notes`,
  `${BODY_WORLD}/recall`,
  `${BODY_WORLD}/look`,
  `${BODY_WORLD}/permissions`,
  "discord/read_history",
]);

/** Only these tools may be idempotent, even when another spec declares it. */
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  "domus/game_look",
  "domus/game_snapshot",
]);

/** The effect table's key: the world that offers the tool, then its name. */
export function effectKey(spec: Pick<ToolSpec, "world" | "name">): string {
  return `${spec.world ?? BODY_WORLD}/${spec.name}`;
}

/** Copy tools with the world that offers them, which the effect table reads. The field is body-only. */
export function withWorld(world: string, tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => ({ ...tool, spec: { ...tool.spec, world } }));
}

export function effectOf(spec: ToolSpec): ToolEffect {
  const key = effectKey(spec);
  const declared = spec.effect ?? (READ_TOOLS.has(key) ? "read" : "write");
  if (declared === "idempotent") return IDEMPOTENT_TOOLS.has(key) ? "idempotent" : "write";
  if (declared === "read") return READ_TOOLS.has(key) ? "read" : "write";
  return "write";
}
