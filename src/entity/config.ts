// An entity's config: one plain file, entity.json, in the entity's folder. It names the model and the owner and
// sets the loop ceiling. The key is never in this file: the model block names an environment variable.
// Validation answers with plain errors that say which field is wrong.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ceiling } from "../contracts.js";
import type { EffortMap, FallbackModelConfig, ModelConfig, ModelPrice } from "../model/from-config.js";
import { parseClock } from "./wake-schedule.js";
import { parseToolPolicy, type ToolTable } from "./tool-policy.js";

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_CEILING: Ceiling = { maxModelCalls: 24, maxToolCalls: 48 };
/** No preset rhythm: a Lar keeps whatever wakes it sets itself. A summoner may give times in entity.json rhythm. */
/** The life.md size (characters) past which the body warns. A warning only: nothing is cut. */
export const DEFAULT_LIFE_WARN_CHARS = 40_000;
/** Over the life warning size, the most characters of life.md shown in one turn. */
export const DEFAULT_LIFE_VIEW_CHARS = 20_000;
export const DEFAULT_RHYTHM: readonly string[] = [];

export type EntityConfig = {
  /** The name the summoner gave. Left out, the Lar chooses its own name. */
  name?: string;
  /** IANA zone name. Defaults to the host's zone. */
  timeZone?: string;
  model: ModelConfig;
  effort?: Effort;
  /** Defaults to DEFAULT_CEILING when left out. */
  ceiling?: Ceiling;
  /** The summoner: the alias they appear under. Written as "summoner" in entity.json ("owner" is still read). */
  owner: { alias: string };
  /** Body checks on what the Lar says. Each one is off unless the block says true. */
  holds?: { honesty?: boolean; impersonation?: boolean };
  /** The summoner's tool table: tool name to allow, ask or deny. Left out, or a tool not named, is allowed. */
  tools?: ToolTable;
  /**
   * Daily limits. Left out, there is none. lifeWarnChars: when self/life.md passes this many characters (code points),
   * the body writes a river note and a startup log line; the note is never trimmed. Default DEFAULT_LIFE_WARN_CHARS.
   * lifeViewChars: at or over lifeWarnChars, the most characters of life.md a turn shows (the first part plus whole
   * sections); the other headings are named. Default DEFAULT_LIFE_VIEW_CHARS.
   * reflectBudget: the sum of her importance-mark weights that brings one quiet reflection turn; left out, none.
   */
  limits?: { turnsPerDay?: number; lifeWarnChars?: number; lifeViewChars?: number; reflectBudget?: number };
  /** Local clock times ("HH:MM") the Lar gets a daily wake at, once, on its first start. Left out or [], none. */
  rhythm?: string[];
  /**
   * A model of its own for the turns of one world (keyed by world id, e.g. "domus"): same service and key as the main
   * model. Its backup is the main model at the entity's effort. Left out, every world uses the main model.
   */
  worldModels?: Record<string, WorldModelConfig>;
};

export type WorldModelConfig = {
  model: string;
  /** Effort for this world's turns. Left out, the entity's effort. */
  effort?: Effort;
  /** True when this model can see pictures. Never assumed. */
  vision?: boolean;
  /** The protocol, "chat" or "responses". Left out, the main model's. */
  api?: "chat" | "responses";
  /** This model's wire values for the efforts. Left out, none. */
  effortMap?: EffortMap;
  /** This world model's own backup chain. Left out, the main model is its backup. */
  fallback?: FallbackModelConfig;
};

export const ENTITY_FILE = "entity.json";
/** The blank `natalis new` leaves where only the summoner can answer (which model, which address). A Lar never starts with one. */
export const FILL_ME = "FILL-ME";

