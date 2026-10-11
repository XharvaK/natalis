import { describe, expect, it } from "vitest";
import { ModelError } from "../contracts.js";
import type { ModelRequest } from "../contracts.js";
import { createScriptedModel } from "./mock.js";

const req = (text: string): ModelRequest => ({ messages: [{ role: "user", content: text }] });

describe("scripted model", () => {
  it("replies in order and records every request", async () => {
    const model = createScriptedModel([{ content: "first" }, { content: "second", finish: "length" }]);
    const a = await model.complete(req("one"));
    const b = await model.complete(req("two"));
    expect(a).toEqual({ content: "first", toolCalls: [], finish: "stop", latencyMs: 0 });
    expect(b).toEqual({ content: "second", toolCalls: [], finish: "length", latencyMs: 0 });
    expect(model.requests.map((r) => r.messages[0])).toEqual([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
    expect(model.remaining).toBe(0);
  });

  it("infers tool_calls finish when tool calls are scripted without a finish", async () => {
    const model = createScriptedModel([
      { toolCalls: [{ id: "t1", name: "recall", arguments: "{}" }] },
      { toolCalls: [{ id: "t2", name: "recall", arguments: "{}" }], finish: "stop" },
    ]);
    expect((await model.complete(req("a"))).finish).toBe("tool_calls");
    expect((await model.complete(req("b"))).finish).toBe("stop");
  });

  it("builds a reply from the request when given a function", async () => {
    const model = createScriptedModel([(r) => ({ content: `echo: ${r.messages.length}` })]);
    const reply = await model.complete(req("hello"));
    expect(reply.content).toBe("echo: 1");
  });

  it("throws malformed when the script runs out, and still records the request", async () => {
    const model = createScriptedModel([{ content: "only" }]);
    await model.complete(req("a"));
    const err = await model.complete(req("b")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("malformed");
    expect(model.requests).toHaveLength(2);
  });

  it("reports the given info over its defaults", () => {
    const model = createScriptedModel([], { id: "test:one", contextTokens: 123, nativeTools: false });
    expect(model.info).toEqual({ id: "test:one", contextTokens: 123, nativeTools: false });
    expect(createScriptedModel([]).info).toEqual({ id: "scripted:mock", contextTokens: 8192, nativeTools: true });
  });

  it("refuses a call whose signal is already aborted", async () => {
    const model = createScriptedModel([{ content: "x" }]);
    const controller = new AbortController();
    controller.abort();
    const err = await model.complete(req("a"), controller.signal).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ModelError).kind).toBe("aborted");
    expect(model.remaining).toBe(1);
  });
});
