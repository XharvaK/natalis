// kantus.json: the small file beside entity.json that switches the Kantus studio on. It holds the name of the environment
// variable that has the studio's token, never the token itself, and where the bridge listens. It stays on the host.

export const KANTUS_FILE = "kantus.json";
/** Where the bridge listens when kantus.json does not say. */
export const KANTUS_DEFAULT_HOST = "127.0.0.1";
/** The port Kantus.exe posts to when kantus.json does not say. */
export const KANTUS_DEFAULT_PORT = 3721;

export type KantusFile = {
  /** Name of the environment variable holding the studio's token. */
  tokenEnv: string;
  /** Where the bridge listens. Defaults to 127.0.0.1. */
  host: string;
  /** The port Kantus.exe posts to. Defaults to 3721. */
  port: number;
};

const ALLOWED = ["tokenEnv", "host", "port"];

/** Checks an already-parsed kantus.json and fills in where to listen. Throws a plain error naming the first wrong field. */
export function parseKantusFile(value: unknown): KantusFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${KANTUS_FILE} must be an object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED.includes(key)) throw new Error(`Unknown field "${key}" in ${KANTUS_FILE}. Allowed: ${ALLOWED.join(", ")}.`);
  }
  const tokenEnv = root["tokenEnv"];
  if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`${KANTUS_FILE}: tokenEnv must be the name of an environment variable.`);
  }
  const host = root["host"];
  if (host !== undefined && (typeof host !== "string" || host.trim() === "")) {
    throw new Error(`${KANTUS_FILE}: host must be an address to listen on.`);
  }
  const port = root["port"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`${KANTUS_FILE}: port must be a whole number from 0 to 65535.`);
  }
  return {
    tokenEnv,
    host: host === undefined ? KANTUS_DEFAULT_HOST : (host as string),
    port: port === undefined ? KANTUS_DEFAULT_PORT : (port as number),
  };
}