/** Reads and validates `<dir>/entity.json`. */
export function loadEntityConfig(dir: string): EntityConfig {
  const file = join(dir, ENTITY_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No ${ENTITY_FILE} found in ${dir}. Make one with a model block and a summoner alias.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ENTITY_FILE} is not valid JSON: ${messageOf(err)}`);
  }
  const blank = blankIn(parsed, "");
  if (blank !== undefined) {
    throw new Error(`${ENTITY_FILE} still has a blank to fill: ${blank} is ${FILL_ME}. Fill it in (DESIGN.md beside it says how), then start again.`);
  }
  return parseEntityConfig(parsed);
}

/** The path of the first value that still holds the FILL-ME blank, or undefined when none does. */
function blankIn(value: unknown, path: string): string | undefined {
  if (typeof value === "string") return value.includes(FILL_ME) ? path : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, inner] of Object.entries(value)) {
    const found = blankIn(inner, Array.isArray(value) ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Validates an already-parsed entity config. Throws a plain error naming the first wrong field. */
export function parseEntityConfig(value: unknown): EntityConfig {
  const root = objectOf(value, ENTITY_FILE);
  onlyKeys(
    root,
    ["name", "timeZone", "model", "effort", "ceiling", "summoner", "owner", "holds", "tools", "limits", "rhythm", "worldModels"],
    ENTITY_FILE,
  );
  if (root["summoner"] !== undefined && root["owner"] !== undefined) {
    throw new Error("Give either summoner or owner in entity.json, not both. summoner is the current name.");
  }

  const config: EntityConfig = {
    model: parseModel(root["model"]),
    owner: parseOwner(root["summoner"] ?? root["owner"]),
    ceiling: parseCeiling(root["ceiling"]),
    rhythm: parseRhythm(root["rhythm"]),
  };
  if (root["name"] !== undefined) config.name = textOf(root["name"], "name");
  if (root["timeZone"] !== undefined) {
    const zone = textOf(root["timeZone"], "timeZone");
    checkZone(zone);
    config.timeZone = zone;
  }
  if (root["effort"] !== undefined) {
    if (!isEffort(root["effort"])) {
      throw new Error(`effort must be one of ${EFFORTS.join(", ")}.`);
    }
    config.effort = root["effort"];
  }
  if (root["holds"] !== undefined) config.holds = parseHolds(root["holds"]);
  if (root["tools"] !== undefined) config.tools = parseToolPolicy(root["tools"]);
  if (root["limits"] !== undefined) config.limits = parseLimits(root["limits"]);
  if (root["worldModels"] !== undefined) config.worldModels = parseWorldModels(root["worldModels"]);
  return config;
}

function parseWorldModels(value: unknown): Record<string, WorldModelConfig> {
  const block = objectOf(value, "worldModels");
  const models: Record<string, WorldModelConfig> = {};
  for (const [world, entry] of Object.entries(block)) {
    const where = `worldModels.${world}`;
    if (!/^[a-z][a-z0-9-]*$/.test(world)) throw new Error(`${where}: a world id is lower-case letters, digits and dashes.`);
    const item = objectOf(entry, where);
    onlyKeys(item, ["model", "effort", "vision", "api", "effortMap", "fallback"], where);
    const model: WorldModelConfig = { model: textOf(item["model"], `${where}.model`) };
    if (item["effort"] !== undefined) {
      if (!isEffort(item["effort"])) throw new Error(`${where}.effort must be one of ${EFFORTS.join(", ")}.`);
      model.effort = item["effort"];
    }
    if (item["vision"] !== undefined) model.vision = flagOf(item["vision"], `${where}.vision`);
    if (item["api"] !== undefined) model.api = apiOf(item["api"], `${where}.api`);
    if (item["effortMap"] !== undefined) model.effortMap = effortMapOf(item["effortMap"], `${where}.effortMap`);
    if (item["fallback"] !== undefined) model.fallback = parseFallback(item["fallback"], `${where}.fallback`);
    models[world] = model;
  }
  return models;
}

/** The rhythm: a list of local clock times, each "HH:MM". Left out, the default times. A time may appear once. */
function parseRhythm(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_RHYTHM];
  if (!Array.isArray(value)) throw new Error('rhythm must be a list of clock times such as ["09:00", "20:00"], or [].');
  const times: string[] = [];
  for (const item of value) {
    const clock = typeof item === "string" ? parseClock(item) : undefined;
    if (clock === undefined) {
      throw new Error(`rhythm holds ${JSON.stringify(item)}, which is not a clock time "HH:MM" (24 hours, two digits).`);
    }
    if (times.includes(clock)) throw new Error(`rhythm lists ${clock} more than once.`);
    times.push(clock);
  }
  return times;
}

function parseLimits(value: unknown): { turnsPerDay?: number; lifeWarnChars?: number; lifeViewChars?: number; reflectBudget?: number } {
  const block = objectOf(value, "limits");
  onlyKeys(block, ["turnsPerDay", "lifeWarnChars", "lifeViewChars", "reflectBudget"], "limits");
  const limits: { turnsPerDay?: number; lifeWarnChars?: number; lifeViewChars?: number; reflectBudget?: number } = {};
  if (block["lifeWarnChars"] !== undefined) limits.lifeWarnChars = positiveInt(block["lifeWarnChars"], "limits.lifeWarnChars");
  if (block["lifeViewChars"] !== undefined) limits.lifeViewChars = positiveInt(block["lifeViewChars"], "limits.lifeViewChars");
  if (block["turnsPerDay"] !== undefined) limits.turnsPerDay = positiveInt(block["turnsPerDay"], "limits.turnsPerDay");
  if (block["reflectBudget"] !== undefined) limits.reflectBudget = positiveInt(block["reflectBudget"], "limits.reflectBudget");
  return limits;
}

function parseHolds(value: unknown): { honesty?: boolean; impersonation?: boolean } {
  const block = objectOf(value, "holds");
  onlyKeys(block, ["honesty", "impersonation"], "holds");
  const holds: { honesty?: boolean; impersonation?: boolean } = {};
  for (const key of ["honesty", "impersonation"] as const) {
    if (block[key] === undefined) continue;
    if (typeof block[key] !== "boolean") throw new Error(`holds.${key} must be true or false.`);
    holds[key] = block[key];
  }
  return holds;
}

/** Validates a model block (the `model` part of entity.json). Also used for the judge's config file. */
export function parseModel(value: unknown): ModelConfig {
  const block = objectOf(value, "model");
  onlyKeys(
    block,
    ["baseUrl", "model", "apiKeyEnv", "contextTokens", "nativeTools", "effortParam", "timeoutMs", "vision", "cacheMarks", "fallback", "price",
      "api", "headers", "effortMap", "incremental", "stream", "idleTimeoutMs"],
    "model",
  );

  const baseUrl = baseUrlOf(block["baseUrl"], "model.baseUrl");

  const model: ModelConfig = {
    baseUrl,
    model: textOf(block["model"], "model.model"),
    contextTokens: positiveInt(block["contextTokens"], "model.contextTokens"),
  };
  if (block["apiKeyEnv"] !== undefined) model.apiKeyEnv = keyEnvOf(block["apiKeyEnv"], "model.apiKeyEnv");
  if (block["nativeTools"] !== undefined) model.nativeTools = flagOf(block["nativeTools"], "model.nativeTools");
  if (block["effortParam"] !== undefined) model.effortParam = effortParamOf(block["effortParam"], "model.effortParam");
  if (block["timeoutMs"] !== undefined) model.timeoutMs = positiveInt(block["timeoutMs"], "model.timeoutMs");
  if (block["vision"] !== undefined) model.vision = flagOf(block["vision"], "model.vision");
  if (block["cacheMarks"] !== undefined) model.cacheMarks = flagOf(block["cacheMarks"], "model.cacheMarks");
  if (block["fallback"] !== undefined) model.fallback = parseFallback(block["fallback"], "model.fallback");
  if (block["price"] !== undefined) model.price = priceOf(block["price"], "model.price");
  if (block["api"] !== undefined) model.api = apiOf(block["api"], "model.api");
  if (block["headers"] !== undefined) model.headers = headersOf(block["headers"], "model.headers");
  if (block["effortMap"] !== undefined) model.effortMap = effortMapOf(block["effortMap"], "model.effortMap");
  const incremental = incrementalOf(block, "model");
  if (incremental !== undefined) model.incremental = incremental;
  if (block["idleTimeoutMs"] !== undefined) model.idleTimeoutMs = positiveInt(block["idleTimeoutMs"], "model.idleTimeoutMs");
  if (model.api === "responses" && model.cacheMarks === true) {
    throw new Error("model.cacheMarks is for the chat protocol only; leave it out when model.api is \"responses\".");
  }
  if (model.api === "responses" && model.incremental === true) {
    throw new Error("model.incremental is for the chat protocol only; leave it out when model.api is \"responses\".");
  }
  // The main model sets idleTimeoutMs only with incremental replies. A backup without them inherits it as a first guess only:
  // the first try is cut at idleTimeoutMs, and after one cut the next try gets the full timeoutMs (openai-compatible S-C),
  // since without incremental replies a silence cannot be told from a long answer.
  if (model.idleTimeoutMs !== undefined && model.incremental !== true) {
    throw new Error("model.idleTimeoutMs only works with model.incremental true: without incremental replies, a silence cannot be told from a long answer.");
  }
  return model;
}

/**
 * A backup model block. Left to itself it uses the service, key and timeout of the model above it, so only its own
 * settings are given. It may name its own service (baseUrl, then its own apiKeyEnv and headers) and a backup of its own.
 */
function parseFallback(value: unknown, where: string): FallbackModelConfig {
  const block = objectOf(value, where);
  onlyKeys(
    block,
    ["model", "effortParam", "vision", "cacheMarks", "effort", "contextTokens", "price", "api", "effortMap",
      "baseUrl", "apiKeyEnv", "headers", "incremental", "stream", "fallback"],
    where,
  );
  const fallback: FallbackModelConfig = { model: textOf(block["model"], `${where}.model`) };
  if (block["price"] !== undefined) fallback.price = priceOf(block["price"], `${where}.price`);
  if (block["effortParam"] !== undefined) fallback.effortParam = effortParamOf(block["effortParam"], `${where}.effortParam`);
  if (block["vision"] !== undefined) fallback.vision = flagOf(block["vision"], `${where}.vision`);
  if (block["cacheMarks"] !== undefined) fallback.cacheMarks = flagOf(block["cacheMarks"], `${where}.cacheMarks`);
  if (block["effort"] !== undefined) {
    if (!isEffort(block["effort"])) throw new Error(`${where}.effort must be one of ${EFFORTS.join(", ")}.`);
    fallback.effort = block["effort"];
  }
  if (block["contextTokens"] !== undefined) fallback.contextTokens = positiveInt(block["contextTokens"], `${where}.contextTokens`);
  if (block["api"] !== undefined) fallback.api = apiOf(block["api"], `${where}.api`);
  if (block["effortMap"] !== undefined) fallback.effortMap = effortMapOf(block["effortMap"], `${where}.effortMap`);
  if (block["baseUrl"] !== undefined) fallback.baseUrl = baseUrlOf(block["baseUrl"], `${where}.baseUrl`);
  if (block["apiKeyEnv"] !== undefined) fallback.apiKeyEnv = keyEnvOf(block["apiKeyEnv"], `${where}.apiKeyEnv`);
  if (block["headers"] !== undefined) fallback.headers = headersOf(block["headers"], `${where}.headers`);
  const incremental = incrementalOf(block, where);
  if (incremental !== undefined) fallback.incremental = incremental;
  if (fallback.api === "responses" && fallback.cacheMarks === true) {
    throw new Error(`${where}.cacheMarks is for the chat protocol only; leave it out when ${where}.api is "responses".`);
  }
  if (fallback.api === "responses" && fallback.incremental === true) {
    throw new Error(`${where}.incremental is for the chat protocol only; leave it out when ${where}.api is "responses".`);
  }
  if (block["fallback"] !== undefined) fallback.fallback = parseFallback(block["fallback"], `${where}.fallback`);
  return fallback;
}

/**
 * The incremental replies flag. "incremental" is the key; the old key from before the rename is still read so existing
 * entity.json files keep working, and when both are given "incremental" wins.
 */
function incrementalOf(block: Record<string, unknown>, where: string): boolean | undefined {
  if (block["incremental"] !== undefined) return flagOf(block["incremental"], `${where}.incremental`);
  if (block["stream"] !== undefined) return flagOf(block["stream"], `${where}.incremental`);
  return undefined;
}

function baseUrlOf(value: unknown, where: string): string {
  const baseUrl = textOf(value, where);
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new Error(`${where} must be a full http:// or https:// address.`);
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`${where} must start with http:// or https://.`);
  return baseUrl;
}

