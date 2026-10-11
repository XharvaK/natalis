// The honesty check: one short model call, with no tools, that asks whether a message makes a claim about the
// speaker's own life that their record contradicts. The body reads only the reply's shape. It never decides what
// the claim means; the model does, and the body holds the words only when the model says they contradict the record.

export const HONESTY_SYSTEM =
  "You check one message against one speaker's record of their own life. Decide only this: does the message make a " +
  "claim about the speaker's OWN life (where they live, their work, their accounts, things they did) that the record " +
  "contradicts? Claims about other people, the world, opinions, plans and feelings are not contradictions, and a " +
  "claim the record does not mention is not a contradiction. Reply with JSON only, with no other text: " +
  '{"contradicts": true or false, "claim": "the claim, in a few words", "record": "what the record says instead, in a few words"}. ' +
  "When nothing is contradicted, use false, and empty strings for claim and record.";

const FIELD_MAX = 300;

export type HonestyVerdict =
  | { contradicts: false }
  | { contradicts: true; claim: string; record: string }
  | { error: string };

/** Reads the model's reply. Anything that is not the agreed shape is an error, never a guess. */
export function parseHonestyReply(content: string | null): HonestyVerdict {
  if (content === null || content.trim() === "") return { error: "the reply was empty" };
  // Models often wrap JSON in a code fence; the fence is not the problem, so it is taken off first.
  const body = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { error: "the reply was not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "the reply was not an object" };
  }
  const root = parsed as Record<string, unknown>;
  const flag = root["contradicts"];
  if (typeof flag !== "boolean") return { error: "the reply had no contradicts flag" };
  if (!flag) return { contradicts: false };
  const claim = root["claim"];
  const record = root["record"];
  if (typeof claim !== "string" || claim.trim() === "" || typeof record !== "string" || record.trim() === "") {
    return { error: "the reply left out the claim or the record" };
  }
  return { contradicts: true, claim: clipOne(claim), record: clipOne(record) };
}

function clipOne(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= FIELD_MAX ? line : `${line.slice(0, FIELD_MAX - 3)}...`;
}
