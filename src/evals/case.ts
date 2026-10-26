// An eval case file: fixed owner messages sent to a throwaway Lar, and the assertions on what it did.

import { ASSERTION_TYPES, type Assertion } from "./assertions.js";

export type EvalCase = { name: string; events: string[]; iterations: number; assertions: Assertion[] };

export const MAX_ITERATIONS = 100;

/** Validates a parsed case. Throws a plain error naming the first wrong field. */
export function parseEvalCase(value: unknown): EvalCase {
  const v = value as Record<string, unknown>;
  if (typeof v?.["name"] !== "string" || v["name"] === "") throw new Error("eval case: name must be a non-empty string");
  const events = v["events"];
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === "string")) {
    throw new Error(`eval case ${v["name"]}: events must be a non-empty list of messages`);
  }
  const iterations = v["iterations"] ?? 1;
  if (!Number.isInteger(iterations) || (iterations as number) < 1 || (iterations as number) > MAX_ITERATIONS) {
    throw new Error(`eval case ${v["name"]}: iterations must be 1 to ${MAX_ITERATIONS}`);
  }
  const assertions = v["assertions"];
  if (!Array.isArray(assertions)) throw new Error(`eval case ${v["name"]}: assertions must be a list`);
  for (const a of assertions as Array<Record<string, unknown>>) {
    if (!(ASSERTION_TYPES as readonly string[]).includes(String(a?.["type"]))) {
      throw new Error(`eval case ${v["name"]}: unknown assertion type ${String(a?.["type"])}`);
    }
    if (a["mode"] !== undefined && a["mode"] !== "gate" && a["mode"] !== "soft") throw new Error(`eval case ${v["name"]}: assertion mode must be gate or soft`);
  }
  return { name: v["name"], events: events as string[], iterations: iterations as number, assertions: assertions as Assertion[] };
}
