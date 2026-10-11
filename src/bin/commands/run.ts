// `natalis run --dir <entity folder>` keeps an entity living in its worlds until the process is told to stop
// (SIGINT or SIGTERM), then closes it cleanly. Worlds come from small files beside entity.json; today that is
// discord.json. Those files hold platform ids and the name of the environment variable with the token, never
// the token itself, and they stay on the host: they are not part of the entity's notebook.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { World } from "../../contracts.js";
import { loadEntityConfig } from "../../entity/config.js";
import { openEntity } from "../../entity/runtime.js";
import { modelFromConfig } from "../../model/from-config.js";
import { createSecretScanner } from "../../secrets/index.js";
import { createDiscordWorld } from "../../worlds/discord/index.js";
import { createSandboxWorld, parseSandboxFile, SANDBOX_FILE } from "../../worlds/sandbox/index.js";
import { flagValue } from "./args.js";

export const RUN_USAGE = "Usage: natalis run --dir <entity folder>";
export const DISCORD_FILE = "discord.json";

export type DiscordFile = {
  /** Name of the environment variable holding the bot token. */
  tokenEnv: string;
  ownerUserId: string;
  /** Channel ids the Lar lives in. DMs with known people need no listing. */
  rooms: string[];
};

/** Checks an already-parsed discord.json. Throws a plain error naming the first wrong field. */
export function parseDiscordFile(value: unknown): DiscordFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${DISCORD_FILE} must be an object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!["tokenEnv", "ownerUserId", "rooms"].includes(key)) {
      throw new Error(`Unknown field "${key}" in ${DISCORD_FILE}. Allowed: tokenEnv, ownerUserId, rooms.`);
    }
  }
  const tokenEnv = root["tokenEnv"];
  if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`${DISCORD_FILE}: tokenEnv must be the name of an environment variable.`);
  }
  const ownerUserId = root["ownerUserId"];
  if (typeof ownerUserId !== "string" || !/^\d+$/.test(ownerUserId)) {
    throw new Error(`${DISCORD_FILE}: ownerUserId must be the owner's Discord user id, digits only.`);
  }
  const rooms = root["rooms"] ?? [];
  if (!Array.isArray(rooms) || !rooms.every((room) => typeof room === "string" && /^\d+$/.test(room))) {
    throw new Error(`${DISCORD_FILE}: rooms must be a list of channel ids, digits only.`);
  }
  return { tokenEnv, ownerUserId, rooms: rooms as string[] };
}

/** Runs until a stop signal. Returns the exit code. */
export async function runCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(RUN_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  const config = loadEntityConfig(dir);

  // Every key the body holds is registered with the scanner, so none can reach the model or a say.
  const known: string[] = [];
  const keyName = config.model.apiKeyEnv;
  const modelKey = keyName === undefined ? undefined : process.env[keyName];
  if (modelKey !== undefined && modelKey.length >= 8) known.push(modelKey);

  const worlds: World[] = [];
  const discordPath = join(dir, DISCORD_FILE);
  if (existsSync(discordPath)) {
    const discord = parseDiscordFile(JSON.parse(readFileSync(discordPath, "utf8")) as unknown);
    const token = process.env[discord.tokenEnv];
    if (token === undefined || token === "") {
      err(`${DISCORD_FILE} names ${discord.tokenEnv} for the bot token, but it is not set.`);
      return 1;
    }
    known.push(token);
    worlds.push(
      createDiscordWorld({
        token,
        ownerUserId: discord.ownerUserId,
        ownerAlias: config.owner.alias,
        rooms: discord.rooms,
        aliasesPath: join(dir, "discord-aliases.json"),
      }),
    );
  }
  const sandboxPath = join(dir, SANDBOX_FILE);
  if (existsSync(sandboxPath)) {
    const sandbox = parseSandboxFile(JSON.parse(readFileSync(sandboxPath, "utf8")) as unknown);
    worlds.push(createSandboxWorld({ dir, config: sandbox }));
  }
  if (worlds.length === 0) {
    err(`No worlds to run in: add ${DISCORD_FILE} to ${dir}, or use natalis chat for the terminal.`);
    return 1;
  }

  const scanner = createSecretScanner({ knownValues: known });
  const entity = await openEntity({ dir, config, model: modelFromConfig(config.model), worlds, scanner });
  const stopped = new Promise<void>((resolveStopped) => {
    process.once("SIGINT", () => resolveStopped());
    process.once("SIGTERM", () => resolveStopped());
  });
  await entity.start();
  out(`${config.name ?? "An unnamed Lar"} is running in: ${worlds.map((world) => world.id).join(", ")}.`);
  await stopped;
  out("Stopping…");
  await entity.stop();
  out("Stopped.");
  return 0;
}
