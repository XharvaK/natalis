// The game_look tool: the Lar asks the game for a fresh view of how things are now. The request is one flag per helper
// session. It is handed over on the helper's next sync, and the view that answers it always wakes her. The tool only
// asks; it changes nothing in the game.

import type { DatabaseSync } from "node:sqlite";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { GAME_THREAD_PREFIX } from "./game-act.js";
import { lookOwed, oweLook } from "./store.js";

/**
 * What the tool reads on each call: the open database, the world's clock, the helper session attached now (undefined
 * when the game is not attached) and the last time the game was attached. Null while the world is not running.
 */
export type LookContext = {
  db: DatabaseSync; nowMs: () => number; attachedSession: (nowMs: number) => string | undefined; lastAttachedMs: () => number | undefined;
} | null;

function refused(code: string, reason: string): Receipt {
  return { ok: false, summary: reason, refused: { code, reason } };
}

export function gameLookTool(open: () => LookContext): Tool {
  return {
    spec: {
      name: "game_look",
      description:
        "Ask the game for a fresh view of how things are now, when you want to look rather than wait for a change. " +
        "The game shows it on its next sync, and that view wakes you. This only asks; nothing in the game changes.",
      parameters: { type: "object", properties: {} },
    },
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      return gameLook(open, args, context);
    },
  };
}

function gameLook(open: () => LookContext, args: Record<string, unknown>, context: ToolContext): Receipt {
  const game = open();
  if (!game) return refused("not_running", "The game is not connected to you right now.");
  if (!context.thread.startsWith(GAME_THREAD_PREFIX)) {
    return refused("not_a_game_thread", "game_look works in a game thread (domus:...). This is not one.");
  }
  if (Object.keys(args).length > 0) return refused("bad_args", "game_look takes no fields.");
  // Nothing is owed to a game that is not there: the look would only wait for a helper that is not asking.
  const session = game.attachedSession(game.nowMs());
  if (session === undefined) {
    const last = game.lastAttachedMs();
    const when = last === undefined ? "It has not been attached since this world started." : `It was last attached at ${new Date(last).toISOString()}.`;
    return refused("not_attached", `The game is not attached, so nothing was requested. ${when}`);
  }
  if (lookOwed(game.db, session)) {
    return { ok: true, summary: "You already asked for a fresh view of now. It comes on the game's next sync.", data: { owed: true } };
  }
  oweLook(game.db, session);
  return {
    ok: true,
    summary: "Asked the game for a fresh view of now. It comes on its next sync, and that view wakes you.",
    data: { owed: true },
  };
}
