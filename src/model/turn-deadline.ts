// A turn's watchdog for its model calls. A call still running when the turn's time is up is stopped, and fails as a
// timeout: run-turn then ends the turn as a model error through its normal note, and the runtime schedules the retry as
// for any failed turn. The shutdown signal still ends a call as "aborted", as before.

import { ModelError } from "../contracts.js";
import type { ModelPort, ModelRequest, ModelResponse } from "../contracts.js";

/** About twenty minutes: far past a healthy turn, short enough that a stuck one does not hold a thread for hours. */
export const TURN_DEADLINE_MS = 20 * 60_000;

export type TurnWatchdog = {
  model: ModelPort;
  /** Aborts when the turn's time is up; run-turn joins it into what tools see, so a tool is stopped at the deadline too. */
  signal: AbortSignal;
  /** Clears the timer. Call when the turn has ended. */
  done(): void;
};

export function withTurnDeadline(
  model: ModelPort,
  deadlineMs: number = TURN_DEADLINE_MS,
  log: (line: string) => void = (line) => console.error(`[natalis] ${line}`),
): TurnWatchdog {
  const watchdog = new AbortController();
  const deadlineAtMs = Date.now() + deadlineMs;
  const minutes = Math.round(deadlineMs / 60_000);
  const timedOut = (attempts: number): ModelError =>
    new ModelError(`turn timed out: it ran past ${minutes} minutes and its model call was stopped`, "timeout", attempts);
  const timer = setTimeout(() => {
    log(`turn watchdog: a turn ran past ${minutes} minutes; its model call is stopped`);
    watchdog.abort();
  }, deadlineMs);
  timer.unref?.();
  const port: ModelPort = {
    info: model.info,
    ...(model.routing === undefined ? {} : { routing: () => model.routing!() }),
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      if (watchdog.signal.aborted && !signal?.aborted) throw timedOut(0);
      const joined = signal === undefined ? watchdog.signal : AbortSignal.any([signal, watchdog.signal]);
      try {
        return await model.complete({ ...request, turnDeadlineAtMs: deadlineAtMs }, joined);
      } catch (err) {
        if (watchdog.signal.aborted && !signal?.aborted) throw timedOut(err instanceof ModelError ? err.attempts : 0);
        throw err;
      }
    },
  };
  return { model: port, signal: watchdog.signal, done: () => clearTimeout(timer) };
}
