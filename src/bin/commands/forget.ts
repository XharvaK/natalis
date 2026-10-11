// `natalis forget --dir <entity folder> (--query "<words>" | --seqs 3,4,9) --reason "<line>"`: the owner's forget.
// The river erases the matching rows' text and data and keeps their place with a tombstone. With --query, every
// current note line that holds all the words is replaced by a marker, in one commit per file, with the reason.
// Counts are printed, never the forgotten text. With --query, the game's store (domus/domus.sqlite, when there is one)
// loses the words too. The notebook's git history still holds the old text: purging that history is a separate step
// and is not done here.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITY_FILE } from "../../entity/config.js";
import { forgetInStateFile, STATE_FILE } from "../../entity/runtime.js";
import { forgetLines, queryWords } from "../../notebook/forget.js";
import { openNotebook } from "../../notebook/index.js";
import { openRiver } from "../../river/index.js";
import { DOMUS_DB_FILE, DOMUS_FOLDER, forgetInDomusFile } from "../../worlds/domus/store.js";
import { flagValue } from "./args.js";

export const FORGET_USAGE =
  'Usage: natalis forget --dir <entity folder> (--query "<words>" | --seqs 3,4,9) --reason "<line>"';
const TRASH = "trash";

export type ForgetRequest = {
  dir: string;
  /** Words: every note line and every river row that holds all of them. */
  query?: string;
  /** River row numbers to forget. Only the river is touched in this mode. */
  seqs?: number[];
  reason: string;
};

/** `domus` is the game store's row count; undefined when there is no game store (or the forget is by seqs). */
export type ForgetCounts = { rows: number; lines: number; files: number; stateTexts: number; domus: number | undefined };

export type ParsedForget = { ok: true; request: ForgetRequest } | { ok: false; error: string };

/** Checks the flags. Every refusal says what to fix, in plain words. */
export function parseForgetArgs(args: readonly string[]): ParsedForget {
  const dir = flagValue(args, "--dir");
  if (dir === undefined || dir.trim() === "") return { ok: false, error: "--dir is missing: give the entity's folder." };
  const reason = flagValue(args, "--reason");
  if (reason === undefined || reason.trim() === "") {
    return { ok: false, error: "--reason is missing: say why, in one line." };
  }
  const query = flagValue(args, "--query");
  const seqsText = flagValue(args, "--seqs");
  if ((query === undefined) === (seqsText === undefined)) {
    return { ok: false, error: "Give either --query or --seqs, not both and not neither." };
  }
  if (query !== undefined) {
    if (queryWords(query).length === 0) return { ok: false, error: "--query needs at least one word." };
    return { ok: true, request: { dir: dir.trim(), query: query.trim(), reason: reason.trim() } };
  }
  const seqs = parseSeqs(seqsText ?? "");
  if (seqs === undefined) return { ok: false, error: "--seqs takes row numbers such as 3,4,9." };
  return { ok: true, request: { dir: dir.trim(), seqs, reason: reason.trim() } };
}

function parseSeqs(text: string): number[] | undefined {
  const parts = text.split(",").map((part) => part.trim());
  const seqs: number[] = [];
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) return undefined;
    const seq = Number(part);
    if (!Number.isSafeInteger(seq)) return undefined;
    seqs.push(seq);
  }
  return seqs;
}

/** Forgets in the river, and in the notebook when a query is given. Returns counts only. */
export async function runForget(request: ForgetRequest): Promise<ForgetCounts> {
  const dir = resolve(request.dir);
  if (!existsSync(join(dir, ENTITY_FILE))) throw new Error(`No ${ENTITY_FILE} in ${dir}. Give the entity's own folder.`);
  if (!existsSync(join(dir, "river.db"))) throw new Error(`No river.db in ${dir}; there is nothing to forget yet.`);

  let rows: number;
  const river = openRiver(join(dir, "river.db"));
  try {
    rows =
      request.seqs !== undefined
        ? river.forget({ seqs: request.seqs }, "owner", request.reason)
        : river.forget({ text: request.query ?? "" }, "owner", request.reason);
  } finally {
    river.close();
  }

  let lines = 0;
  let files = 0;
  if (request.query !== undefined && existsSync(join(dir, "notebook"))) {
    const words = queryWords(request.query);
    const notebook = await openNotebook(join(dir, "notebook"));
    for (const entry of notebook.list()) {
      if (entry.path === TRASH || entry.path.startsWith(`${TRASH}/`) || entry.path === ".gitattributes") continue;
      const text = notebook.read(entry.path);
      if (text === null) continue;
      const result = forgetLines(text, words);
      if (result.count === 0) continue;
      await notebook.write(entry.path, result.text, request.reason, "owner");
      lines += result.count;
      files += 1;
    }
  }
  // The state keeps short texts too (mood, wake reasons, proposals, the last words said in a place). A running Lar
  // writes its own state on its next save, so this part holds only when the Lar is stopped; the command says so.
  const stateTexts = request.query === undefined ? 0 : forgetInStateFile(join(dir, STATE_FILE), request.query);
  // The game's store keeps the game's own words (observations, acts, answers, plan steps). It is searched when it exists.
  const gameStore = join(dir, DOMUS_FOLDER, DOMUS_DB_FILE);
  const domus = request.query !== undefined && existsSync(gameStore) ? forgetInDomusFile(dir, queryWords(request.query)) : undefined;
  return { rows, lines, files, stateTexts, domus };
}

/** The forget command. Returns the exit code; output goes to the writers given. */
export async function forgetCommand(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const parsed = parseForgetArgs(args);
  if (!parsed.ok) {
    err(parsed.error);
    err(FORGET_USAGE);
    return 2;
  }
  const counts = await runForget(parsed.request);
  if (parsed.request.seqs !== undefined) {
    out(`Forgot ${counts.rows} river row(s).`);
    return 0;
  }
  if (counts.domus === undefined) {
    out(`Forgot ${counts.rows} river row(s), ${counts.lines} note line(s) in ${counts.files} note file(s), and ${counts.stateTexts} text(s) in the state file.`);
  } else {
    out(`Forgot ${counts.rows} river row(s), ${counts.lines} note line(s) in ${counts.files} note file(s), ${counts.stateTexts} text(s) in the state file, and ${counts.domus} row(s) in the game's store.`);
  }
  out("If the Lar was running, stop it and run this again: a running Lar writes its own state file on its next save.");
  out("Warning: the notebook's git history still holds the old text. Purging that history is a separate step, not done here.");
  out("Files in trash/ were not searched; they keep their text until that separate step.");
  return 0;
}
