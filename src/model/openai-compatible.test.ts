import { describe, expect, it } from "vitest";
import { ModelError } from "../contracts.js";
import type { ModelRequest, ToolSpec } from "../contracts.js";
import { createOpenAICompatiblePort } from "./openai-compatible.js";

// Built at runtime so no token-shaped literal sits in the repository.
const KEY = ["sk", "test", "abc123"].join("-");

type Call = {
  url: string;
  headers: Record<string, string>;
  body: any;
  signal: AbortSignal | undefined;
};

/** A reply is a ready Response, an Error to throw, or "hang" (never answers until its signal aborts). */
type Reply = Response | Error | "hang";

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error("fake fetch ran out of replies");
    if (next === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const chat = (message: Record<string, unknown>, finish: string | null = "stop"): Response =>
  ok({ choices: [{ index: 0, message, finish_reason: finish }] });

const status = (code: number, body: unknown = { error: { message: "nope" } }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers });

function harness(
  replies: Reply[],
  extra: Partial<Parameters<typeof createOpenAICompatiblePort>[0]> = {},
) {
  const fake = fakeFetch(replies);
  const sleeps: number[] = [];
  const port = createOpenAICompatiblePort({
    baseUrl: "https://llm.example.test/v1/",
    model: "test-model",
    apiKey: KEY,
    contextTokens: 32000,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { port, calls: fake.calls, sleeps };
}

const asks = (messages: ModelRequest["messages"], extra: Partial<ModelRequest> = {}): ModelRequest => ({
  messages,
  ...extra,
});

async function errorOf(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ModelError) return err;
    throw err;
  }
  throw new Error("expected a ModelError, got a reply");
}

describe("request mapping", () => {
  it("maps messages, tools, tool choice and max tokens onto the wire, with the key as a Bearer token", async () => {
    const weather: ToolSpec = {
      name: "recall",
      description: "Find notes",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    };
    const { port, calls } = harness([chat({ role: "assistant", content: "ok" })]);
    await port.complete(
      asks(
        [
          { role: "system", content: "Be brief." },
          { role: "user", content: "look", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "c1", name: "recall", arguments: '{"q":"cats"}' }],
          },
          { role: "tool", toolCallId: "c1", content: "two notes" },
        ],
        { tools: [weather], toolChoice: "auto", maxOutputTokens: 500 },
      ),
    );

    const [call] = calls;
    expect(call?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "recall", arguments: '{"q":"cats"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "two notes" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "recall", description: "Find notes", parameters: weather.parameters },
        },
      ],
      tool_choice: "auto",
      max_tokens: 500,
    });
  });

  it("omits the authorization header when no key is set", async () => {
    const { port, calls } = harness([chat({ content: "hi" })], { apiKey: undefined });
    await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("keeps a two-turn tool loop round-tripping through the wire", async () => {
    const { port, calls } = harness([
      chat(
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_9", type: "function", function: { name: "recall", arguments: '{"q":"cats"}' } }],
        },
        "tool_calls",
      ),
      chat({ role: "assistant", content: "Two notes about cats." }),
    ]);

    const first = await port.complete(asks([{ role: "user", content: "Find my cat notes" }]));
    expect(first.finish).toBe("tool_calls");
    expect(first.content).toBeNull();
    expect(first.toolCalls).toEqual([{ id: "call_9", name: "recall", arguments: '{"q":"cats"}' }]);

    const second = await port.complete(
      asks([
        { role: "user", content: "Find my cat notes" },
        { role: "assistant", content: first.content, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "call_9", content: "two notes" },
      ]),
    );
    expect(second).toMatchObject({ content: "Two notes about cats.", finish: "stop", toolCalls: [] });
    expect(calls[1]?.body.messages).toEqual([
      { role: "user", content: "Find my cat notes" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_9", type: "function", function: { name: "recall", arguments: '{"q":"cats"}' } }],
      },
      { role: "tool", tool_call_id: "call_9", content: "two notes" },
    ]);
    expect(calls[1]?.body.tools).toBeUndefined();
  });
});

