// The summoner's tool table: entity.json `tools` maps a tool name to allow, ask or deny. A tool not in the table, or
// no table at all, is allowed, so a Lar without one behaves exactly as before. The table is a gate, not a judgment:
// a denied or ask tool is still shown to the Lar, and calling it returns a plain receipt that says why nothing ran.
//
// An ask tool consults grants.db at call start (runtime, entity/grants.ts). A standing refusal wins, then a standing
// grant for the tool and scope, then an unused once grant whose arguments HMAC matches. Otherwise the body posts one
// request in the summoner's place, built only from code and the call's arguments: never from the model's words.

import type { Receipt } from "../contracts.js";
import { ANYWHERE } from "./grants.js";
import { SUMMONER_PREFIX } from "./summoner.js";

export const TOOL_POLICIES = ["allow", "ask", "deny"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export type ToolTable = Record<string, ToolPolicy>;

type Args = Record<string, unknown>;

/** How one ask-able tool names its site or place and describes the call in one code-made line. */
export type AskToolRules = {
  /** The site or place this call covers. Undefined facts fall back to "anywhere" (fail safe). */
  scope(args: Args): string;
  /** One line about the call, made from facts in the arguments; never the model's free text. */
  summary(args: Args): string;
};

/**
 * The ask declarations, beside the tool table because they belong to the same gate. A tool not named here has no
 * scope extractor: its requests say "anywhere" and its summary says only that the arguments are as given.
 */
export const ASK_TOOL_RULES: Readonly<Record<string, AskToolRules>> = {
  web_request: {
    scope: (args) => hostOf(args["url"]) ?? ANYWHERE,
    summary: (args) => {
      const method = textOf(args["method"])?.toUpperCase() ?? "GET";
      const url = urlOf(args["url"]);
      if (url === undefined) return `${method} a web request`;
      const path = url.pathname === "/" ? "" : url.pathname;
      return oneLine(`${method} ${url.hostname}${path}`, SUMMARY_MAX);
    },
  },
  say: {
    scope: (args) => placeOf(args["place"]),
    summary: (args) => `speak in ${placeOf(args["place"])}`,
  },
  react: {
    scope: (args) => placeOf(args["place"]),
    summary: (args) => {
      const ref = textOf(args["message_ref"]);
      return ref === undefined ? `react in ${placeOf(args["place"])}` : `react to ${ref} in ${placeOf(args["place"])}`;
    },
  },
  read_history: {
    scope: (args) => placeOf(args["place"]),
    summary: (args) => `read the recent messages in ${placeOf(args["place"])}`,
  },
};

/** The code-made summary for one ask. A tool with no declaration says only that the arguments are as given. */
export function summaryFor(tool: string, args: Args): string {
  const rules = ASK_TOOL_RULES[tool];
  return rules === undefined ? "one call with the arguments as given" : rules.summary(args);
}

/** The scope a call's ask covers. No extractor, or no fact to extract, means "anywhere". */
export function scopeFor(tool: string, args: Args): string {
  const rules = ASK_TOOL_RULES[tool];
  if (rules === undefined) return ANYWHERE;
  const scope = oneLine(rules.scope(args), SUMMARY_MAX);
  return scope === "" ? ANYWHERE : scope;
}

/**
 * The request the body posts in the summoner's own place. The four answer lines are exactly paper §5.1 item 1:
 * once, always, never and no. A tool with no extractor says "anywhere" in the always and never lines.
 */
export function permissionRequestText(input: { name: string; tool: string; scope: string; summary: string }): string {
  const scope = input.scope === ANYWHERE ? undefined : input.scope;
  const where = scope === undefined ? "" : ` on ${scope}`;
  const always = scope === undefined ? `${input.tool} anywhere` : `${input.tool} on ${scope}`;
  const never = scope === undefined ? `no ${input.tool} anywhere` : `no ${input.tool} on ${scope}`;
  const summary = oneLine(input.summary, SUMMARY_MAX).replace(/[.!?]+$/, "");
  return (
    `${SUMMONER_PREFIX}${input.name} asks to use ${input.tool}${where}: ${summary}. ` +
    `Answer in your own words. Once: this one call. ` +
    `Always: ${always} until you take it back. ` +
    `Never: ${never} until you take it back. No: not this time.`
  );
}

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

const SUMMARY_MAX = 160;

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function placeOf(value: unknown): string {
  const place = textOf(value);
  if (place === undefined || /\s/.test(place)) return ANYWHERE;
  return place;
}

/** A host name from a call's url argument, lower case and without its trailing dot. */
function hostOf(value: unknown): string | undefined {
  return urlOf(value)?.hostname;
}

function urlOf(value: unknown): URL | undefined {
  const text = textOf(value);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "") return undefined;
  url.hostname = url.hostname.replace(/\.+$/, "").toLowerCase();
  return url;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max) : line;
}
