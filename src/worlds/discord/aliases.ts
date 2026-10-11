// Aliases: the only place Discord ids are kept. Everything the entity reads or writes uses an alias:
// the owner is "owner", people are slugs of their display name ("mara", "mara-2"), rooms are slugs of the
// channel name ("room:general"), and direct messages are "dm:<person>". The file is written atomically and
// never silently reset: a damaged file stops the world, because a reset would rename everyone.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const OWNER_ALIAS = "owner";
/** The alias file's name in the Lar's folder. Platform ids are kept only here and in the contacts file. */
export const DISCORD_ALIASES_FILE = "discord-aliases.json";
const ALIAS_MAX_CHARS = 32;

export type AliasStore = {
  /** The owner is always "owner". Anyone else gets a slug of their name, assigned once and kept. */
  userAlias(userId: string, displayName: string): string;
  /** The alias already assigned to a person, or null. Never assigns. */
  knownUserAlias(userId: string): string | null;
  /** The platform user id behind an alias. "owner" resolves to the configured owner. */
  userIdForAlias(alias: string): string | null;
  /** The room slug for a channel ("general"), assigned once and kept. The place is "room:<slug>". */
  roomAlias(channelId: string, channelName: string): string;
  /** The channel id behind a room slug, or null. */
  channelIdForRoom(slug: string): string | null;
};

type AliasFile = {
  version: 1;
  users: Record<string, string>;
  rooms: Record<string, string>;
};

/** Lowercase, accents removed, letters and digits joined by hyphens. Falls back when nothing is left. */
export function slugify(name: string, fallback: string): string {
  const joined = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const capped = Array.from(joined).slice(0, ALIAS_MAX_CHARS).join("").replace(/-+$/g, "");
  return capped || fallback;
}

function readFile(path: string): AliasFile {
  if (!existsSync(path)) return { version: 1, users: {}, rooms: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Discord aliases file is not valid JSON: ${path}. Move it aside to start fresh; it is not reset here.`);
  }
  const candidate = parsed as { users?: unknown; rooms?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null || !isStringMap(candidate.users) || !isStringMap(candidate.rooms)) {
    throw new Error(`Discord aliases file has an unexpected shape: ${path}. Move it aside to start fresh.`);
  }
  return { version: 1, users: { ...candidate.users }, rooms: { ...candidate.rooms } };
}

/**
 * The people the alias file names, as platform id to alias, read without a store. A missing file names nobody; a damaged
 * one throws, like the store does. For the body's commands, which need a name for an id and never an id for a name they
 * have not been given.
 */
export function readUserAliases(path: string): Record<string, string> {
  return existsSync(path) ? readFile(path).users : {};
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((alias) => typeof alias === "string" && alias.length > 0);
}

function writeFileAtomic(path: string, file: AliasFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/** A unique alias: the base, then base-2, base-3 ... Never reuses a taken one. */
function uniqueAlias(base: string, reserved: ReadonlySet<string>, taken: ReadonlyMap<string, string>): string {
  let candidate = base;
  let n = 2;
  while (reserved.has(candidate) || taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export function createAliasStore(options: { path: string; ownerUserId: string; ownerAlias?: string }): AliasStore {
  const { path, ownerUserId } = options;
  const ownerAlias = options.ownerAlias ?? OWNER_ALIAS;
  const reserved = new Set([ownerAlias, "you"]);
  const file = readFile(path);

  const userAliasById = new Map<string, string>(Object.entries(file.users));
  const userIdByAlias = new Map<string, string>();
  for (const [id, alias] of userAliasById) userIdByAlias.set(alias, id);

  const roomAliasById = new Map<string, string>(Object.entries(file.rooms));
  const channelIdByRoom = new Map<string, string>();
  for (const [id, slug] of roomAliasById) channelIdByRoom.set(slug, id);

  const save = (): void => {
    writeFileAtomic(path, {
      version: 1,
      users: Object.fromEntries(userAliasById),
      rooms: Object.fromEntries(roomAliasById),
    });
  };

  return {
    userAlias(userId, displayName) {
      if (userId === ownerUserId) return ownerAlias;
      const known = userAliasById.get(userId);
      if (known) return known;
      const alias = uniqueAlias(slugify(displayName, "person"), reserved, userIdByAlias);
      userAliasById.set(userId, alias);
      userIdByAlias.set(alias, userId);
      save();
      return alias;
    },
    knownUserAlias(userId) {
      if (userId === ownerUserId) return ownerAlias;
      return userAliasById.get(userId) ?? null;
    },
    userIdForAlias(alias) {
      if (alias === ownerAlias) return ownerUserId;
      return userIdByAlias.get(alias) ?? null;
    },
    roomAlias(channelId, channelName) {
      const known = roomAliasById.get(channelId);
      if (known) return known;
      const slug = uniqueAlias(slugify(channelName, "room"), new Set(), channelIdByRoom);
      roomAliasById.set(channelId, slug);
      channelIdByRoom.set(slug, channelId);
      save();
      return slug;
    },
    channelIdForRoom(slug) {
      return channelIdByRoom.get(slug) ?? null;
    },
  };
}
