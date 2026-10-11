// discord.json: the chat bot's settings beside entity.json. It names the environment variable that holds the token and never
// holds the token itself. Read by `natalis run` and by the commands that need the token's value to keep it out of their output.

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

