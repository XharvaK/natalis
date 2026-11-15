// `natalis proposals --dir <entity folder> [--since YYYY-MM-DD]` prints the digest of what the Lar wrote under
// proposals/ in its notebook. It reads the notebook's git history and nothing else: no write, no commit, no remote. It
// also answers one proposal through the running Lar's local vault channel. Every value the body holds, and every vault
// value, is redacted before anything is printed. A proposal is a request from the Lar; the review decides what happens
// to it.

import { join, resolve } from "node:path";
import { loadEntityConfig } from "../../entity/config.js";
import { openVaultChannel, type VaultChannelClient } from "../../entity/vault-queue.js";
import { proposalsDigest } from "../../notebook/proposals-digest.js";
import { createSecretScanner } from "../../secrets/index.js";
import { errorText } from "./backup-format.js";
import { knownValueList, heldValues } from "./known-values.js";
import { NOTEBOOK_DIR } from "../../import/folder.js";
import { parseFlags, UsageError, type ParsedFlags } from "./shared.js";

export const PROPOSALS_USAGE =
  'Usage: natalis proposals --dir <entity folder> [--since YYYY-MM-DD]  or  natalis proposals --dir <entity folder> --answer <file> --text "<one line>"';
const DAY_MS = 86_400_000;
const NO_LAR_MESSAGE = "natalis: the Lar is not running, so the answer cannot reach her. Start it, then answer again.";

/** A local calendar day as YYYY-MM-DD. */
function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether the text is a real calendar day written YYYY-MM-DD. */
function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
}

/** Runs the digest command, or sends one answer. Returns 0 for success, 2 for bad flags, 1 for a failure. */
export async function proposalsCommand(
  args: readonly string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  now: Date = new Date(),
): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags([...args], ["--dir", "--since", "--answer", "--text"], []);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`natalis: ${error.message}`);
      err(PROPOSALS_USAGE);
      return 2;
    }
    throw error;
  }
  const dirArg = flags.values.get("--dir");
  if (dirArg === undefined) {
    err(PROPOSALS_USAGE);
    return 2;
  }
  const answer = flags.values.get("--answer");
  const answerText = flags.values.get("--text");
  if ((answer === undefined) !== (answerText === undefined)) {
    err("natalis: --answer and --text go together.");
    err(PROPOSALS_USAGE);
    return 2;
  }
  if (answer !== undefined && answerText !== undefined) {
    return answerWith(dirArg, answer, answerText, out, err);
  }

  const since = flags.values.get("--since") ?? localDay(new Date(now.getTime() - 7 * DAY_MS));
  if (!isDay(since)) {
    err("natalis: --since must be a day written YYYY-MM-DD, such as 2026-10-04.");
    err(PROPOSALS_USAGE);
    return 2;
  }

  const dir = resolve(dirArg);
  try {
    const config = loadEntityConfig(dir);
    const held = heldValues(dir, config, { vault: true });
    const scanner = createSecretScanner({ knownValues: knownValueList(held) });
    const digest = await proposalsDigest({ notebook: join(dir, NOTEBOOK_DIR), since, scanner });
    out(digest.text);
    return 0;
  } catch (error) {
    err(`natalis: ${errorText(error)}`);
    return 1;
  }
}

/** Sends one answer through the running Lar's channel and prints its reply. */
async function answerWith(
  dirArg: string,
  file: string,
  text: string,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let client: VaultChannelClient;
  try {
    client = await openVaultChannel(resolve(dirArg));
  } catch {
    err(NO_LAR_MESSAGE);
    return 1;
  }
  try {
    const reply = await client.send({ op: "answer", file, text });
    out(reply);
    return reply === "answered" ? 0 : 1;
  } catch (error) {
    err(`natalis: ${errorText(error)}`);
    return 1;
  } finally {
    client.close();
  }
}
