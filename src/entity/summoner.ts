// The summoner's commands. A message from the summoner in one of the summoner's own places that starts with "!" is a
// body command, not a turn: it does not wake the Lar and opens no ask. The body does what the words say, answers in
// that place, and writes one row in the self thread so the Lar sees what the summoner did on its next turn. The body
// never judges what the words mean; a refusal is a plain reason.

import type { Notebook } from "../contracts.js";
import {
  commitmentBlock,
  COMMITMENTS_PATH,
  HOUSEHOLD_PATH,
  householdForSummoner,
  withCommitment,
  withHouseholdLine,
  withoutHouseholdLine,
} from "./commitments.js";
import { dayKey, hostZone } from "./day.js";
import { clearStop, writeStop } from "./stop.js";
import { loadWebFile, normalizeHost, saveWebFile, WEB_FILE, WEB_SITES_MAX, type WebFile } from "../worlds/web/sites.js";
import { readVault, removeVaultEntry, validVaultName } from "../worlds/web/vault.js";
import { isPictureId, type Shelf } from "../media/shelf.js";

/** A commitment the Lar proposed and the summoner has not answered yet. */
export type Proposal = { id: string; text: string; why: string; atMs: number; thread: string };

/** The words the body puts before everything it says to the summoner. */
export const SUMMONER_PREFIX = "[natalis] ";
export const PROPOSAL_LIMIT = 10;
export const PROPOSAL_FIELD_MAX = 500;
export const HOUSEHOLD_LINE_MAX = 300;
const REASON_MAX = 300;
const SHOW_MAX = 1500;
const LIST_TEXT_CLIP = 160;
const LIST_WHY_CLIP = 120;
const SUMMONER_AUTHOR = "summoner";

export const HELP_TEXT = [
  "Commands:",
  "!stop [reason]: pause the Lar's outward acts. The Lar can still answer you.",
  "!resume: lift the pause.",
  "!household: show the household note. !household add <line> adds a line. !household remove <n> removes line n.",
  "!proposals: list the commitments the Lar has proposed.",
  "!approve <id>: agree to one. !decline <id> [reason]: decline it.",
  "!sites: list the sites the Lar may post, log in or make accounts on. !sites add <host> adds one. !sites remove <host> removes one.",
  "!vault: list the names in the Lar's vault, with the host each belongs to (never the values). !vault remove <name> deletes one.",
  "!media: list the newest pictures on the Lar's shelf. !media forget <id> removes one.",
  "!help: this list.",
].join("\n");

const UNKNOWN_TEXT = "I don't know that command. !help lists them.";
const USAGE_HOUSEHOLD = "Use !household, !household add <line>, or !household remove <n>.";
const USAGE_ADD = "Give the line after add: !household add <line>.";
const USAGE_REMOVE = "Give the number of the line: !household remove <n>.";
const USAGE_APPROVE = "Give the id of the commitment: !approve <id>. !proposals lists them.";
const USAGE_DECLINE = "Give the id of the commitment: !decline <id> [reason]. !proposals lists them.";

/** What the summoner's commands need from the runtime. Each method is a plain act; none of them decides anything. */
export type SummonerDesk = {
  /** The Lar's folder, where the stop file lives. */
  dir: string;
  notebook: Notebook;
  /** The entity's zone, if it names one. */
  timeZone: string | undefined;
  nowMs: () => number;
  proposals: () => Proposal[];
  setProposals: (next: Proposal[]) => void;
  /** The shelf of pictures the Lar keeps. */
  pictures: Shelf;
  /** Writes one body row in the self thread: what the summoner did, in plain words. */
  record: (text: string) => void;
  /** Called after the stop file changed, so the runtime does not report the same change twice. */
  stopChanged: () => void;
};

/** The words the body answers as commands. Any other "!" line is an ordinary message to the Lar. */
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "stop",
  "resume",
  "household",
  "proposals",
  "approve",
  "decline",
  "sites",
  "vault",
  "media",
  "help",
]);

