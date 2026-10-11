// `natalis run --dir <entity folder>` keeps an entity living in its worlds until the process is told to stop
// (SIGINT or SIGTERM), then closes it cleanly. Worlds come from small files beside entity.json: discord.json,
// sandbox.json, web.json, domus.json. Those files hold platform ids and the name of the environment variable with the token, never
// the token itself, and they stay on the host: they are not part of the entity's notebook.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { World } from "../../contracts.js";
import { loadEntityConfig } from "../../entity/config.js";
import { openEntity } from "../../entity/runtime.js";
import { modelFromConfig } from "../../model/from-config.js";
import { createSecretScanner } from "../../secrets/index.js";
import { createDiscordWorld } from "../../worlds/discord/index.js";
import { createDomusWorld, DOMUS_FILE, parseDomusFile } from "../../worlds/domus/index.js";
import { bodyRefusal, createSandboxWorld, defaultBodyRoot, parseSandboxFile, SANDBOX_FILE } from "../../worlds/sandbox/index.js";
import { createWebWorld, loadWebFile, WEB_FILE } from "../../worlds/web/index.js";
import { flagValue } from "./args.js";
import { DISCORD_FILE, parseDiscordFile } from "./discord-file.js";
import { heldValues, knownValueList } from "./known-values.js";

export const RUN_USAGE = "Usage: natalis run --dir <entity folder>";
export { DISCORD_FILE, parseDiscordFile, type DiscordFile } from "./discord-file.js";

/** Runs until a stop signal. Returns the exit code. */
export async function runCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(RUN_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  const config = loadEntityConfig(dir);

  // Every key the body holds is registered with the scanner, so none can reach the model or a say. Created before the
  // worlds, so a world can register its own secrets (the web's vault values) as it starts.
  const held = heldValues(dir, config);
  const scanner = createSecretScanner({ knownValues: knownValueList(held) });

  const worlds: World[] = [];
  const discordPath = join(dir, DISCORD_FILE);
  if (existsSync(discordPath)) {
    const discord = parseDiscordFile(JSON.parse(readFileSync(discordPath, "utf8")) as unknown);
    const token = held.discord;
    if (token === undefined) {
      err(`${DISCORD_FILE} names ${discord.tokenEnv} for the bot token, but it is not set.`);
      return 1;
    }
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
    // The checkout is bound at /body unless sandbox.json says "body": false. A checkout that holds a secret stops the run here.
    const bodyRefused = sandbox.body === false ? undefined : bodyRefusal(defaultBodyRoot(), dir);
    if (bodyRefused !== undefined) {
      err(bodyRefused);
      return 1;
    }
    worlds.push(createSandboxWorld({ dir, config: sandbox }));
  }
  if (existsSync(join(dir, WEB_FILE))) {
    try {
      loadWebFile(dir);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    worlds.push(createWebWorld({ dir, scanner }));
  }
  const domusPath = join(dir, DOMUS_FILE);
  if (existsSync(domusPath)) {
    const domus = parseDomusFile(JSON.parse(readFileSync(domusPath, "utf8")) as unknown);
    const token = held.domus;
    if (token === undefined) {
      err(`${DOMUS_FILE} names ${domus.tokenEnv} for the helper token, but it is not set.`);
      return 1;
    }
    // The helper's token must differ from every other token the body holds: the model key and the bot token.
    const otherTokens = knownValueList({ model: held.model, discord: held.discord, vault: [] });
    worlds.push(createDomusWorld({ dir, token, ...(domus.host !== undefined ? { host: domus.host } : {}),
      ...(domus.port !== undefined ? { port: domus.port } : {}), otherTokens }));
  }
  if (worlds.length === 0) {
    err(`No worlds to run in: add ${DISCORD_FILE} to ${dir}, or use natalis chat for the terminal.`);
    return 1;
  }

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
