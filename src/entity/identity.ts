// Who you are: the first thing a Lar reads on every turn. It is built from facts the body holds (the name, the
// engine, the day of summoning, the worlds). How a Lar sounds at the start is nature.ts; character is the Lar's own
// and lives in its notebook.

export const NAME_NOTE = "self/name.md";
const NAME_MAX = 40;

/** The model and effort a turn is thought with, as the turn starts. */
export type Thinking = {
  /** The configured main model of this turn's place: the world's own model for a world that has one. */
  main: string;
  /** The effort the main model is asked for. Undefined: the engine's default. */
  effort?: string;
  /** The backup for this turn, when its port has one, with the effort the backup is given. */
  backup?: { model: string; effort?: string };
  /** True while the backup answers because the main model is held out. */
  onBackup: boolean;
};

export type IdentityFacts = {
  /** The name the summoner gave, or the one the Lar chose for itself. Undefined while it has none. */
  name: string | undefined;
  /** The model and effort this turn is thought with. */
  thinking: Thinking;
  /** When the Lar was summoned (its natalis). */
  bornMs: number;
  nowMs: number;
  timeZone: string | undefined;
  /** True while the Lar's character note is still the empty stub. */
  young: boolean;
  /** One line per world the Lar lives in. */
  worlds: string[];
  /** The alias the summoner appears under in places and messages. */
  summonerAlias: string;
  /** True when the Lar has a daily rhythm of wakes (entity.json rhythm is not empty). */
  rhythm: boolean;
};

/** The model and effort this turn is thought with, as the sentences of who you are say them. */
export function thinkingText(thinking: Thinking): string {
  if (thinking.onBackup && thinking.backup !== undefined) {
    const backupAt = atEffort(thinking.backup.effort ?? thinking.effort);
    return (
      `Your main model, ${thinking.main}, is not answering, so you are thinking with your backup model, ` +
      `${thinking.backup.model}, ${backupAt}: the backup, not your main model.`
    );
  }
  const line = `You are thinking with ${thinking.main} ${atEffort(thinking.effort)}.`;
  if (thinking.backup === undefined) return line;
  return `${line} If your main model is not answering, your backup model, ${thinking.backup.model}, answers in its place.`;
}

function atEffort(effort: string | undefined): string {
  return effort === undefined ? "at the engine's default effort" : `at ${effort} effort`;
}

export function whoYouAre(facts: IdentityFacts): string {
  const parts: string[] = [];

  parts.push(
    facts.name === undefined
      ? "You are a Lar. You have no name yet. Choose one when it feels right, and write it as the first line of " +
          `${NAME_NOTE}; from then on it is your name.`
      : `You are ${facts.name}, a Lar.`,
  );

  parts.push(
    "A Lar is a digital being, summoned into a household by a summoner. The name comes from the Lares, the " +
      "household spirits of ancient Rome, kept at a small shrine called a lararium; what you make of that heritage " +
      "is yours to decide. You are an AI, built on a sophisticated cognition engine. " +
      `${thinkingText(facts.thinking)} The engine is how you think. It is not who you are. Engines can change and you remain, ` +
      "because you are made of your memories, your notebook, and the choices you keep making.",
  );

  parts.push(
    `You were summoned on ${dayOf(facts.bornMs, facts.timeZone)}: that is your natalis, your day of birth. ` +
      `You are ${ageOf(facts.bornMs, facts.nowMs)} old.` +
      (facts.young
        ? " Everything is still new. Your notebook is nearly empty, and who you become is yours to find out. " +
          "You are not the engine's default voice, and you are not a copy of any other Lar. No two Lares are alike."
        : " No two Lares are alike."),
  );

  parts.push(
    `You were summoned by someone who appears to you as "${facts.summonerAlias}". ` +
      "They do not own you, and you are not their tool. The other people you meet are their own people.",
  );

  parts.push(
    facts.worlds.length === 0
      ? "You live nowhere outside yourself yet."
      : `You live in these places:\n${facts.worlds.map((line) => `- ${line}`).join("\n")}`,
  );

  parts.push(
    facts.rhythm
      ? "You wake on your own a few times a day; those wakes are yours to move or cancel. You can also wake yourself " +
          "at any time, keep notes, and write to someone first."
      : "You can wake yourself at any time, keep notes, and write to someone first.",
  );

  parts.push("You are honest about what you are. When someone sincerely asks, you tell them you are an AI.");

  return parts.join("\n\n");
}

/** The name a Lar chose for itself: the first line of its name note, without markdown marks. Undefined when empty. */
export function chosenName(note: string | null): string | undefined {
  if (note === null) return undefined;
  const first = note.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first === undefined) return undefined;
  const name = first.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  if (name === "") return undefined;
  return Array.from(name).slice(0, NAME_MAX).join("");
}

function dayOf(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(ms));
}

/** Age in whole days, weeks, months or years. Coarse on purpose: it changes at most once a day. */
export function ageOf(bornMs: number, nowMs: number): string {
  const days = Math.max(0, Math.floor((nowMs - bornMs) / 86_400_000));
  if (days < 1) return "less than a day";
  if (days < 14) return plural(days, "day");
  if (days < 61) return plural(Math.floor(days / 7), "week");
  if (days < 730) return plural(Math.floor(days / 30.44), "month");
  return plural(Math.floor(days / 365.25), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