describe("reply mapping", () => {
  it("maps usage and latency", async () => {
    const { port } = harness([
      ok({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    ]);
    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(reply.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(typeof reply.latencyMs).toBe("number");
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the provider's reported total tokens, and leaves out any count it did not report", async () => {
    const { port } = harness([
      ok({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
      ok({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7 },
      }),
    ]);
    const first = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(first.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    const second = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(second.usage).toEqual({ inputTokens: 7 });
  });

  it("maps finish reasons and treats unknown ones as stop", async () => {
    const cases: Array<[string | null, string]> = [
      ["length", "length"],
      ["content_filter", "content_filter"],
      ["weird_reason", "stop"],
      [null, "stop"],
    ];
    for (const [raw, expected] of cases) {
      const { port } = harness([chat({ content: "x" }, raw)]);
      const reply = await port.complete(asks([{ role: "user", content: "hi" }]));
      expect(reply.finish).toBe(expected);
    }
  });

  it("generates a tool-call id, with the configured prefix, when the service sends none", async () => {
    const { port } = harness([
      chat(
        { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "recall", arguments: "{}" } }] },
        "tool_calls",
      ),
    ], { idPrefix: "nat" });
    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]?.id).toMatch(/^nat_[0-9a-f]{12}$/);
    expect(reply.toolCalls[0]).toMatchObject({ name: "recall", arguments: "{}" });
  });

  it("keeps the reasoning summary and sends the provider's reasoning details back on the next call", async () => {
    const details = [{ type: "reasoning.encrypted", data: "opaque" }];
    const { port, calls } = harness([
      chat(
        {
          role: "assistant",
          content: null,
          reasoning: "Check the notes first.",
          reasoning_details: details,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "recall", arguments: "{}" } }],
        },
        "tool_calls",
      ),
      chat({ role: "assistant", content: "done", reasoning_content: "All found." }),
    ]);

    const first = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(first.reasoning).toBe("Check the notes first.");
    expect(first.providerState).toEqual({ reasoning_details: details });

    const second = await port.complete(
      asks([
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: first.toolCalls, providerState: first.providerState! },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ]),
    );
    expect(second.reasoning).toBe("All found.");
    expect(second.providerState).toBeUndefined();
    expect(calls[1]?.body.messages[1]).toMatchObject({ role: "assistant", reasoning_details: details });
  });

  it("reads a content-parts reply as text", async () => {
    const { port } = harness([chat({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })]);
    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(reply.content).toBe("ab");
  });
});

describe("effort", () => {
  it("sends the effort under the configured field", async () => {
    const { port, calls } = harness([chat({ content: "a" })], { effortParam: "reasoning_effort" });
    await port.complete(asks([{ role: "user", content: "hi" }], { effort: "high" }));
    expect(calls[0]?.body.reasoning_effort).toBe("high");
  });

  it("ignores effort by default", async () => {
    const { port, calls } = harness([chat({ content: "a" })]);
    await port.complete(asks([{ role: "user", content: "hi" }], { effort: "high" }));
    expect("reasoning_effort" in (calls[0]?.body as object)).toBe(false);
  });
});

describe("tools off", () => {
  it("sends no tools and reports nativeTools false when nativeTools is false", async () => {
    const { port, calls } = harness([chat({ content: "a" })], { nativeTools: false });
    expect(port.info).toMatchObject({ id: "openai-compatible:test-model", contextTokens: 32000, nativeTools: false });
    await port.complete(
      asks([{ role: "user", content: "hi" }], {
        tools: [{ name: "recall", description: "d", parameters: {} }],
        toolChoice: "required",
      }),
    );
    expect("tools" in (calls[0]?.body as object)).toBe(false);
    expect("tool_choice" in (calls[0]?.body as object)).toBe(false);
  });
});

