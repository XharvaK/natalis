// What changed in the Lar's body since the commit it last started from. The build writes dist/changes.json (a short
// list of commit subjects); this module reads it and turns it into one plain note for the self thread. It is pure: no
// git, no clock, no files.

export type BodyChanges = {
  head: string;
  commits: Array<{ hash: string; parents: string[]; subject: string }>;
};

const MAX_CHANGES = 500;
const SHOWN_MAX = 30;

/** Reads the shape scripts/write-changes.mjs writes. Undefined when anything about it is wrong. */
export function parseBodyChanges(value: unknown): BodyChanges | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (root["version"] !== 1 || typeof root["head"] !== "string") return undefined;
  const raw = root["commits"];
  if (!Array.isArray(raw)) return undefined;
  const commits: BodyChanges["commits"] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const commit = item as Record<string, unknown>;
    const parents = commit["parents"];
    if (typeof commit["hash"] !== "string" || typeof commit["subject"] !== "string" || !Array.isArray(parents)) {
      return undefined;
    }
    if (!parents.every((parent) => typeof parent === "string")) return undefined;
    commits.push({ hash: commit["hash"], parents: parents as string[], subject: commit["subject"] });
  }
  return { head: root["head"], commits };
}

/**
 * The note for what arrived since the start that recorded `seenHead`, or undefined when there is nothing to tell.
 * New commits are those that are not `seenHead` or one of its ancestors in the list. Merges and subjects that start
 * with "test(" or "chore" are left out of the list; at most thirty are named.
 */
export function bodyChangesNote(changes: BodyChanges, seenHead: string): string | undefined {
  if (seenHead === changes.head) return undefined;
  const byHash = new Map(changes.commits.map((commit) => [commit.hash, commit]));
  if (!byHash.has(seenHead)) {
    return `Your body changed since your last start: more than ${MAX_CHANGES} changes.`;
  }
  const known = new Set<string>([seenHead]);
  const walk = [seenHead];
  while (walk.length > 0) {
    const hash = walk.pop() as string;
    const commit = byHash.get(hash);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (known.has(parent)) continue;
      known.add(parent);
      if (byHash.has(parent)) walk.push(parent);
    }
  }
  const fresh = changes.commits.filter((commit) => !known.has(commit.hash));
  const shown = fresh.filter(
    (commit) =>
      commit.parents.length === 1 && !commit.subject.startsWith("test(") && !commit.subject.startsWith("chore"),
  );
  if (shown.length === 0) return undefined;
  if (shown.length > SHOWN_MAX) {
    return `Your body changed since your last start (${shown.length} changes; the newest ${SHOWN_MAX} here): ${shown
      .slice(0, SHOWN_MAX)
      .map((commit) => commit.subject)
      .join("; ")}.`;
  }
  return `Your body changed since your last start (${shown.length} changes): ${shown
    .map((commit) => commit.subject)
    .join("; ")}.`;
}
