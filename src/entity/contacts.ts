// The contacts: the people, besides the summoner, who may write to the Lar in a direct message. The summoner's
// !contacts commands write contacts.json in the Lar's folder, whole and atomically; each world reads it live. Platform
// user ids live only in this file and in the world's alias file, never in the Lar's river or notebook. A missing file
// is no contacts. A damaged file is no contacts too, and the problem is kept so the body can say so.
//
// File shape: { "version": 1, "discord": ["<user id>", ...] }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONTACTS_FILE = "contacts.json";
const ROOT_KEYS = ["version", "discord"] as const;
const ID_PATTERN = /^[0-9]{1,32}$/;
const MENTION_PATTERN = /^<@!?([0-9]{1,32})>$/;

export type Contacts = { version: 1; discord: string[] };
export type ContactsLoad = { contacts: Contacts; problem?: string };

/** Checks an already-parsed contacts file. Throws a plain error naming the first wrong part. */
export function parseContacts(value: unknown): Contacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the file must be an object");
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!(ROOT_KEYS as readonly string[]).includes(key)) throw new Error(`unknown field "${key}"`);
  }
  if (root["version"] !== 1) throw new Error('"version" must be 1');
  const listed = root["discord"];
  if (!Array.isArray(listed)) throw new Error('"discord" must be a list');
  const discord: string[] = [];
  listed.forEach((item, index) => {
    if (typeof item !== "string" || !ID_PATTERN.test(item)) throw new Error(`discord[${index}] must be a user id`);
    if (discord.includes(item)) throw new Error(`discord[${index}] is listed twice`);
    discord.push(item);
  });
  return { version: 1, discord };
}

/** Reads the contacts file. Missing is no contacts with no problem; anything else wrong is no contacts plus a problem. */
export function readContacts(path: string): ContactsLoad {
  const none: Contacts = { version: 1, discord: [] };
  if (!existsSync(path)) return { contacts: none };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The parser's message can quote the file, and the file holds the ids, so only the fact is kept.
    return { contacts: none, problem: "the file is not valid JSON" };
  }
  try {
    return { contacts: parseContacts(parsed) };
  } catch (error) {
    return { contacts: none, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes the contacts file whole: a temporary file, then a rename over the old one. */
export function writeContacts(path: string, contacts: Contacts): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(contacts, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/** The user id a Discord mention names (<@id> or <@!id>), or undefined when the text is not exactly one mention. */
export function mentionedUserId(text: string): string | undefined {
  return MENTION_PATTERN.exec(text.trim())?.[1];
}
