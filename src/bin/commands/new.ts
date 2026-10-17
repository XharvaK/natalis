// `natalis new --dir <folder> --summoner <alias>` makes the folder a new Lar is born from: an entity.json and DESIGN.md,
// the form for designing it (templates/lar/LAR_TEMPLATE.md). Nothing else. The Lar is not opened: its first start is its
// birth, when the notebook, river and birth date are made. What only the summoner can answer (which model, at which
// address) is left as the FILL-ME blank unless a flag gives it, and a Lar with a blank left will not start.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITY_FILE, FILL_ME } from "../../entity/config.js";
import { flagValue } from "./args.js";

export const NEW_USAGE =
  "Usage: natalis new --dir <new folder> --summoner <your alias> [--name <the Lar's name>] [--time-zone <IANA zone>] " +
  "[--base-url <https://...>] [--model <model name>] [--key-env <VARIABLE>] [--context-tokens <n>]";
/** The design form, as the new folder holds it. */
export const DESIGN_FILE = "DESIGN.md";
/** The form in the repository: from dist/bin/commands or src/bin/commands, three levels up is the checkout. */
export const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", "lar", "LAR_TEMPLATE.md");

const NAME_LIMIT = 40;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export type NewLarOptions = {
  dir: string;
  summoner: string;
  name?: string;
  timeZone?: string;
  baseUrl?: string;
  model?: string;
  keyEnv?: string;
  contextTokens?: number;
};

/** Writes the new folder. Throws a plain error when the folder already holds a Lar, or an option is wrong. Returns the blanks left. */
export function newLar(options: NewLarOptions): { blanks: string[] } {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty. A new Lar starts in an empty folder, so nothing that is there is overwritten.`);
  }
  const summoner = options.summoner.trim();
  if (summoner === "") throw new Error("Give your alias with --summoner: the name the Lar will know you by.");
  const name = options.name?.trim();
  if (name !== undefined && (name === "" || Array.from(name).length > NAME_LIMIT)) {
    throw new Error(`A name is 1 to ${NAME_LIMIT} characters. Leave --name out to let the Lar choose its own.`);
  }
  const keyEnv = options.keyEnv ?? `${envStem(basename(dir))}_MODEL_KEY`;
  if (!ENV_NAME.test(keyEnv)) throw new Error(`--key-env names an environment variable, such as JUNIPER_MODEL_KEY; "${keyEnv}" is not one.`);
  if (options.contextTokens !== undefined && !(Number.isSafeInteger(options.contextTokens) && options.contextTokens > 0)) {
    throw new Error("--context-tokens is a whole number of tokens, such as 128000.");
  }

  const entity = {
    ...(name === undefined ? {} : { name }),
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: {
      baseUrl: options.baseUrl ?? FILL_ME,
      model: options.model ?? FILL_ME,
      apiKeyEnv: keyEnv,
      contextTokens: options.contextTokens ?? FILL_ME,
    },
    summoner: { alias: summoner },
  };
  const blanks = Object.entries(entity.model)
    .filter(([, value]) => value === FILL_ME)
    .map(([key]) => `model.${key}`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ENTITY_FILE), `${JSON.stringify(entity, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, DESIGN_FILE), readFileSync(TEMPLATE_PATH, "utf8"), "utf8");
  return { blanks };
}

/** The folder name as the stem of an environment variable name: "my-lar" gives MY_LAR. */
function envStem(folder: string): string {
  const stem = folder.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return stem === "" || /^[0-9]/.test(stem) ? `LAR_${stem}`.replace(/_+$/, "") : stem;
}

export async function newCommand(args: readonly string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const dir = flagValue(args, "--dir");
  const summoner = flagValue(args, "--summoner");
  if (dir === undefined || dir.trim() === "" || summoner === undefined) {
    err(NEW_USAGE);
    return 2;
  }
  const tokens = flagValue(args, "--context-tokens");
  const options: NewLarOptions = { dir, summoner };
  const name = flagValue(args, "--name");
  const timeZone = flagValue(args, "--time-zone");
  const baseUrl = flagValue(args, "--base-url");
  const model = flagValue(args, "--model");
  const keyEnv = flagValue(args, "--key-env");
  if (name !== undefined) options.name = name;
  if (timeZone !== undefined) options.timeZone = timeZone;
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
  if (model !== undefined) options.model = model;
  if (keyEnv !== undefined) options.keyEnv = keyEnv;
  if (tokens !== undefined) options.contextTokens = Number(tokens);
  try {
    const { blanks } = newLar(options);
    const folder = resolve(dir);
    out(`Made ${folder}: ${ENTITY_FILE} and ${DESIGN_FILE}.`);
    if (blanks.length > 0) out(`Still to fill in ${ENTITY_FILE}: ${blanks.join(", ")}.`);
    out(`Next: fill in ${DESIGN_FILE}, copy each answer into the file it names, then run natalis check --dir ${folder}.`);
    out("The Lar is born on its first start (natalis chat or natalis run), not before.");
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
