// sandbox.json: the sandbox's ceilings, beside entity.json. No file, no sandbox. Unknown fields and wrong numbers
// are refused with a plain error that names the field.

export const SANDBOX_FILE = "sandbox.json";
export const SANDBOX_DEFAULT_TIMEOUT_S = 120;
export const SANDBOX_DEFAULT_MAX_TIMEOUT_S = 900;
/** The largest number of seconds any timeout may be set to in the file. */
export const SANDBOX_TIMEOUT_LIMIT_S = 3600;

const ALLOWED = ["timeoutSeconds", "maxTimeoutSeconds", "bwrapPath"];

export type SandboxSettings = {
  /** The default timeout for a command, in seconds. */
  timeoutSeconds: number;
  /** The most any command may run, in seconds. A longer request is capped to this. */
  maxTimeoutSeconds: number;
  /** Where to find bwrap. Left out, bwrap is looked for on PATH. */
  bwrapPath?: string;
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
  const bwrap = root["bwrapPath"];
  if (bwrap === undefined) return { timeoutSeconds, maxTimeoutSeconds };
  if (typeof bwrap !== "string" || bwrap.trim() === "" || bwrap.includes("\0")) {
    throw new Error(`${SANDBOX_FILE}: bwrapPath must be the path to the bwrap program, as text.`);
  }
  return { timeoutSeconds, maxTimeoutSeconds, bwrapPath: bwrap.trim() };
}

function wholeSeconds(root: Record<string, unknown>, key: string): number | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SANDBOX_TIMEOUT_LIMIT_S) {
    throw new Error(`${SANDBOX_FILE}: ${key} must be a whole number of seconds from 1 to ${SANDBOX_TIMEOUT_LIMIT_S}.`);
  }
  return value;
}