function keyEnvOf(value: unknown, where: string): string {
  const envName = textOf(value, where);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`${where} must be the name of an environment variable, such as NATALIS_MODEL_KEY.`);
  }
  return envName;
}

/** A model's price per million tokens, input and output. Both are numbers, 0 or more. Absent unless the summoner sets it. */
function priceOf(value: unknown, where: string): ModelPrice {
  const block = objectOf(value, where);
  onlyKeys(block, ["inputPerMillion", "outputPerMillion"], where);
  return {
    inputPerMillion: priceNumber(block["inputPerMillion"], `${where}.inputPerMillion`),
    outputPerMillion: priceNumber(block["outputPerMillion"], `${where}.outputPerMillion`),
  };
}

function priceNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a number, 0 or more.`);
  }
  return value;
}

function flagOf(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${where} must be true or false.`);
  return value;
}

function effortParamOf(value: unknown, where: string): "reasoning_effort" | null {
  if (value === null || value === "reasoning_effort") return value;
  throw new Error(`${where} must be "reasoning_effort" or null.`);
}

function apiOf(value: unknown, where: string): "chat" | "responses" {
  if (value === "chat" || value === "responses") return value;
  throw new Error(`${where} must be "chat" or "responses".`);
}

/** Header names and values are plain text. The key never goes here: it is read from apiKeyEnv and always wins. */
function headersOf(value: unknown, where: string): Record<string, string> {
  const block = objectOf(value, where);
  const headers: Record<string, string> = {};
  for (const [name, text] of Object.entries(block)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`${where} has a header name that is not valid: "${name}".`);
    if (name.toLowerCase() === "authorization") throw new Error(`${where} must not set authorization; the key comes from apiKeyEnv.`);
    if (typeof text !== "string" || text.trim() === "" || /[\r\n]/.test(text)) {
      throw new Error(`${where}.${name} must be a non-empty text on one line.`);
    }
    headers[name] = text.trim();
  }
  return headers;
}

