// `natalis forget --dir <entity folder> (--query "<words>" | --seqs 3,4,9) --reason "<line>"`: the summoner's forget.
// The river erases the matching rows' text and data and keeps their place with a tombstone. With --query, the words
// go from every place the Lar keeps text: every current note line that holds all the words is replaced by a marker (one
// commit per file, with the reason); the notes in trash/ are changed the same way; the notebook's git history is rebuilt
// without them; the files in the Lar's home that hold them are removed; the pictures the forgotten rows name leave the
// shelf; and the game's store (domus/domus.sqlite, when there is one) loses the words too. Counts are printed, never the
// forgotten text. Older backups still hold the old text until they rotate out.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITY_FILE } from "../../entity/config.js";
import { forgetInStateFile, STATE_FILE } from "../../entity/runtime.js";
import { MEDIA_FOLDER, openShelf } from "../../media/shelf.js";
import { forgetLines, lineHoldsWords, queryWords } from "../../notebook/forget.js";
import { purgeHistory } from "../../notebook/history.js";
import { openNotebook } from "../../notebook/index.js";
import { openRiver } from "../../river/index.js";
import type { RiverRow } from "../../contracts.js";
import { DOMUS_DB_FILE, DOMUS_FOLDER, forgetInDomusFile } from "../../worlds/domus/store.js";
import { flagValue } from "./args.js";
import { HOME_TREE } from "./backup-format.js";

export const FORGET_USAGE =
  'Usage: natalis forget --dir <entity folder> (--query "<words>" | --seqs 3,4,9) --reason "<line>"';
const TRASH = "trash";
const NOTEBOOK = "notebook";
/** The rows of a river read whole, for the search over the words and the pictures they name. */
const ALL_ROWS = 1_000_000;
/** A picture's id, as the shelf names it: `m-` and eight base-32 characters. */
const PICTURE_ID = /\bm-[A-Z2-7]{8}\b/g;

export type ForgetRequest = {
  dir: string;
  /** Words: every note line and every river row that holds all of them. */
  query?: string;
  /** River row numbers to forget. Only the river and the pictures those rows name are touched in this mode. */
  seqs?: number[];
  reason: string;
};

/**
 * Counts only. `domus` is the game store's row count; undefined when there is no game store (or the forget is by seqs).
 * `trashLines` counts the lines changed in trash/, `commits` the notebook's commits rebuilt, `home` the files removed from
 * the Lar's home, and `pictures` the shelf's pictures removed.
 */
export type ForgetCounts = {
  rows: number;
  lines: number;
  files: number;
  stateTexts: number;
  domus: number | undefined;
  trashLines: number;
  commits: number;
  home: number;
  pictures: number;
};

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

/** Forgets in the river, and in every other place the words live when a query is given. Returns counts only. */
export async function runForget(request: ForgetRequest): Promise<ForgetCounts> {
  const dir = resolve(request.dir);
  if (!existsSync(join(dir, ENTITY_FILE))) throw new Error(`No ${ENTITY_FILE} in ${dir}. Give the entity's own folder.`);
  if (!existsSync(join(dir, "river.db"))) throw new Error(`No river.db in ${dir}; there is nothing to forget yet.`);
  const words = request.query === undefined ? [] : queryWords(request.query);

  let rows: number;
  let pictureIds: string[];
  const river = openRiver(join(dir, "river.db"));
  try {
    // The pictures the rows name are read before the rows lose their words.
    pictureIds = picturesNamedBy(river.read({ limit: ALL_ROWS }), request, words);
    rows =
      request.seqs !== undefined
        ? river.forget({ seqs: request.seqs }, "owner", request.reason)
        : river.forget({ text: request.query ?? "" }, "owner", request.reason);
  } finally {
    river.close();
  }

  let lines = 0;
  let files = 0;
  let trashLines = 0;
  let commits = 0;
  let home = 0;
  if (request.query !== undefined && existsSync(join(dir, NOTEBOOK))) {
    const notebookDir = join(dir, NOTEBOOK);
    const notebook = await openNotebook(notebookDir);
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
    // The notes moved to trash keep their text as files, so the same line replacement goes over them.
    trashLines = forgetInFolder(join(notebookDir, TRASH), words);
    // The history is rebuilt last: it holds every commit above, and the working tree is made to match it.
    commits = (await purgeHistory(notebookDir, words)).commits;
  }
  if (request.query !== undefined && existsSync(join(dir, HOME_TREE))) {
    home = removeFilesWith(join(dir, HOME_TREE), words);
  }
  const pictures = removePictures(join(dir, MEDIA_FOLDER), pictureIds);

  // The state keeps short texts too (mood, wake reasons, proposals, the last words said in a place). A running Lar
  // writes its own state on its next save, so this part holds only when the Lar is stopped; the command says so.
  const stateTexts = request.query === undefined ? 0 : forgetInStateFile(join(dir, STATE_FILE), request.query);
  // The game's store keeps the game's own words (observations, acts, answers, plan steps). It is searched when it exists.
  const gameStore = join(dir, DOMUS_FOLDER, DOMUS_DB_FILE);
  const domus = request.query !== undefined && existsSync(gameStore) ? forgetInDomusFile(dir, words) : undefined;
  return { rows, lines, files, stateTexts, domus, trashLines, commits, home, pictures };
}

