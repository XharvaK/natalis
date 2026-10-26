// The summoner's tool table: entity.json `tools` maps a tool name to allow, ask or deny. A tool not in the table, or
// no table at all, is allowed, so a Lar without one behaves exactly as before. The table is a gate, not a judgment:
// a denied or ask tool is still shown to the Lar, and calling it returns a plain receipt that says why nothing ran.
// "ask" has no grant path yet: the receipt tells the Lar to ask its summoner, who allows it by changing the table.

import type { Receipt } from "../contracts.js";

export const TOOL_POLICIES = ["allow", "ask", "deny"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export type ToolTable = Record<string, ToolPolicy>;

/** Validates the `tools` block. Throws a plain error naming the first wrong entry. */
export function parseToolPolicy(value: unknown): ToolTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tools must be an object of tool name to allow, ask or deny.");
  const table: ToolTable = {};
  for (const [name, policy] of Object.entries(value)) {
    if (name === "end_turn") throw new Error('tools.end_turn: "end_turn" belongs to the loop and cannot be in the table.');
    if (!(TOOL_POLICIES as readonly string[]).includes(String(policy))) {
      throw new Error(`tools.${name} must be one of ${TOOL_POLICIES.join(", ")}.`);
    }
    table[name] = policy as ToolPolicy;
  }
  return table;
}

export function policyFor(table: ToolTable | undefined, name: string): ToolPolicy {
  if (table === undefined || !Object.hasOwn(table, name)) return "allow";
  return table[name] as ToolPolicy;
}

/** The receipt for a tool the table does not allow, or undefined when it may run. */
export function policyRefusal(table: ToolTable | undefined, name: string): Receipt | undefined {
  const policy = policyFor(table, name);
  if (policy === "allow") return undefined;
  if (policy === "deny") {
    const summary = `Your summoner's tool table does not allow ${name}, so nothing was done.`;
    return { ok: false, summary, refused: { code: "denied_tool", reason: `${name} is set to deny in your summoner's tool table. Nothing ran.` } };
  }
  const summary = `${name} needs your summoner's yes first, so nothing was done. Ask your summoner in their place if you want it.`;
  return { ok: false, summary, refused: { code: "ask_summoner", reason: `${name} is set to ask in your summoner's tool table. Nothing ran.` } };
}
