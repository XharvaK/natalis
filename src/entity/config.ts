// An entity's config: one plain file, entity.json, in the entity's folder. It names the model and the owner and
// sets the loop ceiling. The key is never in this file: the model block names an environment variable.
// Validation answers with plain errors that say which field is wrong.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ceiling } from "../contracts.js";
import type { ModelConfig } from "../model/from-config.js";

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_CEILING: Ceiling = { maxModelCalls: 24, maxToolCalls: 48 };

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
    ["name", "timeZone", "model", "effort", "ceiling", "summoner", "owner", "holds", "limits"],
    ENTITY_FILE,
  );
  if (root["summoner"] !== undefined && root["owner"] !== undefined) {
    throw new Error("Give either summoner or owner in entity.json, not both. summoner is the current name.");
  }

  const config: EntityConfig = {
    model: parseModel(root["model"]),
    owner: parseOwner(root["summoner"] ?? root["owner"]),
    ceiling: parseCeiling(root["ceiling"]),
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
  return config;
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
  onlyKeys(block, ["baseUrl", "model", "apiKeyEnv", "contextTokens", "nativeTools", "effortParam", "timeoutMs", "vision"], "model");

  const baseUrl = textOf(block["baseUrl"], "model.baseUrl");
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new Error("model.baseUrl must be a full http:// or https:// address.");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("model.baseUrl must start with http:// or https://.");
  }

  const model: ModelConfig = {
    baseUrl,
    model: textOf(block["model"], "model.model"),
    contextTokens: positiveInt(block["contextTokens"], "model.contextTokens"),
  };
  if (block["apiKeyEnv"] !== undefined) {
    const envName = textOf(block["apiKeyEnv"], "model.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error("model.apiKeyEnv must be the name of an environment variable, such as NATALIS_MODEL_KEY.");
    }
    model.apiKeyEnv = envName;
  }
  if (block["nativeTools"] !== undefined) {
    if (typeof block["nativeTools"] !== "boolean") throw new Error("model.nativeTools must be true or false.");
    model.nativeTools = block["nativeTools"];
  }
  if (block["effortParam"] !== undefined) {
    if (block["effortParam"] !== null && block["effortParam"] !== "reasoning_effort") {
      throw new Error('model.effortParam must be "reasoning_effort" or null.');
    }
    model.effortParam = block["effortParam"];
  }
  if (block["timeoutMs"] !== undefined) model.timeoutMs = positiveInt(block["timeoutMs"], "model.timeoutMs");
  if (block["vision"] !== undefined) {
    if (typeof block["vision"] !== "boolean") throw new Error("model.vision must be true or false.");
    model.vision = block["vision"];
  }
  return model;
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