describe("retries", () => {
  it("retries a 429 and succeeds, waiting the first backoff step", async () => {
    const { port, calls, sleeps } = harness([status(429), chat({ content: "hi" })]);
    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(reply.content).toBe("hi");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("honors a retry-after seconds header", async () => {
    const { port, sleeps } = harness([status(429, {}, { "retry-after": "7" }), chat({ content: "hi" })]);
    await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(sleeps).toEqual([7000]);
  });

  it("backs off exponentially, capped at 30 s, then gives up as unavailable", async () => {
    const replies = Array.from({ length: 8 }, () => status(503));
    const { port, calls, sleeps } = harness(replies, { maxAttempts: 8 });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("unavailable");
    expect(err.attempts).toBe(8);
    expect(calls).toHaveLength(8);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("gives up on repeated 429 as rate_limit", async () => {
    const { port, sleeps } = harness([status(429), status(429)], { maxAttempts: 2 });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("rate_limit");
    expect(err.attempts).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("retries network errors, then reports unavailable when they persist", async () => {
    const recovered = harness([new TypeError("fetch failed"), chat({ content: "back" })]);
    const reply = await recovered.port.complete(asks([{ role: "user", content: "hi" }]));
    expect(reply.content).toBe("back");
    expect(recovered.sleeps).toEqual([1000]);

    const stuck = harness([new TypeError("fetch failed"), new TypeError("fetch failed")], { maxAttempts: 2 });
    const err = await errorOf(stuck.port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("unavailable");
    expect(err.attempts).toBe(2);
  });

  it("stops retrying when the caller aborts during a backoff wait", async () => {
    const controller = new AbortController();
    const fake = fakeFetch([status(503), chat({ content: "never" })]);
    const port = createOpenAICompatiblePort({
      baseUrl: "https://llm.example.test/v1",
      model: "m",
      contextTokens: 1000,
      fetch: fake.fetch,
      sleep: async () => controller.abort(),
    });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }]), controller.signal));
    expect(err.kind).toBe("aborted");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("final errors", () => {
  it("402 is out of credit and is not retried, and so is a 429 that names an insufficient quota", async () => {
    const paid = harness([status(402)]);
    const err = await errorOf(paid.port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
    expect(err.attempts).toBe(1);
    expect(paid.calls).toHaveLength(1);
    expect(paid.sleeps).toEqual([]);

    const quota = harness([status(429, { error: { message: "You exceeded your quota.", code: "insufficient_quota" } })]);
    const quotaErr = await errorOf(quota.port.complete(asks([{ role: "user", content: "hi" }])));
    expect(quotaErr.kind).toBe("out_of_credit");
    expect(quota.calls).toHaveLength(1);
    expect(quota.sleeps).toEqual([]);
  });

  it("401 is auth and is not retried", async () => {
    const { port, calls, sleeps } = harness([status(401)]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("auth");
    expect(err.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("400 and 404 are bad_request and are not retried, with the provider's message", async () => {
    const bad = harness([status(400, { error: { message: "unknown model name" } })]);
    const badErr = await errorOf(bad.port.complete(asks([{ role: "user", content: "hi" }])));
    expect(badErr.kind).toBe("bad_request");
    expect(badErr.message).toContain("unknown model name");
    expect(badErr.attempts).toBe(1);

    const missing = harness([status(404)]);
    const missingErr = await errorOf(missing.port.complete(asks([{ role: "user", content: "hi" }])));
    expect(missingErr.kind).toBe("bad_request");
    expect(missing.calls).toHaveLength(1);
  });

  it("a non-JSON body is malformed", async () => {
    const { port } = harness([new Response("<html>gateway</html>", { status: 200 })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("malformed");
    expect(err.attempts).toBe(1);
  });

  it("a reply with no choices is malformed", async () => {
    const empty = harness([ok({})]);
    expect((await errorOf(empty.port.complete(asks([{ role: "user", content: "hi" }])))).kind).toBe("malformed");

    const none = harness([ok({ choices: [] })]);
    expect((await errorOf(none.port.complete(asks([{ role: "user", content: "hi" }])))).kind).toBe("malformed");
  });

  it("a per-attempt timeout is timeout and is not retried", async () => {
    const { port, calls } = harness(["hang"], { timeoutMs: 20 });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("timeout");
    expect(err.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("a caller abort in flight is aborted", async () => {
    const { port } = harness(["hang"]);
    const controller = new AbortController();
    const pending = port.complete(asks([{ role: "user", content: "hi" }]), controller.signal);
    setTimeout(() => controller.abort(), 5);
    const err = await errorOf(pending);
    expect(err.kind).toBe("aborted");
  });

  it("an already-aborted signal makes no request", async () => {
    const { port, calls } = harness([chat({ content: "x" })]);
    const controller = new AbortController();
    controller.abort();
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }]), controller.signal));
    expect(err.kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("never puts the key into an error message", async () => {
    const scenarios: Array<() => Reply[]> = [
      () => [status(401, { error: { message: `bad key ${KEY}` } })],
      () => [status(403, { error: { message: `bad key ${KEY}` } })],
      () => [status(400, { error: { message: `echoed ${KEY} back` } })],
      () => [new TypeError(`fetch failed for ${KEY}`), new TypeError(`fetch failed for ${KEY}`)],
      () => [new Response(`garbage ${KEY}`, { status: 200 })],
      () => [status(503, { error: { message: KEY } }), status(503), status(503), status(503)],
      () => [status(404, { error: { message: `no such model, key ${KEY}` } })],
    ];
    for (const scenario of scenarios) {
      const { port } = harness(scenario(), { maxAttempts: 2 });
      const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
      expect(err).toBeInstanceOf(ModelError);
      expect(err.message).not.toContain(KEY);
    }
  });
});
