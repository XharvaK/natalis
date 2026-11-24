// The values the body holds for one Lar, which no receipt, digest or say may show: the model key, and the bot, game and
// studio tokens that discord.json, domus.json and kantus.json name by environment variable. A value is read by reference
// and never printed. The web vault's values are added only when a command asks for them: the web world registers its own
// while it runs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityConfig } from "../../entity/config.js";
import { modelKeyEnvs } from "../../model/from-config.js";
import { MIN_KNOWN_VALUE_LENGTH } from "../../secrets/index.js";
import { DOMUS_FILE, parseDomusFile } from "../../worlds/domus/index.js";
import { KANTUS_FILE, parseKantusFile } from "../../worlds/kantus/index.js";
import { readVault } from "../../worlds/web/vault.js";
import { DISCORD_FILE, parseDiscordFile } from "./discord-file.js";

export type HeldValues = {
  /** The model's key, when the config names an environment variable for it and the value is long enough to be a key. */
  model?: string;
  /** The keys of backup models on other services, each when set and long enough to be a key. */
  otherModels?: string[];
  /** The key of the embeddings service, when the config names a variable for it and the value is long enough to be a key. */
  embeddings?: string;
  /** The bot token, when discord.json names a variable that is set. */
  discord?: string;
  /** The game helper's token, when domus.json names a variable that is set. */
  domus?: string;
  /** The studio's token, when kantus.json names a variable that is set. */
  kantus?: string;
  /** The web vault's values, when the command asked for them. */
  vault: string[];
};

export type HeldOptions = {
  /** Where the variables are read from. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Whether to read the web vault's values too. Off by default: the web world registers them when it starts. */
  vault?: boolean;
};

/** Gathers what the body holds for the Lar in `dir`. A missing variable is left out; a damaged world file is an error. */
export function heldValues(dir: string, config: EntityConfig, options: HeldOptions = {}): HeldValues {
  const env = options.env ?? process.env;
  const held: HeldValues = { vault: [] };
  const keyName = config.model.apiKeyEnv;
  const modelKey = keyName === undefined ? undefined : env[keyName];
  if (modelKey !== undefined && modelKey.length >= MIN_KNOWN_VALUE_LENGTH) held.model = modelKey;
  const otherModels = modelKeyEnvs(config.model, config.worldModels)
    .filter((name) => name !== keyName)
    .map((name) => env[name])
    .filter((value): value is string => value !== undefined && value.length >= MIN_KNOWN_VALUE_LENGTH);
  if (otherModels.length > 0) held.otherModels = otherModels;
  const embeddingsKey = config.embeddings === undefined ? undefined : env[config.embeddings.apiKeyEnv];
  if (embeddingsKey !== undefined && embeddingsKey.length >= MIN_KNOWN_VALUE_LENGTH) held.embeddings = embeddingsKey;
  const discordPath = join(dir, DISCORD_FILE);
  if (existsSync(discordPath)) {
    const discord = parseDiscordFile(JSON.parse(readFileSync(discordPath, "utf8")) as unknown);
    held.discord = nonEmpty(env[discord.tokenEnv]);
  }
  const domusPath = join(dir, DOMUS_FILE);
  if (existsSync(domusPath)) {
    const domus = parseDomusFile(JSON.parse(readFileSync(domusPath, "utf8")) as unknown);
    held.domus = nonEmpty(env[domus.tokenEnv]);
  }
  const kantusPath = join(dir, KANTUS_FILE);
  if (existsSync(kantusPath)) {
    const kantus = parseKantusFile(JSON.parse(readFileSync(kantusPath, "utf8")) as unknown);
    const token = nonEmpty(env[kantus.tokenEnv]);
    if (token !== undefined) held.kantus = token;
  }
  if (options.vault === true) {
    // Only values the scanner accepts are kept, as the web world keeps them.
    held.vault = Object.values(readVault(dir))
      .map((entry) => entry.value)
      .filter((value) => value.length >= MIN_KNOWN_VALUE_LENGTH);
  }
  return held;
}

/** Every value in the list, as the scanner's known values. */
export function knownValueList(held: HeldValues): string[] {
  return [held.model, ...(held.otherModels ?? []), held.embeddings, held.discord, held.domus, held.kantus, ...held.vault]
    .filter((value): value is string => value !== undefined);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The world whose token is being checked, and so the one value left out: a token never matches itself. */
export type HelperToken = "domus" | "kantus";

/**
 * The values a world token must differ from: the model key, the bot token, the other world's token and every web vault
 * value. A token equal to a vault value would let one leak expose the other, so the vault is read here as well. The
 * caller names its own token, which is left out; every other one is kept.
 */
export function otherThanHelper(dir: string, config: EntityConfig, held: HeldValues, except: HelperToken = "domus"): string[] {
  const vault = heldValues(dir, config, { vault: true }).vault;
  return knownValueList({
    model: held.model,
    ...(held.otherModels === undefined ? {} : { otherModels: held.otherModels }),
    ...(held.embeddings === undefined ? {} : { embeddings: held.embeddings }),
    discord: held.discord,
    ...(except === "domus" || held.domus === undefined ? {} : { domus: held.domus }),
    ...(except === "kantus" || held.kantus === undefined ? {} : { kantus: held.kantus }),
    vault,
  });
}
