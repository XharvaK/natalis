// Plain words for the game's own facts: a need's band, a name the game gave, a value that may or may not be there.
// Mechanical only: a fixed mapping and a case change, never a meaning or advice.

/** The words for a need's band. A band not listed here is shown as the band word itself. */
export const BAND_WORDS: Readonly<Record<string, string>> = { distress: "very low", low: "low", ok: "fine", high: "full", full: "full" };

/** A string or a finite number as text; anything empty or of another type is undefined. */
export function textOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A game name in plain words: the tuning name of a class string, with camel case, "_" and "-" as spaces, lower case. */
export function plainName(text: string): string {
  const tuning = /<class '([^']*)'>/.exec(text)?.[1] ?? text;
  const last = tuning.split(".").pop() ?? tuning;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A sentence the game or the helper sent, with a full stop at its end unless it has . ! or ? already. */
export function withStop(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A sentence without its final . ! or ?, for a sentence inside a list of clauses. */
export function withoutStop(text: string): string {
  return text.replace(/[.!?]+$/, "");
}

export function capitalised(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The words for who started an act, as the game's own percepts name it: "your act" for hers, "the game" for the game's. */
export const ORIGIN_WORDS: Readonly<Record<string, string>> = { her_choice: "your act", script: "your act", game: "the game", native_reaction: "the game, on its own" };

/**
 * The words for who started an act in the game's record of a day (the helper's outcome origins): the summoner at the
 * controls, her own continued act, the body's own act, the game's reaction, and the helper's experiment.
 */
export const DAY_ORIGIN_WORDS: Readonly<Record<string, string>> = {
  owner: "the summoner's act",
  user_intent: "your act",
  body: "the game, on its own",
  game_reaction: "the game, on its own",
  experiment: "an experiment",
  game: "the game",
};
