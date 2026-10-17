// `natalis check --dir <entity folder>` reads every file of a Lar's folder the way its body will, and names what is wrong
// before a start finds it. It writes nothing and opens nothing: no river, no notebook, no model call, no world. A line
// starts with "ok", "fix" (the Lar would not start, or a world or the privacy list would not work) or "note" (worth
// knowing, nothing wrong). The exit code is 1 when there is something to fix. Ids, tokens and privacy terms are never
// printed: only file names, field names and counts.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENTITY_FILE, loadEntityConfig, type EntityConfig } from "../../entity/config.js";
import { CONTACTS_FILE, readContacts } from "../../entity/contacts.js";
import { NATURE_FILE, readNature } from "../../entity/nature.js";
import { PRIVACY_FILE, readPrivacyFile } from "../../entity/privacy.js";
import { WELCOME_FILE } from "../../entity/runtime.js";
import { DOMUS_FILE, parseDomusFile } from "../../worlds/domus/index.js";
import { parseSandboxFile, SANDBOX_FILE } from "../../worlds/sandbox/index.js";
import { loadWebFile, WEB_FILE } from "../../worlds/web/index.js";
import { flagValue } from "./args.js";
import { DISCORD_FILE, parseDiscordFile } from "./discord-file.js";

export const CHECK_USAGE = "Usage: natalis check --dir <entity folder>";
/** The length the design form asks of a nature, in words. Outside it is a note, never a fault. */
export const NATURE_WORDS = { min: 150, max: 400 } as const;

export type CheckLine = { level: "ok" | "fix" | "note"; text: string };

/** Every finding for the folder, in file order. */
export function checkLar(dir: string, env: Readonly<Record<string, string | undefined>> = process.env): CheckLine[] {
  const lines: CheckLine[] = [];
  const ok = (text: string): void => void lines.push({ level: "ok", text });
  const fix = (text: string): void => void lines.push({ level: "fix", text });
  const note = (text: string): void => void lines.push({ level: "note", text });
  const keySet = (name: string): boolean => (env[name] ?? "") !== "";

  let config: EntityConfig | undefined;
  try {
    config = loadEntityConfig(dir);
    const name = config.name === undefined ? "no name (the Lar chooses its own)" : `named ${config.name}`;
    ok(`${ENTITY_FILE}: ${name}, summoner ${config.owner.alias}, model ${config.model.model}.`);
  } catch (error) {
    fix(messageOf(error));
  }
  if (config?.model.apiKeyEnv !== undefined && !keySet(config.model.apiKeyEnv)) {
    note(`${config.model.apiKeyEnv} (the model key) is not set in this shell. A service reads it from the Lar's env file.`);
  }

  const nature = readNature(dir);
  if (nature.problem !== undefined) fix(`${NATURE_FILE}: ${nature.problem}; the default nature would be used.`);
  else if (!existsSync(join(dir, NATURE_FILE))) note(`${NATURE_FILE}: none, so the default nature is used.`);
  else if (nature.text === undefined) note(`${NATURE_FILE} is empty, so the Lar has no nature section at all.`);
  else {
    const words = nature.text.split(/\s+/).filter(Boolean).length;
    const within = words >= NATURE_WORDS.min && words <= NATURE_WORDS.max;
    (within ? ok : note)(`${NATURE_FILE}: ${words} words${within ? "." : `; the design form suggests ${NATURE_WORDS.min} to ${NATURE_WORDS.max}.`}`);
  }

  const privacy = readPrivacyFile(join(dir, PRIVACY_FILE));
  if (privacy.problem !== undefined) fix(`${PRIVACY_FILE}: ${privacy.problem}. While it is broken, everything the Lar says outward is held.`);
  else if (existsSync(join(dir, PRIVACY_FILE))) {
    ok(`${PRIVACY_FILE}: ${privacy.list.terms.length} terms in ${privacy.list.categories.length} categories.`);
    const unnamed = privacy.list.terms.filter((term) => !privacy.list.categories.includes(term.category)).length;
    if (unnamed > 0) note(`${PRIVACY_FILE}: ${unnamed} terms name a category the categories list does not.`);
  }

  const contacts = readContacts(join(dir, CONTACTS_FILE));
  if (contacts.problem !== undefined) fix(`${CONTACTS_FILE}: ${contacts.problem}. Until it is fixed only the summoner can write to the Lar directly.`);
  else if (existsSync(join(dir, CONTACTS_FILE))) {
    ok(`${CONTACTS_FILE}: ${contacts.contacts.discord.length} Discord contacts. A Lar listed here needs this one in its own contacts too.`);
  }

  const welcome = join(dir, WELCOME_FILE);
  if (existsSync(welcome) && readFileSync(welcome, "utf8").trim() !== "") ok(`${WELCOME_FILE}: sent once, to the summoner, on the first start.`);

  let worlds = 0;
  const world = (file: string, read: (value: unknown) => string, keyEnv?: (value: unknown) => string | undefined): void => {
    const path = join(dir, file);
    if (!existsSync(path)) return;
    worlds += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      // The parser's message can quote the file, and a world file holds ids, so only the fact is kept.
      fix(`${file} is not valid JSON.`);
      return;
    }
    try {
      ok(`${file}: ${read(parsed)}`);
      const name = keyEnv?.(parsed);
      if (name !== undefined && !keySet(name)) note(`${name} (named in ${file}) is not set in this shell. A service reads it from the Lar's env file.`);
    } catch (error) {
      fix(`${file}: ${messageOf(error)}`);
    }
  };
  world(
    DISCORD_FILE,
    (value) => `Discord, ${parseDiscordFile(value).rooms.length} rooms.`,
    (value) => parseDiscordFile(value).tokenEnv,
  );
  world(SANDBOX_FILE, (value) => `the sandbox, network ${parseSandboxFile(value).network ?? "wall"}.`);
  world(WEB_FILE, () => {
    const web = loadWebFile(dir);
    return `the web, ${web?.sites.length ?? 0} sites.`;
  });
  world(
    DOMUS_FILE,
    (value) => `Domus, port ${parseDomusFile(value).port ?? 3711}.`,
    (value) => parseDomusFile(value).tokenEnv,
  );
  if (worlds === 0) note("No world file: natalis run needs at least one (discord.json, sandbox.json, web.json, domus.json); natalis chat works without.");

  if (existsSync(join(dir, "river.db"))) note("This Lar is already born (it has a river). A file edit reaches it on its next turn or restart.");
  return lines;
}

export async function checkCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const dirArg = flagValue(args, "--dir");
  if (dirArg === undefined || dirArg.trim() === "") {
    err(CHECK_USAGE);
    return 2;
  }
  const dir = resolve(dirArg);
  if (!existsSync(dir)) {
    err(`There is no folder at ${dir}.`);
    return 1;
  }
  const lines = checkLar(dir);
  for (const line of lines) out(`${line.level.padEnd(4)} ${line.text}`);
  const fixes = lines.filter((line) => line.level === "fix").length;
  out(fixes === 0 ? "Nothing to fix." : `${fixes} to fix.`);
  return fixes === 0 ? 0 : 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
