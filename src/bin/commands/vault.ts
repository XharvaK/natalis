// `natalis vault --dir <entity folder>` lists the names in the Lar's vault with the host each is bound to (never the
// values). `natalis vault --dir <entity folder> --keep <name> --host <host> [--replace]` keeps one value the summoner
// types: it is read from standard input, hidden on a terminal, never taken from the command line (where shell history
// and the process list would hold it), and never printed. This is how a key a site shows only to its owner reaches the
// vault, and how values are kept again after a restore from a plain backup.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITY_FILE } from "../../entity/config.js";
import { acquireLarLock, LarLockBusy, type LarLock } from "../../entity/lar-lock.js";
import { normalizeVaultHost, openVaultChannel, VAULT_CHANNEL_NO_ANSWER_MESSAGE, VAULT_VALUE_MAX, type VaultChannelClient } from "../../entity/vault-queue.js";
import { MIN_KNOWN_VALUE_LENGTH } from "../../secrets/scanner.js";
import { keepVaultEntry, readVault, validVaultName } from "../../worlds/web/vault.js";
import { flagValue, hasFlag } from "./args.js";

export const VAULT_USAGE =
  "Usage: natalis vault --dir <entity folder>  or  natalis vault --dir <entity folder> --keep <name> --host <host> [--replace]" +
  " (the value is read from standard input, never from the command line)";

/** Runs the vault command. `readValue` gives the typed value (hidden on a terminal); tests pass their own. */
export async function vaultCommand(
  args: readonly string[],
  readValue: (prompt: string) => Promise<string>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(VAULT_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  if (!existsSync(join(dir, ENTITY_FILE))) {
    err(`No ${ENTITY_FILE} in ${dir}. Give the entity's own folder.`);
    return 1;
  }

  let vault: ReturnType<typeof readVault>;
  try {
    vault = readVault(dir);
  } catch (error) {
    err(`The vault could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const name = flagValue(args, "--keep");
  if (name === undefined) {
    const names = Object.keys(vault);
    if (names.length === 0) out("The vault is empty.");
    for (const each of names) out(`${each} (for ${vault[each]?.host ?? "?"})`);
    return 0;
  }

  if (!validVaultName(name)) {
    err("A vault name is letters, digits, dots, dashes and underscores, up to 48 characters.");
    return 2;
  }
  const host = normalizeVaultHost(flagValue(args, "--host") ?? "");
  if (host === undefined) {
    err("--host is the site the value is sent to, such as www.example.org. The value goes only to that host and its subdomains.");
    return 2;
  }
  const replace = hasFlag(args, "--replace");
  if (vault[name] !== undefined && !replace) {
    err(`The vault already has a value named ${name} (for ${vault[name]?.host}). Add --replace to replace it. Nothing was kept.`);
    return 1;
  }

  // A keep is a write to the Lar's folder, so it takes the folder lock for its whole run. While the Lar runs,
  // another process holds the lock: the keep goes through the running Lar's own vault channel, so there is still
  // one writer. With no channel answering, it is refused and says why.
  let lock: LarLock;
  try {
    lock = acquireLarLock(dir);
  } catch (error) {
    if (!(error instanceof LarLockBusy)) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    return keepThroughRunningLar(dir, name, host, replace, vault[name] !== undefined, readValue, out, err);
  }
  try {
    const checked = await readCheckedValue(readValue, name, host);
    if ("error" in checked) {
      err(checked.error);
      return 1;
    }
    try {
      keepVaultEntry(dir, name, { host, value: checked.value });
    } catch (error) {
      err(`The value could not be kept: ${error instanceof Error ? error.message : String(error)} Nothing was kept.`);
      return 1;
    }
    out(keptWords(name, host, vault[name] !== undefined, false));
    return 0;
  } finally {
    lock.release();
  }
}

/** The words after a keep. A direct keep still needs a restart; a keep through the running Lar does not. */
function keptWords(name: string, host: string, replaced: boolean, running: boolean): string {
  const first =
    `${replaced ? "Replaced" : "Kept"} the value named ${name}, for ${host}. The Lar can send it with auth {"vault": "${name}"}.`;
  return running
    ? `${first} The running Lar has it now.`
    : `${first} A running Lar learns it at its next start, so restart it: until then the value can be sent but is not yet hidden if a site shows it back.`;
}

type CheckedValue = { value: string } | { error: string };

async function readCheckedValue(
  readValue: (prompt: string) => Promise<string>,
  name: string,
  host: string,
): Promise<CheckedValue> {
  const value = (await readValue(`Value for ${name}, sent only to ${host} (hidden; press Enter when done): `)).trim();
  if (value === "") return { error: "No value was given. Nothing was kept." };
  if (/\s/.test(value) || value.length > VAULT_VALUE_MAX) {
    return { error: `A value is one piece of text with no spaces or line breaks, up to ${VAULT_VALUE_MAX} characters. Nothing was kept.` };
  }
  if (value.length < MIN_KNOWN_VALUE_LENGTH) {
    return {
      error: `A value shorter than ${MIN_KNOWN_VALUE_LENGTH} characters cannot be hidden from the Lar's text, so it cannot be kept. Nothing was kept.`,
    };
  }
  return { value };
}

/**
 * Asks the running Lar to keep the value. The channel is opened before the value is read, so a Lar that is not
 * answering never asks for a value it cannot take.
 */
async function keepThroughRunningLar(
  dir: string,
  name: string,
  host: string,
  replace: boolean,
  replaced: boolean,
  readValue: (prompt: string) => Promise<string>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let client: VaultChannelClient;
  try {
    client = await openVaultChannel(dir);
  } catch {
    err(VAULT_CHANNEL_NO_ANSWER_MESSAGE);
    return 1;
  }
  try {
    const checked = await readCheckedValue(readValue, name, host);
    if ("error" in checked) {
      err(checked.error);
      return 1;
    }
    let answer: string;
    try {
      answer = await client.send({ op: "keep", name, host, value: checked.value, replace });
    } catch {
      err(VAULT_CHANNEL_NO_ANSWER_MESSAGE);
      return 1;
    }
    if (answer !== "kept") {
      err(answer === "" ? VAULT_CHANNEL_NO_ANSWER_MESSAGE : withoutValue(answer, checked.value));
      return 1;
    }
    out(keptWords(name, host, replaced, true));
    return 0;
  } finally {
    client.close();
  }
}

/** Never repeats a value a buggy or other channel answer might have echoed. */
function withoutValue(text: string, value: string): string {
  return value === "" ? text : text.split(value).join("[the value was withheld]");
}

/**
 * Reads one line from standard input. On a terminal the typing is not shown (no echo); piped input is read whole and
 * its first line taken. Ctrl+C or Ctrl+D on an empty line gives "".
 */
export function readHiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  if (!input.isTTY) {
    return new Promise((resolveLine, reject) => {
      let text = "";
      input.setEncoding("utf8");
      input.on("data", (chunk: string) => {
        text += chunk;
      });
      input.on("end", () => resolveLine(text.split(/\r?\n/)[0] ?? ""));
      input.on("error", reject);
    });
  }
  return new Promise((resolveLine) => {
    let typed = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    const finish = (value: string) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      resolveLine(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(typed);
        if (char === "\u0003" || (char === "\u0004" && typed === "")) return finish("");
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else if (char >= " ") typed += char;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}
