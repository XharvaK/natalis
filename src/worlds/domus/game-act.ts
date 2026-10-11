// The game_act tool: the Lar names one choice of the newest view of its game thread (and up to two more to follow it),
// and the world keeps the request for the helper. The tool never guesses a ref, never matches a word, and never
// chooses for the Lar. Its receipts say requested; what the game did comes back later as notes on the game thread.

import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { answerFor, isAnswerClaim, type AnswerClaim, type Found } from "./answers.js";
import { PLAN_MORE, requestAct } from "./acts.js";
import { findOption, labelOf, optionsOf, refsOf } from "./options.js";
import { newestObservation, STALE_VIEW_CODE, STALE_VIEW_REASON } from "./store.js";

const REF = /^[A-Za-z0-9._-]{1,16}$/;
const ARG_KEYS = new Set(["option", "then", "for_summoner", "answer", "expect", "expect_then"]);
const EXPECT_MAX = 200;
export const GAME_THREAD_PREFIX = "domus:";

/**
 * What the tool needs from the world: the open database, the world's clock, the helper session that is attached now
 * (undefined when the game is not attached; null when not running) and the last time the game was attached.
 */
export type GameActContext = {
  db: DatabaseSync; nowMs: () => number; attachedSession: (nowMs: number) => string | undefined; lastAttachedMs: () => number | undefined;
} | null;

function refused(code: string, reason: string, summary: string = reason): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

/** Whether the words the Lar read for a ref still name it: the act's label contains them, any case, trimmed. */
function stillNames(found: Found, expected: string): boolean {
  return labelOf(found).toLowerCase().includes(expected.trim().toLowerCase());
}

/** The refusal for a ref whose words changed since the Lar read them, saying what it names now. Undefined when it still names them. */
function refChanged(ref: string, found: Found, expected: string, where: string): Receipt | undefined {
  if (stillNames(found, expected)) return undefined;
  const now = labelOf(found);
  return refused(
    "ref_changed",
    `${ref}${where} now names: ${now}. You expected "${expected.trim()}". Refs stay the same for one game session, so a ref that names something else means the game's choice changed; choose again from the newest view.`,
  );
}

/** The refs the Lar can name now, as one short sentence. */
function refsSentence(refs: readonly string[]): string {
  return refs.length ? `The refs you can name now are: ${refs.join(", ")}.` : "The newest view of this game offers no choices.";
}

export function gameActTool(open: () => GameActContext): Tool {
  return {
    spec: {
      name: "game_act",
      description:
        "Ask the game to do one of the choices in the newest view of this game thread, by its ref (for example a3). " +
        "Put up to two more refs in then; each runs only after the one before it completes. Set for_summoner only when " +
        "your summoner asked for this act. Answer a game question with answer: rows by ref (with a count where the question allows it) " +
        "and typed fields, as the question's rules allow. This only requests the act; what the game does comes back here as notes.",
      parameters: {
        type: "object",
        properties: {
          option: { type: "string", description: "The ref of the choice, such as a3, from the newest view." },
          then: {
            type: "array",
            items: { type: "string" },
            maxItems: PLAN_MORE,
            description: "Up to two more refs, each run after the one before it completes.",
          },
          expect: {
            type: "string",
            maxLength: EXPECT_MAX,
            description: "Optional. The words of the act as you read them in the view, such as Boil water. If the ref now names something else, the act is refused with what it names now, and nothing is requested.",
          },
          expect_then: {
            type: "array",
            items: { type: "string", maxLength: EXPECT_MAX },
            maxItems: PLAN_MORE,
            description: "Optional. For each ref in then, in order, the words of that act as you read them. Checked the same way as expect; a shorter list checks only the refs it names.",
          },
          for_summoner: { type: "boolean", description: "True only when your summoner asked for this act." },
          answer: {
            type: "object",
            description: "Your answer to a game question: rows (option is a row ref, count optional) and/or text (field name to the words you type).",
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: { option: { type: "string" }, count: { type: "integer", minimum: 1 } },
                  required: ["option"],
                },
              },
              text: { type: "object", additionalProperties: { type: "string" } },
            },
          },
        },
        required: ["option"],
      },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameAct(open, args, context);
    },
  };
}

