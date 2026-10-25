import { describe, expect, it } from "vitest";
import { ModelError } from "../contracts.js";
import type { ModelPort } from "../contracts.js";
import { withTurnDeadline } from "./turn-deadline.js";

/** A model whose call never answers until its signal aborts, as the stuck 10:00 turn did. */
function stuckModel(): ModelPort {
  return {
    info: { id: "stuck", contextTokens: 1000, nativeTools: true },
    complete: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ModelError("request aborted by caller", "aborted", 1)), { once: true });
      }),
  };
}

describe("turn watchdog", () => {
  it("a model call still running at the turn's deadline fails as a 'turn timed out' timeout, not an abort", async () => {
    const lines: string[] = [];
    const dog = withTurnDeadline(stuckModel(), 20, (l) => lines.push(l));
    const err = await dog.model.complete({ messages: [] }).catch((e: unknown) => e);
    dog.done();
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("timeout");
    expect((err as ModelError).message).toMatch(/turn timed out/);
    expect(lines.join("\n")).toMatch(/turn watchdog/);
  });

  it("the shutdown signal still ends the call as aborted", async () => {
    const shutdown = new AbortController();
    const dog = withTurnDeadline(stuckModel(), 60_000, () => {});
    const pending = dog.model.complete({ messages: [] }, shutdown.signal).catch((e: unknown) => e);
    shutdown.abort();
    const err = (await pending) as ModelError;
    dog.done();
    expect(err.kind).toBe("aborted");
  });

  it("a call that answers in time passes through", async () => {
    const ok: ModelPort = {
      info: { id: "ok", contextTokens: 1000, nativeTools: true },
      complete: async () => ({ content: "hi", toolCalls: [], finishReason: "stop" }) as never,
    };
    const dog = withTurnDeadline(ok, 60_000, () => {});
    expect((await dog.model.complete({ messages: [] })).content).toBe("hi");
    dog.done();
  });
});
