// The web's list of sites (web.json in the Lar's folder): the hosts where the Lar may post, log in or make accounts,
// and the hourly ceiling on its web requests. Only the summoner's commands write this file. The world reads it fresh
// on every request, so an edit needs no restart; the file's existence decides whether the web world starts at all.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WEB_FILE = "web.json";
export const WEB_PER_HOUR_DEFAULT = 120;
export const WEB_PER_HOUR_MAX = 10_000;
export const WEB_SITES_MAX = 200;
const ALLOWED_FIELDS = ["sites", "perHour"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type WebFile = { sites: string[]; perHour: number };

/**
 * A bare host name the summoner can list: lowercase, no trailing dot, at least two labels, and not an address
 * (a last label of digits only means an IPv4 address). Returns undefined when the text is not such a name.
 */
export function normalizeHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/\.+$/, "");
  if (host.length === 0 || host.length > 253) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  const last = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(last)) return undefined;
  return host;
}

/** True when a host equals a listed site or ends with "." plus one: sub.example.org is listed by example.org. */
export function siteListed(host: string, sites: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  return sites.some((site) => name === site || name.endsWith(`.${site}`));
}

/** Checks an already-parsed web.json. Throws a plain error naming the first wrong field. */
export function parseWebFile(value: unknown): WebFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${WEB_FILE} must be an object.`);
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED_FIELDS.includes(key)) throw new Error(`Unknown field "${key}" in ${WEB_FILE}. Allowed: sites, perHour.`);
  }
  const listed: unknown = "sites" in root ? root["sites"] : [];
  if (!Array.isArray(listed) || listed.length > WEB_SITES_MAX) {
    throw new Error(`${WEB_FILE}: sites must be a list of up to ${WEB_SITES_MAX} host names.`);
  }
  const sites: string[] = [];
  for (const item of listed) {
    const host = typeof item === "string" ? normalizeHost(item) : undefined;
    if (host === undefined || item !== host) {
      throw new Error(`${WEB_FILE}: ${JSON.stringify(item)} is not a host name in lowercase, such as example.org.`);
    }
    if (sites.includes(host)) throw new Error(`${WEB_FILE}: ${host} is listed twice.`);
    sites.push(host);
  }
  const perHour: unknown = "perHour" in root ? root["perHour"] : WEB_PER_HOUR_DEFAULT;
  if (typeof perHour !== "number" || !Number.isInteger(perHour) || perHour < 1 || perHour > WEB_PER_HOUR_MAX) {
    throw new Error(`${WEB_FILE}: perHour must be a whole number from 1 to ${WEB_PER_HOUR_MAX}.`);
  }
  return { sites, perHour };
}

/** The file as it is now: undefined when there is no web.json, a plain error when it cannot be read or is wrong. */
export function loadWebFile(dir: string): WebFile | undefined {
  const path = join(dir, WEB_FILE);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${WEB_FILE} is not valid JSON.`);
  }
  return parseWebFile(parsed);
}

/** Writes web.json whole: a temporary file, then a rename over the old one. */
export function saveWebFile(dir: string, file: { sites: string[]; perHour?: number }): void {
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { sites: file.sites };
  if (file.perHour !== undefined) body["perHour"] = file.perHour;
  const path = join(dir, WEB_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(temp, path);
}
