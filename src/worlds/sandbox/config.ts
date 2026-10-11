// sandbox.json: the sandbox's ceilings, beside entity.json. No file, no sandbox. Unknown fields and wrong numbers
// are refused with a plain error that names the field.

export const SANDBOX_FILE = "sandbox.json";
export const SANDBOX_DEFAULT_TIMEOUT_S = 120;
export const SANDBOX_DEFAULT_MAX_TIMEOUT_S = 900;
/** The largest number of seconds any timeout may be set to in the file. */
export const SANDBOX_TIMEOUT_LIMIT_S = 3600;
/**
 * What a command's network is. "wall": the internet, but never the host's own loopback or its local network (the
 * default). "host": the host's whole network, as before the wall. "none": loopback only.
 */
export const SANDBOX_NETWORKS = ["wall", "host", "none"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];
export const SANDBOX_DEFAULT_NETWORK: SandboxNetwork = "wall";

const ALLOWED = ["timeoutSeconds", "maxTimeoutSeconds", "bwrapPath", "body", "network", "pastaPath", "ipPath"];

export type SandboxSettings = {
  /** The default timeout for a command, in seconds. */
  timeoutSeconds: number;
  /** The most any command may run, in seconds. A longer request is capped to this. */
  maxTimeoutSeconds: number;
  /** Where to find bwrap. Left out, bwrap is looked for on PATH. */
  bwrapPath?: string;
  /** Whether the Natalis checkout is bound read-only at /body. Set in the file as "body": false to leave it out. */
  body?: boolean;
  /** What a command's network is. Left out, "wall". See SANDBOX_NETWORKS. */
  network?: SandboxNetwork;
  /** Where to find pasta (the passt package), which walls the network in "wall" mode. Left out, pasta is looked for on PATH. */
  pastaPath?: string;
  /** Where to find ip (iproute2), used in "wall" mode. Left out, /usr/sbin/ip, then /sbin/ip. */
  ipPath?: string;
};

/** Checks an already-parsed sandbox.json and fills in the defaults. Throws a plain error naming the first wrong field. */
export function parseSandboxFile(value: unknown): SandboxSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${SANDBOX_FILE} must be an object.`);
  }
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED.includes(key)) throw new Error(`Unknown field "${key}" in ${SANDBOX_FILE}. Allowed: ${ALLOWED.join(", ")}.`);
  }
  const maxTimeoutSeconds = wholeSeconds(root, "maxTimeoutSeconds") ?? SANDBOX_DEFAULT_MAX_TIMEOUT_S;
  const timeoutSeconds =
    wholeSeconds(root, "timeoutSeconds") ?? Math.min(SANDBOX_DEFAULT_TIMEOUT_S, maxTimeoutSeconds);
  if (timeoutSeconds > maxTimeoutSeconds) {
    throw new Error(
      `${SANDBOX_FILE}: timeoutSeconds (${timeoutSeconds}) cannot be more than maxTimeoutSeconds (${maxTimeoutSeconds}).`,
    );
  }
  const body = root["body"] ?? true;
  if (typeof body !== "boolean") throw new Error(`${SANDBOX_FILE}: body must be true or false.`);
  // Only a missing key takes the default: a null or an empty value is refused, never read as "wall".
  const network = root["network"] === undefined ? SANDBOX_DEFAULT_NETWORK : root["network"];
  if (!(SANDBOX_NETWORKS as readonly unknown[]).includes(network)) {
    throw new Error(`${SANDBOX_FILE}: network must be "wall", "host" or "none".`);
  }
  const settings: SandboxSettings = { timeoutSeconds, maxTimeoutSeconds, body, network: network as SandboxNetwork };
  const bwrap = programPath(root, "bwrapPath");
  if (bwrap !== undefined) settings.bwrapPath = bwrap;
  const pasta = programPath(root, "pastaPath");
  if (pasta !== undefined) settings.pastaPath = pasta;
  const ip = programPath(root, "ipPath");
  if (ip !== undefined) settings.ipPath = ip;
  return settings;
}

/** A program's path, trimmed, when the file gives one; undefined when the key is left out. */
function programPath(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${SANDBOX_FILE}: ${key} must be the path to the program, as text.`);
  }
  return value.trim();
}

function wholeSeconds(root: Record<string, unknown>, key: string): number | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SANDBOX_TIMEOUT_LIMIT_S) {
    throw new Error(`${SANDBOX_FILE}: ${key} must be a whole number of seconds from 1 to ${SANDBOX_TIMEOUT_LIMIT_S}.`);
  }
  return value;
}
