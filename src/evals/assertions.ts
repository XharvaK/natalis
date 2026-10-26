// Scenario eval assertions (borrowed idea, own code): deterministic checks on what one turn did. A trajectory is read
// from the river rows a turn wrote, so the same check works on a throwaway Lar, a replay copy or a stored run.

import type { RiverRow } from "../contracts.js";

export type Trajectory = { toolCalls: string[]; failed: string[]; says: string[]; sayPlaces?: string[] };

export type AssertionMode = "gate" | "soft";

export type Assertion = { mode?: AssertionMode } & (
  | { type: "calledTool"; tool: string }
  | { type: "notCalledTool"; tool: string }
  | { type: "toolOrder"; tools: string[] }
  | { type: "maxToolCalls"; max: number }
  | { type: "usedNoTools"; except?: string[] }
  | { type: "noFailedActions" }
  | { type: "replyIncludes"; text: string }
  | { type: "replyMatches"; pattern: string }
  | { type: "maxSaysPerPlace"; max: number }
);

export const ASSERTION_TYPES = [
  "calledTool",
  "notCalledTool",
  "toolOrder",
  "maxToolCalls",
  "usedNoTools",
  "noFailedActions",
  "replyIncludes",
  "replyMatches",
  "maxSaysPerPlace",
] as const;

export type Check = { type: string; mode: AssertionMode; ok: boolean; detail: string };

/** The tool calls, failed receipts and own says in a run of river rows, in order. */
export function trajectoryOf(rows: readonly RiverRow[]): Trajectory {
  const t: Required<Trajectory> = { toolCalls: [], failed: [], says: [], sayPlaces: [] };
  for (const row of rows) {
    if (row.kind === "tool_call" && row.source === "self") t.toolCalls.push(row.text ?? "");
    else if (row.kind === "receipt" && row.data?.["ok"] === false && typeof row.data["tool"] === "string") t.failed.push(row.data["tool"]);
    else if (row.kind === "say" && row.source === "self") {
      t.says.push(row.text ?? "");
      t.sayPlaces.push(row.thread);
    }
  }
  return t;
}

function inOrder(calls: readonly string[], tools: readonly string[]): boolean {
  let i = 0;
  for (const name of calls) if (name === tools[i]) i += 1;
  return i === tools.length;
}

/** One assertion against one trajectory. Pure. */
export function checkAssertion(t: Trajectory, a: Assertion): Check {
  const mode = a.mode ?? "gate";
  const done = (ok: boolean, detail: string): Check => ({ type: a.type, mode, ok, detail });
  const reply = t.says.join("\n");
  switch (a.type) {
    case "calledTool":
      return done(t.toolCalls.includes(a.tool), `called: ${t.toolCalls.join(", ") || "none"}`);
    case "notCalledTool":
      return done(!t.toolCalls.includes(a.tool), `called: ${t.toolCalls.join(", ") || "none"}`);
    case "toolOrder":
      return done(inOrder(t.toolCalls, a.tools), `called: ${t.toolCalls.join(", ") || "none"}`);
    case "maxToolCalls":
      return done(t.toolCalls.length <= a.max, `${t.toolCalls.length} tool calls`);
    case "usedNoTools": {
      const extra = t.toolCalls.filter((name) => !(a.except ?? []).includes(name));
      return done(extra.length === 0, `other tools: ${extra.join(", ") || "none"}`);
    }
    case "noFailedActions":
      return done(t.failed.length === 0, `failed: ${t.failed.join(", ") || "none"}`);
    case "replyIncludes":
      return done(reply.toLowerCase().includes(a.text.toLowerCase()), `${t.says.length} says`);
    case "replyMatches":
      return done(new RegExp(a.pattern, "m").test(reply), `${t.says.length} says`);
    case "maxSaysPerPlace": {
      const counts = new Map<string, number>();
      for (const place of t.sayPlaces ?? []) counts.set(place, (counts.get(place) ?? 0) + 1);
      const most = Math.max(0, ...counts.values());
      return done(most <= a.max, `most says in one place: ${most}`);
    }
  }
}
