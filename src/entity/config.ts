// An entity's config: one plain file, entity.json, in the entity's folder. It names the model and the owner and
// sets the loop ceiling. The key is never in this file: the model block names an environment variable.
// Validation answers with plain errors that say which field is wrong.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ceiling } from "../contracts.js";
import type { EffortMap, FallbackModelConfig, ModelConfig, ModelPrice } from "../model/from-config.js";
import { parseClock } from "./wake-schedule.js";

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_CEILING: Ceiling = { maxModelCalls: 24, maxToolCalls: 48 };
/** No preset rhythm: a Lar keeps whatever wakes it sets itself. A summoner may give times in entity.json rhythm. */
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
  holds?: { honesty?: boolean };
  /** Daily limits. Left out, there is none. */
  limits?: { turnsPerDay?: number };
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
  return parseEntityConfig(parsed);
}

/** Validates an already-parsed entity config. Throws a plain error naming the first wrong field. */
export function parseEntityConfig(value: unknown): EntityConfig {
  const root = objectOf(value, ENTITY_FILE);
  onlyKeys(
    root,
    ["name", "timeZone", "model", "effort", "ceiling", "summoner", "owner", "holds", "limits", "rhythm", "worldModels"],
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

function parseLimits(value: unknown): { turnsPerDay?: number } {
  const block = objectOf(value, "limits");
  onlyKeys(block, ["turnsPerDay"], "limits");
  const limits: { turnsPerDay?: number } = {};
  if (block["turnsPerDay"] !== undefined) limits.turnsPerDay = positiveInt(block["turnsPerDay"], "limits.turnsPerDay");
  return limits;
}

function parseHolds(value: unknown): { honesty?: boolean } {
  const block = objectOf(value, "holds");
  onlyKeys(block, ["honesty"], "holds");
  const holds: { honesty?: boolean } = {};
  if (block["honesty"] !== undefined) {
    if (typeof block["honesty"] !== "boolean") throw new Error("holds.honesty must be true or false.");
    holds.honesty = block["honesty"];
  }
  return holds;
}

/** Validates a model block (the `model` part of entity.json). Also used for the judge's config file. */
export function parseModel(value: unknown): ModelConfig {
  const block = objectOf(value, "model");
  onlyKeys(
    block,
    ["baseUrl", "model", "apiKeyEnv", "contextTokens", "nativeTools", "effortParam", "timeoutMs", "vision", "cacheMarks", "fallback", "price",
      "api", "headers", "effortMap"],
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
  if (model.api === "responses" && model.cacheMarks === true) {
    throw new Error("model.cacheMarks is for the chat protocol only; leave it out when model.api is \"responses\".");
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
      "baseUrl", "apiKeyEnv", "headers", "fallback"],
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
  if (fallback.api === "responses" && fallback.cacheMarks === true) {
    throw new Error(`${where}.cacheMarks is for the chat protocol only; leave it out when ${where}.api is "responses".`);
  }
  if (block["fallback"] !== undefined) fallback.fallback = parseFallback(block["fallback"], `${where}.fallback`);
  return fallback;
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
  onlyKeys(block, ["maxModelCalls", "maxToolCalls"], "ceiling");
  return {
    maxModelCalls:
      block["maxModelCalls"] === undefined
        ? DEFAULT_CEILING.maxModelCalls
        : positiveInt(block["maxModelCalls"], "ceiling.maxModelCalls"),
    maxToolCalls:
      block["maxToolCalls"] === undefined
        ? DEFAULT_CEILING.maxToolCalls
        : positiveInt(block["maxToolCalls"], "ceiling.maxToolCalls"),
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
