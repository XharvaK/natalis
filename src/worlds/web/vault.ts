// The vault: the values the Lar keeps for the web (a key a site showed once, a token). One file per name in
// <entity>/vault/, named <name>.json, holding {"host": "<host>", "value": "<value>"}. Each entry is bound to the host
// it came from: auth sends it only to that host (or its subdomains), and only auth ever sends a value out. Every value
// is registered with the secret scanner, so it cannot reach the model, the river, the notebook or a say.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VAULT_DIR = "vault";
const VAULT_NAME = /^[A-Za-z0-9_.-]{1,48}$/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type VaultEntry = { host: string; value: string };

/** A name the vault accepts: letters, digits, dot, dash, underscore; up to 48; not "." or ".."; no Windows device names. */
export function validVaultName(name: string): boolean {
  return VAULT_NAME.test(name) && !name.endsWith(".") && !RESERVED_DEVICE.test(name);
}

/**
 * Whether a request host may receive a vault entry bound to another host. One leading "www." is ignored on both
 * sides; the hosts match when they are equal or one is a subdomain of the other.
 */
export function hostsMatch(requestHost: string, boundHost: string): boolean {
  const a = stripWww(requestHost.toLowerCase().replace(/\.+$/, ""));
  const b = stripWww(boundHost.toLowerCase().replace(/\.+$/, ""));
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function vaultPath(dir: string): string {
  return join(dir, VAULT_DIR);
}

function entryFile(dir: string, name: string): string {
  return join(vaultPath(dir), `${name}.json`);
}

/** Names of the entries in the vault, sorted. Files that are not a valid entry name are not part of the vault. */
export function vaultNames(dir: string): string[] {
  const folder = vaultPath(dir);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter(validVaultName)
    .sort();
}

function parseEntry(name: string, text: string): VaultEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`The vault entry ${name} is damaged.`);
  }
  const entry = parsed as { host?: unknown; value?: unknown } | null;
  if (typeof entry !== "object" || entry === null || typeof entry.host !== "string" || typeof entry.value !== "string") {
    throw new Error(`The vault entry ${name} is damaged.`);
  }
  return { host: entry.host, value: entry.value };
}

/** One entry, or undefined when there is no entry of that name. A damaged entry is an error, never an empty value. */
export function readVaultEntry(dir: string, name: string): VaultEntry | undefined {
  if (!validVaultName(name)) return undefined;
  const file = entryFile(dir, name);
  if (!existsSync(file)) return undefined;
  return parseEntry(name, readFileSync(file, "utf8"));
}

/** Every entry in the vault, by name. Throws if any entry cannot be read. */
export function readVault(dir: string): Record<string, VaultEntry> {
  const entries: Record<string, VaultEntry> = {};
  for (const name of vaultNames(dir)) {
    const entry = readVaultEntry(dir, name);
    if (entry !== undefined) entries[name] = entry;
  }
  return entries;
}

/** Writes one entry whole: a temporary file in the vault folder, then a rename over the old one. Mode 0600 where the platform has modes. */
export function keepVaultEntry(dir: string, name: string, entry: VaultEntry): void {
  if (!validVaultName(name)) throw new Error("A vault name is letters, digits, dots, dashes and underscores, up to 48 characters.");
  const folder = vaultPath(dir);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = entryFile(dir, name);
  // The temporary name has a "~", which no vault name may hold, so a leftover is never listed as an entry.
  const temp = join(folder, `~tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, JSON.stringify({ host: entry.host, value: entry.value }), { mode: 0o600 });
  renameSync(temp, file);
}

/** Deletes one entry. Returns false when there was no entry of that name. */
export function removeVaultEntry(dir: string, name: string): boolean {
  if (!validVaultName(name)) return false;
  const file = entryFile(dir, name);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