/**
 * The picture ids the matched rows name: in their data (`pictures`) or in their text (`[picture m-...: name]`). A row
 * matches when it holds every word in its text or in its data, or when its seq is one of the seqs.
 */
function picturesNamedBy(rows: RiverRow[], request: ForgetRequest, words: readonly string[]): string[] {
  const seqs = request.seqs === undefined ? undefined : new Set(request.seqs);
  const ids = new Set<string>();
  for (const row of rows) {
    const matched =
      seqs !== undefined
        ? seqs.has(row.seq)
        : lineHoldsWords(row.text ?? "", words) || (row.data !== undefined && lineHoldsWords(JSON.stringify(row.data), words));
    if (!matched) continue;
    const named = row.data?.["pictures"];
    if (Array.isArray(named)) for (const id of named) if (typeof id === "string") ids.add(id);
    for (const match of (row.text ?? "").matchAll(PICTURE_ID)) ids.add(match[0]);
  }
  return [...ids];
}

/** Removes the named pictures from the shelf. Returns how many were there and are gone now. */
function removePictures(mediaDir: string, ids: readonly string[]): number {
  if (ids.length === 0 || !existsSync(mediaDir)) return 0;
  const shelf = openShelf(mediaDir);
  return ids.filter((id) => shelf.forget(id)).length;
}

/**
 * Replaces the words' lines in every text file under a folder (trash/, which keeps the text as files). Returns the lines
 * replaced. A file that is not text is left as it is.
 */
function forgetInFolder(folder: string, words: readonly string[]): number {
  if (!existsSync(folder)) return 0;
  let count = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      count += forgetInFolder(path, words);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = textOf(readFileSync(path));
    if (text === undefined) continue;
    const result = forgetLines(text, words);
    if (result.count === 0) continue;
    writeFileSync(path, result.text, "utf8");
    count += result.count;
  }
  return count;
}

/** Removes every regular file under a folder whose text holds all the words. Symbolic links are not followed. */
function removeFilesWith(folder: string, words: readonly string[]): number {
  let removed = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removed += removeFilesWith(path, words);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = textOf(readFileSync(path));
    if (text === undefined || !lineHoldsWords(text, words)) continue;
    rmSync(path, { force: true });
    removed += 1;
  }
  return removed;
}

/** The text of bytes that are valid UTF-8 with no NUL in them; undefined for anything else. */
function textOf(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  if (text.includes("\u0000") || !Buffer.from(text, "utf8").equals(bytes)) return undefined;
  return text;
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
    if (counts.pictures > 0) out(`Took ${counts.pictures} picture(s) off the shelf, which the rows named.`);
    return 0;
  }
  const domus = counts.domus === undefined ? "" : `, and ${counts.domus} row(s) in the game's store`;
  out(
    `Forgot ${counts.rows} river row(s), ${counts.lines} note line(s) in ${counts.files} note file(s), ${counts.stateTexts} text(s) in the state file, ${counts.trashLines} line(s) in trash/, ${counts.commits} notebook commit(s) rewritten, ${counts.home} file(s) in the home, and ${counts.pictures} picture(s) on the shelf${domus}.`,
  );
  out("If the Lar was running, stop it and run this again: a running Lar writes its own state file on its next save.");
  out("Older backups still hold the old text until they rotate out. The next backup does not contain it.");
  return 0;
}