function effortMapOf(value: unknown, where: string): EffortMap {
  const block = objectOf(value, where);
  onlyKeys(block, EFFORTS, where);
  const map: EffortMap = {};
  for (const effort of EFFORTS) {
    if (block[effort] !== undefined) map[effort] = textOf(block[effort], `${where}.${effort}`);
  }
  return map;
}

function parseOwner(value: unknown): { alias: string } {
  const owner = objectOf(value, "summoner");
  onlyKeys(owner, ["alias"], "summoner");
  return { alias: textOf(owner["alias"], "summoner.alias") };
}

function parseCeiling(value: unknown): Ceiling {
  if (value === undefined) return { ...DEFAULT_CEILING };
  const block = objectOf(value, "ceiling");
  onlyKeys(block, ["maxModelCalls", "maxToolCalls", "wholeResultsChars"], "ceiling");
  return {
    maxModelCalls:
      block["maxModelCalls"] === undefined
        ? DEFAULT_CEILING.maxModelCalls
        : positiveInt(block["maxModelCalls"], "ceiling.maxModelCalls"),
    maxToolCalls:
      block["maxToolCalls"] === undefined
        ? DEFAULT_CEILING.maxToolCalls
        : positiveInt(block["maxToolCalls"], "ceiling.maxToolCalls"),
    ...(block["wholeResultsChars"] === undefined
      ? {}
      : { wholeResultsChars: positiveInt(block["wholeResultsChars"], "ceiling.wholeResultsChars") }),
  };
}

function objectOf(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(block: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown field "${key}" in ${where}. Allowed: ${allowed.join(", ")}.`);
    }
  }
}

function textOf(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty text.`);
  return value.trim();
}

function positiveInt(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${where} must be a whole number, 1 or more.`);
  }
  return value;
}

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

function checkZone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`timeZone "${zone}" is not a zone this system knows. Use an IANA name such as Europe/Istanbul.`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
