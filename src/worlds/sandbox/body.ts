// The Lar's body, read-only: the Natalis checkout it runs from, bound at /body inside the sandbox so it can read its own
// source, docs and git log. The root is found from this code's own location, never from the Lar's folder. The bind is
// refused when the root holds anything that could be a secret: an env file, a vault folder, or a git remote URL with a
// password in it. Nothing else is checked here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the checkout appears inside the sandbox. Read-only: a write fails at the filesystem. */
export const BODY_MOUNT = "/body";

/** The nearest folder at or above `start` that holds a package.json, or undefined when there is none. */
export function packageRootFrom(start: string): string | undefined {
  let folder = resolve(start);
  for (;;) {
    if (existsSync(join(folder, "package.json"))) return folder;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/** The checkout this code runs from: the package root above this file, whether it runs from src or from dist. */
export function defaultBodyRoot(): string | undefined {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)));
}

/** A name that is an env file: `.env`, or anything ending in `.env`, in any letter case. */
export function isEnvFileName(name: string): boolean {
  return /(^|\.)env$/i.test(name);
}

/**
 * Why /body cannot be bound, in plain words for the summoner, or undefined when it can. A checkout that cannot be found
 * refuses the bind as well: the body is on by default, so a missing root must not pass silently.
 */
export function bodyRefusal(root: string | undefined): string | undefined {
  if (root === undefined) {
    return `The Natalis checkout could not be found from its own code, so ${BODY_MOUNT} cannot be bound. Set "body": false in sandbox.json to run without it.`;
  }
  return bodyProblem(root);
}

/**
 * Why the checkout cannot be bound, or undefined when it can. Only the top level of the root is looked at: an env file
 * or a folder named vault there refuses the bind.
 */
function bodyProblem(root: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return `The body folder ${root} could not be read, so ${BODY_MOUNT} cannot be bound. Set "body": false in sandbox.json to run without it.`;
  }
  const envName = names.find(isEnvFileName);
  if (envName !== undefined) {
    return `Not binding ${BODY_MOUNT}: ${root} holds ${envName}, and the body folder must hold no env file, so no secret can be read through it. Move it out, or set "body": false in sandbox.json.`;
  }
  if (names.includes("vault")) {
    return `Not binding ${BODY_MOUNT}: ${root} holds a vault folder, and the vault must never be read through the body. Move it out, or set "body": false in sandbox.json.`;
  }
  if (hasRemoteCredentials(join(root, ".git", "config"))) {
    return `Not binding ${BODY_MOUNT}: a remote in ${root}'s git config carries a user and password in its URL, which the Lar could read there. Use a credential helper or an ssh remote instead, or set "body": false in sandbox.json.`;
  }
  return undefined;
}

/** True when a git config names a remote URL with a password in it, such as https://name:secret@host/repo. */
export function hasRemoteCredentials(configPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  return /^\s*(push)?url\s*=\s*[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/im.test(text);
}
