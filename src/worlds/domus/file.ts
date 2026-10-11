// domus.json: the small file beside entity.json that switches the Domus world on. It holds the name of the environment
// variable that has the helper's token, never the token itself, and where the listener binds. It stays on the host.

export const DOMUS_FILE = "domus.json";

export type DomusFile = {
  /** Name of the environment variable holding the helper's token. */
  tokenEnv: string;
  /** Where the listener binds. Defaults to 127.0.0.1. */
  host?: string;
  /** The port the helper posts to. Defaults to 3711. */
  port?: number;
};

const ALLOWED = ["tokenEnv", "host", "port"];

/** Checks an already-parsed domus.json. Throws a plain error naming the first wrong field. */
export function parseDomusFile(value: unknown): DomusFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${DOMUS_FILE} must be an object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED.includes(key)) throw new Error(`Unknown field "${key}" in ${DOMUS_FILE}. Allowed: ${ALLOWED.join(", ")}.`);
  }
  const tokenEnv = root["tokenEnv"];
  if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`${DOMUS_FILE}: tokenEnv must be the name of an environment variable.`);
  }
  const host = root["host"];
  if (host !== undefined && (typeof host !== "string" || host.trim() === "")) {
    throw new Error(`${DOMUS_FILE}: host must be an address to listen on.`);
  }
  const port = root["port"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`${DOMUS_FILE}: port must be a whole number from 0 to 65535.`);
  }
  return {
    tokenEnv,
    ...(host !== undefined ? { host: host as string } : {}),
    ...(port !== undefined ? { port: port as number } : {}),
  };
}
