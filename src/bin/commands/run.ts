// `natalis run --dir <entity folder>` keeps an entity living in its worlds until the process is told to stop
// (SIGINT or SIGTERM), then closes it cleanly. Worlds come from small files beside entity.json: discord.json,
// sandbox.json, web.json, domus.json. Those files hold platform ids and the name of the environment variable with the token, never
// the token itself, and they stay on the host: they are not part of the entity's notebook.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { World } from "../../contracts.js";
import { loadEntityConfig } from "../../entity/config.js";
import { CopyGuardRefused } from "../../entity/copy-guard.js";
import { acquireLarLock, LarLockBusy, type LarLock } from "../../entity/lar-lock.js";
import { type Entity, openEntity } from "../../entity/runtime.js";
import { modelFromConfig, worldModelsFromConfig } from "../../model/from-config.js";
import { createSecretScanner } from "../../secrets/index.js";
import { createDiscordWorld } from "../../worlds/discord/index.js";
import { DISCORD_ALIASES_FILE } from "../../worlds/discord/aliases.js";
import { CONTACTS_FILE } from "../../entity/contacts.js";
import { createDomusWorld, DOMUS_FILE, parseDomusFile } from "../../worlds/domus/index.js";
import { bodyRefusal, createSandboxWorld, defaultBodyRoot, parseSandboxFile, SANDBOX_FILE, SANDBOX_HOME } from "../../worlds/sandbox/index.js";
import { createWebWorld, loadWebFile, WEB_FILE } from "../../worlds/web/index.js";
import { flagValue } from "./args.js";
import { DISCORD_FILE, parseDiscordFile } from "./discord-file.js";
import { heldValues, knownValueList, otherThanHelper } from "./known-values.js";

export const RUN_USAGE = "Usage: natalis run --dir <entity folder> [--moved]";
export { DISCORD_FILE, parseDiscordFile, type DiscordFile } from "./discord-file.js";

/** Runs until a stop signal. Returns the exit code. */
export async function runCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(RUN_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  const moved = args.includes("--moved");
  const config = loadEntityConfig(dir);

  // One process per Lar folder. The lock is taken before any world or the river opens, and kept until this
  // command returns; a second natalis process is refused with a plain message instead of touching the files.
  let lock: LarLock;
  try {
    lock = acquireLarLock(dir);
  } catch (error) {
    if (!(error instanceof LarLockBusy)) throw error;
    err(error.message);
    return 1;
  }

  try {
    // Every key the body holds is registered with the scanner, so none can reach the model or a say. Created before the
    // worlds, so a world can register its own secrets (the web's vault values) as it starts.
    const held = heldValues(dir, config);
    const scanner = createSecretScanner({ knownValues: knownValueList(held) });

    const worlds: World[] = [];
    // The summoner's last message, read from the entity once it is open (the Domus world reads it on each travel).
    let opened: Entity | undefined;
    const lastOwnerMs = (): number | undefined => opened?.lastOwnerMs?.();
    const discordPath = join(dir, DISCORD_FILE);
    const sandboxPath = join(dir, SANDBOX_FILE);
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
          ...(config.timeZone === undefined ? {} : { timeZone: config.timeZone }),
          rooms: discord.rooms,
          aliasesPath: join(dir, DISCORD_ALIASES_FILE),
          contactsPath: join(dir, CONTACTS_FILE),
          // Files that are not pictures go into her home, where her sandbox sees them. Without a sandbox she has no home.
          ...(existsSync(sandboxPath) ? { filesHome: { dir: join(dir, "home"), shownAs: SANDBOX_HOME } } : {}),
        }),
      );
    }
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
      // The helper's token must differ from every other token the body holds: the model key, the bot token and the vault.
      let otherTokens: string[];
      try {
        otherTokens = otherThanHelper(dir, config, held);
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      worlds.push(createDomusWorld({ dir, token, ...(domus.host !== undefined ? { host: domus.host } : {}),
        ...(domus.port !== undefined ? { port: domus.port } : {}), otherTokens,
        ...(config.timeZone !== undefined ? { timeZone: config.timeZone } : {}), lastOwnerMs }));
    }
    if (worlds.length === 0) {
      err(`No worlds to run in: add ${DISCORD_FILE} to ${dir}, or use natalis chat for the terminal.`);
      return 1;
    }

    let entity: Entity;
    try {
      entity = await openEntity({ dir, config, model: modelFromConfig(config.model),
        worldModels: worldModelsFromConfig(config.model, config.effort, config.worldModels),
        worlds,
        scanner,
        ...(moved ? { moved: true } : {}),
      });
    } catch (error) {
      if (!(error instanceof CopyGuardRefused)) throw error;
      err(error.message);
      return 1;
    }
    opened = entity;
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
    // If a handle is left open the event loop never drains and systemd kills us after 300 s; exit after a short grace.
    armExitFailsafe(EXIT_NOT_DRAINED);
    return 0;
  } finally {
    lock.release();
  }
}

/** After this long past "Stopped.", the process exits even if something still holds the event loop. */
export const EXIT_GRACE_MS = 10_000;

/** The exit code when the failsafe had to end the process: not 0, so a stop that left a handle open shows as failed. */
export const EXIT_NOT_DRAINED = 3;

/**
 * An unref'd timer that exits with `code` after `graceMs`; it never keeps the process alive by itself. Its line starts with
 * <4>, the journal's warning level.
 */
export function armExitFailsafe(
  code: number,
  graceMs: number = EXIT_GRACE_MS,
  exit: (code: number) => void = (c) => process.exit(c),
  warn: (line: string) => void = (line) => console.error(line),
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    warn(`<4>[natalis] warning: the event loop did not drain ${graceMs} ms after stopping; exiting with ${code}`);
    exit(code);
  }, graceMs);
  timer.unref();
  return timer;
}