/** True when a summoner message is a known body command: "!" and its command word. Other "!" lines are ordinary words. */
export function isSummonerCommand(text: string | undefined): boolean {
  const match = /^!([a-zA-Z]+)/.exec((text ?? "").trimStart());
  return match !== null && COMMAND_WORDS.has((match[1] ?? "").toLowerCase());
}

/** Runs one summoner command and returns the words to answer with (without the prefix). */
export async function answerSummoner(text: string, desk: SummonerDesk): Promise<string> {
  const { word, rest } = parseCommand(text);
  switch (word) {
    case "stop":
      return stopOn(rest, desk);
    case "resume":
      return resume(desk);
    case "household":
      return household(rest, desk);
    case "proposals":
      return proposals(desk);
    case "approve":
      return approve(rest, desk);
    case "decline":
      return decline(rest, desk);
    case "sites":
      return sites(rest, desk);
    case "vault":
      return vault(rest, desk);
    case "media":
      return media(rest, desk);
    case "help":
      desk.record("Your summoner asked for the list of commands.");
      return HELP_TEXT;
    default:
      return UNKNOWN_TEXT;
  }
}

function parseCommand(text: string): { word: string; rest: string } {
  const match = /^([a-zA-Z]*)([\s\S]*)$/.exec(text.trim().slice(1));
  return { word: (match?.[1] ?? "").toLowerCase(), rest: (match?.[2] ?? "").trim() };
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

function dayOf(ms: number, timeZone: string | undefined): string {
  return dayKey(ms, timeZone);
}

/** Writes a notebook note as the summoner. Returns the plain reason it failed, or undefined when it was written. */
async function writeNote(desk: SummonerDesk, path: string, text: string, reason: string): Promise<string | undefined> {
  try {
    await desk.notebook.write(path, text, reason, SUMMONER_AUTHOR);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// --- the stop ---------------------------------------------------------------------------------

function stopOn(rest: string, desk: SummonerDesk): string {
  const reason = clip(oneLine(rest), REASON_MAX);
  writeStop(desk.dir, reason === "" ? undefined : reason);
  desk.stopChanged();
  const why = reason === "" ? "" : ` Reason: ${reason}`;
  desk.record(`Your summoner turned on the emergency stop: outward acts are paused.${why}`);
  return `Emergency stop is on. The Lar's outward acts are paused; the Lar can still answer you.${why}`;
}

function resume(desk: SummonerDesk): string {
  if (clearStop(desk.dir)) {
    desk.stopChanged();
    desk.record("Your summoner turned off the emergency stop: outward acts can go on again.");
    return "Emergency stop is off. The Lar's outward acts can go on again.";
  }
  desk.record("Your summoner tried to turn off the emergency stop, but it was not on.");
  return "The emergency stop was not on.";
}

// --- the household ----------------------------------------------------------------------------

async function household(rest: string, desk: SummonerDesk): Promise<string> {
  const [sub, ...tail] = words(rest);
  if (sub === undefined) {
    desk.record("Your summoner read the household note.");
    return clip(`Household note:\n${householdForSummoner(desk.notebook.read(HOUSEHOLD_PATH))}`, SHOW_MAX);
  }
  if (sub.toLowerCase() === "add") return addHouseholdLine(oneLine(tail.join(" ")), desk);
  if (sub.toLowerCase() === "remove") return removeHouseholdLine(tail[0], desk);
  return USAGE_HOUSEHOLD;
}

async function addHouseholdLine(line: string, desk: SummonerDesk): Promise<string> {
  if (line === "") return USAGE_ADD;
  if (Array.from(line).length > HOUSEHOLD_LINE_MAX) {
    desk.record("Your summoner tried to add a household line that is too long, so nothing was added.");
    return `A household line is at most ${HOUSEHOLD_LINE_MAX} characters. Nothing was added.`;
  }
  const next = withHouseholdLine(desk.notebook.read(HOUSEHOLD_PATH), line);
  const failed = await writeNote(desk, HOUSEHOLD_PATH, next.text, "Summoner added a household line");
  if (failed !== undefined) return `The household note could not be saved: ${failed}`;
  desk.record(`Your summoner added a line to your household note: ${line}`);
  return `Added to the household note as line ${next.count}.`;
}

async function removeHouseholdLine(arg: string | undefined, desk: SummonerDesk): Promise<string> {
  if (arg === undefined || !/^[0-9]+$/.test(arg) || Number(arg) < 1) return USAGE_REMOVE;
  const n = Number(arg);
  const cut = withoutHouseholdLine(desk.notebook.read(HOUSEHOLD_PATH), n);
  if (cut === undefined) {
    desk.record(`Your summoner tried to remove household line ${n}, which is not there.`);
    return `There is no household line ${n}. !household shows the lines.`;
  }
  const failed = await writeNote(desk, HOUSEHOLD_PATH, cut.text, "Summoner removed a household line");
  if (failed !== undefined) return `The household note could not be saved: ${failed}`;
  desk.record(`Your summoner removed a line from your household note: ${cut.removed}`);
  return `Removed household line ${n}.`;
}

// --- the web's sites and vault ----------------------------------------------------------------

const USAGE_SITES = "Use !sites, !sites add <host>, or !sites remove <host>.";
const USAGE_SITE_HOST = "Give one host name, such as example.org: !sites add <host> or !sites remove <host>.";
const USAGE_VAULT = "Use !vault, or !vault remove <name>.";
const USAGE_VAULT_NAME = "Give the name of the vault value: !vault remove <name>. !vault lists the names.";

function plainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sites(rest: string, desk: SummonerDesk): string {
  const [sub, ...tail] = words(rest);
  if (sub === undefined) return sitesList(desk);
  if (sub.toLowerCase() === "add") return addSite(tail, desk);
  if (sub.toLowerCase() === "remove") return removeSite(tail, desk);
  return USAGE_SITES;
}

function sitesList(desk: SummonerDesk): string {
  desk.record("Your summoner read the list of sites you may post, log in or make accounts on.");
  let file: WebFile | undefined;
  try {
    file = loadWebFile(desk.dir);
  } catch (error) {
    return `${WEB_FILE} is damaged: ${plainError(error)} Nothing was changed.`;
  }
  if (file === undefined) {
    return `The web is off: there is no ${WEB_FILE} in the Lar's folder. !sites add <host> creates it, and the web starts when the Lar next starts.`;
  }
  const listed = file.sites.length > 0 ? file.sites.join(", ") : "none yet";
  return `Sites the Lar may post, log in or make accounts on: ${listed}. Ceiling: ${file.perHour} web requests an hour.`;
}

/** Writes the sites file as the summoner's act; a failure is returned as plain words, never thrown. */
function writeSites(desk: SummonerDesk, sites: string[], perHour?: number): string | undefined {
  try {
    saveWebFile(desk.dir, perHour === undefined ? { sites } : { sites, perHour });
    return undefined;
  } catch (error) {
    return plainError(error);
  }
}

function addSite(tail: string[], desk: SummonerDesk): string {
  if (tail.length !== 1) return USAGE_SITE_HOST;
  const host = normalizeHost(tail[0] ?? "");
  if (host === undefined) return `"${tail[0] ?? ""}" is not a host name. Give the bare host, such as example.org.`;
  let file: WebFile | undefined;
  try {
    file = loadWebFile(desk.dir);
  } catch (error) {
    return `${WEB_FILE} is damaged: ${plainError(error)} Nothing was changed.`;
  }
  if (file === undefined) {
    const failed = writeSites(desk, [host]);
    if (failed !== undefined) return `${WEB_FILE} could not be written: ${failed}`;
    desk.record(`Your summoner added ${host} to the sites you may post, log in or make accounts on. The web starts when you next start.`);
    return `Created ${WEB_FILE} with ${host}. The web starts when the Lar next starts.`;
  }
  if (file.sites.includes(host)) return `${host} is already listed.`;
  if (file.sites.length >= WEB_SITES_MAX) return `The list is full: at most ${WEB_SITES_MAX} sites. Nothing was added.`;
  const failed = writeSites(desk, [...file.sites, host], file.perHour);
  if (failed !== undefined) return `${WEB_FILE} could not be written: ${failed}`;
  desk.record(`Your summoner added ${host} to the sites you may post, log in or make accounts on.`);
  return `Added ${host}. The Lar may now post, log in or make accounts there.`;
}

function removeSite(tail: string[], desk: SummonerDesk): string {
  if (tail.length !== 1) return USAGE_SITE_HOST;
  const host = normalizeHost(tail[0] ?? "");
  if (host === undefined) return `"${tail[0] ?? ""}" is not a host name. Give the bare host, such as example.org.`;
  let file: WebFile | undefined;
  try {
    file = loadWebFile(desk.dir);
  } catch (error) {
    return `${WEB_FILE} is damaged: ${plainError(error)} Nothing was changed.`;
  }
  if (file === undefined || !file.sites.includes(host)) {
    desk.record(`Your summoner tried to remove ${host} from the sites you may post, log in or make accounts on, but it was not listed.`);
    return `${host} is not listed. !sites shows the list.`;
  }
  const failed = writeSites(desk, file.sites.filter((site) => site !== host), file.perHour);
  if (failed !== undefined) return `${WEB_FILE} could not be written: ${failed}`;
  desk.record(`Your summoner removed ${host} from the sites you may post, log in or make accounts on.`);
  return `Removed ${host}. The Lar can no longer post, log in or make accounts there.`;
}

function vault(rest: string, desk: SummonerDesk): string {
  const [sub, ...tail] = words(rest);
  if (sub === undefined) return vaultList(desk);
  if (sub.toLowerCase() === "remove") return removeVault(tail, desk);
  return USAGE_VAULT;
}

function vaultList(desk: SummonerDesk): string {
  desk.record("Your summoner looked at the names in your vault.");
  let entries: ReturnType<typeof readVault>;
  try {
    entries = readVault(desk.dir);
  } catch (error) {
    return `The vault is damaged: ${plainError(error)}`;
  }
  const names = Object.keys(entries).sort();
  if (names.length === 0) return "The vault is empty.";
  const listed = names.map((name) => `${name} (${entries[name]?.host ?? "unknown host"})`).join(", ");
  return `Vault names, with the host each belongs to (values are never shown): ${listed}.`;
}

function removeVault(tail: string[], desk: SummonerDesk): string {
  if (tail.length !== 1) return USAGE_VAULT_NAME;
  const name = tail[0] ?? "";
  if (!validVaultName(name)) return "A vault name is letters, digits, dots, dashes and underscores, up to 48 characters.";
  let removed: boolean;
  try {
    removed = removeVaultEntry(desk.dir, name);
  } catch (error) {
    return `The vault value could not be removed: ${plainError(error)}`;
  }
  if (!removed) {
    desk.record(`Your summoner tried to remove the vault value named ${name}, which is not there.`);
    return `There is no vault value named ${name}. !vault lists the names.`;
  }
  desk.record(`Your summoner removed the vault value named ${name}. You can no longer send it with auth.`);
  return `Removed the vault value named ${name}. The Lar can no longer send it.`;
}

// --- the shelf of pictures --------------------------------------------------------------------

const USAGE_MEDIA = "Use !media to list the newest pictures, or !media forget <id> to remove one.";
const USAGE_FORGET = "Give the picture's id: !media forget <id>. !media lists them.";
const MEDIA_LIST = 10;

function media(rest: string, desk: SummonerDesk): string {
  const [sub, ...tail] = words(rest);
  if (sub === undefined) return mediaList(desk);
  if (sub.toLowerCase() === "forget") return forgetPicture(tail, desk);
  return USAGE_MEDIA;
}

function mediaList(desk: SummonerDesk): string {
  desk.record("Your summoner looked at the pictures on your shelf.");
  const pictures = desk.pictures.list();
  if (pictures.length === 0) return "Your shelf of pictures is empty.";
  const lines = pictures.slice(0, MEDIA_LIST).map((item) => {
    const when = new Date(item.atMs).toISOString().slice(0, 16).replace("T", " ");
    return `- ${item.id}: ${clip(item.name, LIST_TEXT_CLIP)} (${Math.ceil(item.bytes / 1024)} KB, from ${item.from.place}, ${when} UTC)`;
  });
  const more = pictures.length > MEDIA_LIST ? `\n...and ${pictures.length - MEDIA_LIST} more on the shelf.` : "";
  return ["The newest pictures on your shelf:", ...lines].join("\n") + more;
}

function forgetPicture(tail: string[], desk: SummonerDesk): string {
  const id = tail[0];
  if (tail.length !== 1 || id === undefined || !isPictureId(id)) return USAGE_FORGET;
  if (!desk.pictures.forget(id)) {
    desk.record(`Your summoner tried to remove the picture ${id}, which is not on your shelf.`);
    return `There is no picture ${id} on your shelf. !media lists them.`;
  }
  desk.record(`Your summoner removed the picture ${id} from your shelf.`);
  return `Removed the picture ${id} from your shelf.`;
}

// --- the Lar's proposed commitments -----------------------------------------------------------

function proposals(desk: SummonerDesk): string {
  desk.record("Your summoner looked at the commitments you proposed.");
  const waiting = desk.proposals();
  if (waiting.length === 0) return "No commitments are waiting for an answer.";
  const lines = waiting.map(
    (item) => `- ${item.id}: ${clip(item.text, LIST_TEXT_CLIP)}\n  why: ${clip(item.why, LIST_WHY_CLIP)}`,
  );
  return ["Waiting for an answer:", ...lines].join("\n");
}

async function approve(rest: string, desk: SummonerDesk): Promise<string> {
  const id = words(rest)[0];
  if (id === undefined) return USAGE_APPROVE;
  const item = desk.proposals().find((candidate) => candidate.id === id);
  if (item === undefined) {
    desk.record(`Your summoner tried to agree to proposal ${id}, which is not waiting.`);
    return `No commitment is waiting with the id ${id}. !proposals lists them.`;
  }
  const now = desk.nowMs();
  const zone = desk.timeZone ?? hostZone();
  const block = commitmentBlock(item, dayOf(item.atMs, zone), dayOf(now, zone));
  const next = withCommitment(desk.notebook.read(COMMITMENTS_PATH), block);
  const failed = await writeNote(desk, COMMITMENTS_PATH, next, "Summoner agreed to a commitment");
  if (failed !== undefined) return `The commitment could not be saved: ${failed}`;
  desk.setProposals(desk.proposals().filter((candidate) => candidate.id !== id));
  desk.record(`Your summoner agreed to your proposed commitment ${id}: ${item.text}`);
  return "Agreed. The commitment is now kept with the Lar's commitments.";
}

function decline(rest: string, desk: SummonerDesk): string {
  const id = words(rest)[0];
  if (id === undefined) return USAGE_DECLINE;
  const reason = clip(oneLine(rest.trim().slice(id.length)), REASON_MAX);
  const item = desk.proposals().find((candidate) => candidate.id === id);
  if (item === undefined) {
    desk.record(`Your summoner tried to decline proposal ${id}, which is not waiting.`);
    return `No commitment is waiting with the id ${id}. !proposals lists them.`;
  }
  desk.setProposals(desk.proposals().filter((candidate) => candidate.id !== id));
  const why = reason === "" ? "" : ` Reason: ${reason}`;
  desk.record(`Your summoner declined your proposed commitment ${id}: ${item.text}${why}`);
  return "Declined. Nothing was written into the commitments.";
}
