// Small helpers the command modules share: plain flag parsing, usage errors, and the secret scanner that knows
// the entity's model key when the entity has a readable config. Nothing here decides what a command does.

import { loadEntityConfig } from "../../entity/config.js";
import { createSecretScanner, type CreatedSecretScanner } from "../../secrets/index.js";

/** A mistake in how the command was called. Printed with the usage line, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedFlags = { values: Map<string, string>; switches: Set<string> };

/** Reads `--name value` / `--name=value` pairs and bare switches. Unknown or repeated flags are usage errors. */
export function parseFlags(args: string[], valueFlags: readonly string[], switchFlags: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (switchFlags.includes(name)) {
      if (switches.has(name)) throw new UsageError(`${name} was given twice.`);
      switches.add(name);
      continue;
    }
    if (!valueFlags.includes(name)) throw new UsageError(`Unknown argument "${arg}".`);
    if (values.has(name)) throw new UsageError(`${name} was given twice.`);
    let value: string | undefined;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      value = args[i + 1];
      i += 1;
    }
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
    values.set(name, value);
  }
  return { values, switches };
}

export function requireFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name);
  if (value === undefined) throw new UsageError(`${name} is required.`);
  return value;
}

/**
 * A secret scanner that also knows the entity's model key, when the entity's config names one and it is set in
 * the environment. The key is read by reference and never printed.
 */
export function scannerFor(dir: string): CreatedSecretScanner {
  let key: string | undefined;
  try {
    const keyName = loadEntityConfig(dir).model.apiKeyEnv;
    key = keyName === undefined ? undefined : process.env[keyName];
  } catch {
    key = undefined;
  }
  return createSecretScanner({ knownValues: key !== undefined && key.length >= 8 ? [key] : [] });
}

/** Runs a command body, printing plain errors. Returns the exit code. */
export async function runCommand(usage: string, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`natalis: ${err.message}`);
      console.error(usage);
      return 2;
    }
    console.error(`natalis: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
