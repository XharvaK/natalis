// The plain words of the permission tools, made by code only. A read-back states exactly what would be stored, and
// every outcome is one line the Owner can read. Nothing here holds the Owner's words or the model's words.

import { ANYWHERE, type GrantKind } from "./grants.js";
import { SUMMONER_PREFIX } from "./summoner.js";

export const ANSWER_KINDS = ["once", "always", "never", "no"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];
export type AnswerWhere = "this_place" | "anywhere";

/** A request as the read-back names it: the request id, the tool, and the exact scope that would be stored. */
export type ReadbackItemView = { requestId: number; tool: string; kind: GrantKind; scope: string };

/** The scope an answer would store: the request's own scope, or ANYWHERE when she chose it. */
export function scopeForAnswer(requestScope: string, where: AnswerWhere | undefined): string {
  return where === "anywhere" ? ANYWHERE : requestScope;
}

/** Whether an answer must be read back before anything is stored. A no never is; a once only when several wait. */
export function readbackNeeded(kind: AnswerKind, waiting: number, where: AnswerWhere | undefined): boolean {
  if (kind === "no") return false;
  if (kind === "once") return waiting > 1 || where === "anywhere";
  return true;
}

/** "on forum.example.org", or "anywhere" when the scope covers the whole tool. */
export function scopePhrase(scope: string): string {
  return scope === ANYWHERE ? "anywhere" : `on ${scope}`;
}

/** The read-back line, exactly what would be stored; ANYWHERE is said in capitals so the choice is plain. */
export function readbackText(name: string, items: readonly ReadbackItemView[]): string {
  const read = items.map((item) => ({ ...item, scope: item.scope === ANYWHERE ? "ANYWHERE" : item.scope }));
  const readPhrase = (scope: string): string => (scope === "ANYWHERE" ? "ANYWHERE" : `on ${scope}`);
  if (read.length === 1) {
    const item = read[0]!;
    const phrase =
      item.kind === "once"
        ? `ONCE allow ${item.tool} ${readPhrase(item.scope)}`
        : `${item.kind.toUpperCase()} allow ${item.tool} ${readPhrase(item.scope)}, until you take it back`;
    return `${SUMMONER_PREFIX}${name} read your answer as: ${phrase}. Nothing is stored until you agree. This closes in 15 minutes.`;
  }
  const label = read[0]!.kind.toUpperCase();
  const named = read.map((item, index) => `${index + 1} ${item.tool} ${readPhrase(item.scope)}`).join(", ");
  return (
    `${SUMMONER_PREFIX}${name} read your answer as: ${label} for: ${named}. ` +
    `Nothing is stored until you agree. This closes in 15 minutes.`
  );
}

/** One outcome line, as paper §5.1 item 5 has them. */
export function outcomeLine(name: string, item: ReadbackItemView): string {
  const where = scopePhrase(item.scope);
  if (item.kind === "once") return `${SUMMONER_PREFIX}Allowed once: ${item.tool} ${where}.`;
  return `${SUMMONER_PREFIX}Stored: ${item.kind} allow ${item.tool} ${where}. Tell ${name} any time to take it back.`;
}

/** The line when nothing was stored. */
export function notStoredLine(): string {
  return `${SUMMONER_PREFIX}Not stored.`;
}

/** The line for a request that closed with no answer (Q3 posts it at the close; the helper is kept here). */
export function closedWithoutAnswerLine(tool: string, scope: string): string {
  return `${SUMMONER_PREFIX}Closed without an answer: ${tool} ${scopePhrase(scope)}.`;
}

/**
 * The event row written in the asking thread after an outcome, so that thread knows whether the call may run. The
 * once line is paper §5.4 item 7; a no and a never write the same kind of row.
 */
export function outcomeEventText(item: ReadbackItemView, kind: "once" | "always" | "never" | "no"): string {
  const where = scopePhrase(item.scope);
  if (kind === "once") return `Your summoner allowed ${item.tool} ${where} once.`;
  if (kind === "always") return `Your summoner allowed ${item.tool} ${where} until they take it back.`;
  if (kind === "never") return `Your summoner said never to ${item.tool} ${where} until they take it back.`;
  return `Your summoner said no to ${item.tool} ${where} this time.`;
}
