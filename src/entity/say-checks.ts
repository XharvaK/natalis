// Extra say checks: a slot of named, rule-based checks that run after the built-in chain (stop, secrets, privacy,
// world, honesty). Each is off unless entity.json holds.<name> is true. A check returns the plain reason it holds the
// words, or undefined; the body never rewrites them. No model call: these are checks on bytes and names.

export type SayCheckContext = { summonerAlias: string; bodyPrefix: string };
export type SayCheck = { name: string; check(text: string, ctx: SayCheckContext): string | undefined };

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that wear the body's own notice prefix, or open by speaking as the summoner ("This is X", "X here"). */
export const impersonationCheck: SayCheck = {
  name: "impersonation",
  check(text, ctx) {
    const trimmed = text.trimStart();
    if (ctx.bodyPrefix !== "" && trimmed.startsWith(ctx.bodyPrefix.trim())) {
      return `it starts with "${ctx.bodyPrefix.trim()}", which marks the body's own notices`;
    }
    const alias = ctx.summonerAlias.trim();
    if (alias === "") return undefined;
    const a = escape(alias);
    const asThem = new RegExp(`^(?:this is ${a}\\b|${a} here\\b|it'?s ${a}(?: here| speaking)\\b)|(?:^|\\n)\\s*(?:-|—|~)\\s*${a}\\s*$`, "i");
    if (asThem.test(trimmed)) return `it speaks as your summoner (${alias})`;
    return undefined;
  },
};

export const SAY_CHECKS: readonly SayCheck[] = [impersonationCheck];
export const SAY_CHECK_NAMES: readonly string[] = SAY_CHECKS.map((c) => c.name);
