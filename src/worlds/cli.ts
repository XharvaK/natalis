// The command-line world: the owner types lines into a terminal and the entity's words come back to the same
// terminal. It offers no tools of its own. The host decides what is shown; the words are the entity's.

import type { SayResult, World, WorldEvent } from "../contracts.js";

export const CLI_WORLD_ID = "cli";
export const CLI_PLACE = "cli:owner";
export const CLI_NOW = "Command line: open.";

export type CliWorldOptions = {
  /** Called with each thing the entity says to a command-line place. */
  onSay: (place: string, text: string) => void;
};

export interface CliWorld extends World {
  /** Sends one line from the owner. Throws if the world is not started. */
  send(text: string): void;
}

export function createCliWorld(options: CliWorldOptions): CliWorld {
  let emit: ((event: WorldEvent) => void) | undefined;
  return {
    id: CLI_WORLD_ID,

    async start(next: (event: WorldEvent) => void): Promise<void> {
      emit = next;
    },

    async stop(): Promise<void> {
      emit = undefined;
    },

    send(text: string): void {
      if (emit === undefined) throw new Error("The command-line world is not started.");
      if (typeof text !== "string" || text.trim() === "") throw new RangeError("Nothing to send: the line is empty.");
      emit({ world: CLI_WORLD_ID, place: CLI_PLACE, actor: "owner", source: "owner", text });
    },

    async say(place: string, text: string): Promise<SayResult> {
      if (!place.startsWith(`${CLI_WORLD_ID}:`)) {
        return { ok: false, summary: "That is not a command-line place.", refused: { code: "no_place", reason: `${place} is not a command-line place.` } };
      }
      try {
        options.onSay(place, text);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: "The command line could not show that.", refused: { code: "world_error", reason } };
      }
      return { ok: true, summary: "Shown on the command line.", data: { place } };
    },

    tools() {
      return [];
    },

    now() {
      return CLI_NOW;
    },
  };
}