function gameAct(open: () => GameActContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  if (!context.thread.startsWith(GAME_THREAD_PREFIX)) {
    return refused("not_a_game_thread", "game_act works in a game thread (domus:...). This is not one.");
  }
  // Nothing is queued for a game that is not there: the request would only expire unclaimed.
  const nowAt = game.nowMs();
  if (game.attachedSession(nowAt) === undefined) {
    const last = game.lastAttachedMs();
    const when = last === undefined ? "It has not been attached since this world started." : `It was last attached at ${new Date(last).toISOString()}.`;
    return refused("not_attached", `The game is not attached, so nothing was requested. ${when}`);
  }
  for (const key of Object.keys(args)) {
    if (!ARG_KEYS.has(key)) return refused("bad_args", `${key} is not a field of game_act.`);
  }
  const option = args.option;
  if (typeof option !== "string" || !REF.test(option)) return refused("bad_args", "option must be a ref such as a3.");
  const thenRefs = args.then ?? [];
  if (!Array.isArray(thenRefs) || thenRefs.length > PLAN_MORE || !thenRefs.every((ref) => typeof ref === "string" && REF.test(ref))) {
    return refused("bad_args", `then must be up to ${PLAN_MORE} refs, each such as a4.`);
  }
  if (args.for_summoner !== undefined && typeof args.for_summoner !== "boolean") {
    return refused("bad_args", "for_summoner must be true or false.");
  }
  if (args.expect !== undefined && !(typeof args.expect === "string" && args.expect.length <= EXPECT_MAX)) {
    return refused("bad_args", `expect must be the words of the act as you read them, up to ${EXPECT_MAX} characters.`);
  }
  const expectThen = args.expect_then;
  if (expectThen !== undefined && !(Array.isArray(expectThen) && expectThen.length <= PLAN_MORE
    && expectThen.every((text) => typeof text === "string" && text.length <= EXPECT_MAX))) {
    return refused("bad_args", `expect_then must be up to ${PLAN_MORE} texts, each the words of a then act as you read them, up to ${EXPECT_MAX} characters.`);
  }
  if (args.answer !== undefined && !isAnswerClaim(args.answer)) {
    return refused("bad_args", "answer must hold rows (with refs and counts) and/or text (named fields), as the question allows.");
  }
  const claim = args.answer as AnswerClaim | undefined;

  const nowMs = game.nowMs();
  const newest = newestObservation(game.db, context.thread);
  if (!newest) return refused("no_view", "The game has not shown you a view of this thread yet, so there is nothing to choose.");
  // The refs come from a view of a helper session that is no longer attached: that game restarted, and its new view has not come.
  const attached = game.attachedSession(nowMs);
  if (attached !== undefined && newest.attachment !== attached) return refused(STALE_VIEW_CODE, STALE_VIEW_REASON);
  const options = optionsOf(newest.payload.options);
  const refs = refsOf(options);
  const first = findOption(options, option);
  if (!first) {
    return refused("unknown_option", `${option} is not a choice in the newest view of this game. ${refsSentence(refs)}`);
  }
  if (typeof args.expect === "string") {
    const changed = refChanged(option, first, args.expect, "");
    if (changed) return changed;
  }
  const then: Array<{ ref: string; found: Found }> = [];
  for (const [index, ref] of (thenRefs as string[]).entries()) {
    const found = findOption(options, ref);
    if (!found) return refused("unknown_option", `${ref} (in then) is not a choice in the newest view of this game. ${refsSentence(refs)}`);
    const expected = Array.isArray(expectThen) ? expectThen[index] : undefined;
    if (typeof expected === "string") {
      const changed = refChanged(ref, found, expected, " (in then)");
      if (changed) return changed;
    }
    then.push({ ref, found });
  }
  let label = labelOf(first);
  let answer: { json: string } | undefined;
  if (claim !== undefined) {
    const result = answerFor(first, claim);
    if ("refused" in result) return refused(result.refused.code, result.refused.reason);
    answer = { json: result.json };
    label = result.label;
  }
  const requested = requestAct(game.db, {
    thread: context.thread,
    turnId: context.turnId,
    attachment: newest.attachment,
    observationId: newest.observationId,
    found: first,
    label,
    forSummoner: args.for_summoner === true,
    ...(answer ? { answer } : {}),
    then,
    nowMs,
  });
  if (!requested.ok) {
    return refused(requested.code, "You already asked the game for one act in this turn. Ask for the next one in your next turn.");
  }
  const planText = requested.steps.length
    ? ` Then, each after the one before completes: ${requested.steps.map((step) => `${step.ref} (${step.label})`).join("; ")}.`
    : "";
  return {
    ok: true,
    summary: `Requested: ${label} (${option}). The game has not done it yet; what it does comes back here as notes.${planText}`,
    data: {
      actId: requested.actId,
      option,
      label,
      expiresAtMs: requested.expiresAtMs,
      forSummoner: args.for_summoner === true,
      then: requested.steps.map((step) => step.ref),
    },
  };
}
