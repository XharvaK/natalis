// The Lar's body, read-only: the parts of the Natalis checkout it runs from that it may read of its own source and docs,
// bound at /body inside the sandbox. Only an explicit allow-list is bound (BODY_BINDS), each name at the same path under
// /body. Git history, dist, node_modules and every other top-level name stay out. The root is found from this code's own
// location, never from the Lar's folder. The bind is refused when the Lar's folder lies inside the checkout, or when an
// allow-listed folder holds an env file or a vault folder at any depth, so no secret can be read through it.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the checkout appears inside the sandbox. Read-only: a write fails at the filesystem. */
export const BODY_MOUNT = "/body";

/** The names of the checkout the body binds, each only if it is present: folders and files, at the same path under /body. */
export const BODY_BINDS = ["src", "docs", "deploy", "README.md", "AGENTS.md", "package.json", "LICENSE"];

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

/** A name that is an env file: `.env`, `.env.*` or `*.env`, in any letter case. */
export function isEnvFileName(name: string): boolean {
  return /^(\.env(\..*)?|.*\.env)$/i.test(name);
}

/**
 * Why /body cannot be bound, in plain words for the summoner, or undefined when it can. A checkout that cannot be found
 * refuses the bind as well: the body is on by default, so a missing root must not pass silently.
 */
export function bodyRefusal(root: string | undefined, entityDir: string): string | undefined {
  if (root === undefined) {
    return `The Natalis checkout could not be found from its own code, so ${BODY_MOUNT} cannot be bound. Set "body": false in sandbox.json to run without it.`;
  }
  if (entityInside(root, entityDir)) {
    return `Not binding ${BODY_MOUNT}: the Lar's folder lies inside ${root}, so the body would expose it. Move the Lar's folder out of the checkout, or set "body": false in sandbox.json.`;
  }
  return bodyProblem(root);
}

/** True when the Lar's folder is the checkout or lies inside it. */
function entityInside(root: string, entityDir: string): boolean {
  const rel = relative(resolve(root), resolve(entityDir));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why the allow-listed parts of the checkout cannot be bound, or undefined when they can. Each allow-listed folder is
 * searched at any depth for an env file or a folder named vault; the names are reported, never their contents.
 */
function bodyProblem(root: string): string | undefined {
  try {
    readdirSync(root);
  } catch {
    return `The body folder ${root} could not be read, so ${BODY_MOUNT} cannot be bound. Set "body": false in sandbox.json to run without it.`;
  }
  try {
    for (const name of BODY_BINDS) {
      const top = join(root, name);
      if (!existsSync(top) || !statSync(top).isDirectory()) continue;
      const found = firstSecret(top);
      if (found === undefined) continue;
      if (found.kind === "env") {
        return `Not binding ${BODY_MOUNT}: ${name} holds ${found.name}, and the body must hold no env file, so no secret can be read through it. Move it out, or set "body": false in sandbox.json.`;
      }
      return `Not binding ${BODY_MOUNT}: ${name} holds a vault folder, and the vault must never be read through the body. Move it out, or set "body": false in sandbox.json.`;
    }
  } catch {
    return `The body folder ${root} could not be read, so ${BODY_MOUNT} cannot be bound. Set "body": false in sandbox.json to run without it.`;
  }
  return undefined;
}

/** The first env file or vault folder under a folder, at any depth. Symbolic links are not followed. */
function firstSecret(folder: string): { kind: "env" | "vault"; name: string } | undefined {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "vault") return { kind: "vault", name: entry.name };
      const deeper = firstSecret(join(folder, entry.name));
      if (deeper !== undefined) return deeper;
    } else if (isEnvFileName(entry.name)) {
      return { kind: "env", name: entry.name };
    }
  }
  return undefined;
}
