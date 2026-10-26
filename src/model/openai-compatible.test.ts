import { describe, expect, it, vi } from "vitest";
import { ModelError } from "../contracts.js";
import type { ModelRequest, ToolSpec } from "../contracts.js";
import { createOpenAICompatiblePort } from "./openai-compatible.js";
import { planRetry } from "../entity/retry-plan.js";

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

  it("keeps the cached-prompt counts in both shapes the providers send, and none when they are not reported", async () => {
    const { port } = harness([
      // DeepSeek-style: hit and miss counts at the top of usage.
      ok({
        choices: [{ message: { content: "a" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
      }),
      // OpenAI-style: cached tokens inside the prompt details; no miss count is sent, so none is kept.
      ok({
        choices: [{ message: { content: "b" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
      }),
      // Neither shape: nothing about the cache is kept.
      ok({
        choices: [{ message: { content: "c" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      }),
    ]);
    const asked = asks([{ role: "user", content: "hi" }]);
    expect((await port.complete(asked)).usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
    });
    expect((await port.complete(asked)).usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheHitTokens: 64 });
    expect((await port.complete(asked)).usage).toEqual({ inputTokens: 100, outputTokens: 5 });
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
    expect(second.providerState).toEqual({ reasoning_content: "All found." });
    expect(calls[1]?.body.messages[1]).toMatchObject({ role: "assistant", reasoning_details: details });
    // Reasoning in the reasoning field is kept as the summary but not sent back: only reasoning_content is asked for.
    expect(calls[1]?.body.messages[1]).not.toHaveProperty("reasoning");
  });

  it("sends a thinking model's reasoning_content back on the turn's next call, as it came", async () => {
    const { port, calls } = harness([
      chat(
        {
          role: "assistant",
          content: null,
          reasoning_content: "Read the board first.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "recall", arguments: "{}" } }],
        },
        "tool_calls",
      ),
      chat({ role: "assistant", content: "done" }),
    ]);

    const first = await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(first.providerState).toEqual({ reasoning_content: "Read the board first." });
    await port.complete(
      asks([
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: first.toolCalls, providerState: first.providerState! },
        { role: "tool", toolCallId: "call_1", content: "ok" },
      ]),
    );
    expect(calls[1]?.body.messages[1]).toMatchObject({ role: "assistant", reasoning_content: "Read the board first." });
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

describe("long waits and the call's limit", () => {
  it("a Retry-After over 60 s is not waited out: the call fails at once as a rate limit, so a backup can answer", async () => {
    const lines: string[] = [];
    const { port, calls, sleeps } = harness([status(429, {}, { "retry-after": "7200" }), chat({ content: "never" })], { log: (l: string) => lines.push(l) });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("rate_limit");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(lines.join("\n")).toMatch(/retry-after 7200000 ms is over 60000 ms/);
  });

  it("a Retry-After of 60 s or less is still waited, and the plain backoff stays capped at 30 s", async () => {
    const { port, sleeps } = harness([status(429, {}, { "retry-after": "60" }), chat({ content: "hi" })]);
    expect((await port.complete(asks([{ role: "user", content: "hi" }]))).content).toBe("hi");
    expect(sleeps).toEqual([60000]);
  });

  it("no wait starts past the call's overall limit: the call fails as a timeout", async () => {
    const { port, calls, sleeps } = harness([status(503, {}, { "retry-after": "30" }), chat({ content: "never" })], { callDeadlineMs: 5000 });
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("timeout");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("logs one line per retry with provider, model, status, attempt and wait, and no body or key", async () => {
    const lines: string[] = [];
    const { port } = harness([status(503, { error: { message: "secret-body-text" } }), chat({ content: "hi" })], { log: (l: string) => lines.push(l), apiKey: "sk-test-key-123" });
    await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/llm\.example\.test .* HTTP 503, attempt 1\/4, waiting 1000 ms/);
    expect(lines[0]).not.toMatch(/secret-body-text|sk-test-key-123/);
  });
});

describe("quota bodies are final", () => {
  it.each([
    { error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." } },
    { error: { message: "Subscription quota exceeded for this period." } },
    { error: { message: "Insufficient credits. Add credits to continue." } },
    { message: "Usage limit reached for your plan" },
    { error: { message: "Billing hard limit has been reached" } },
  ])("429 %j is out of credit, not retried", async (body) => {
    const { port, calls, sleeps } = harness([status(429, body), chat({ content: "never" })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("the default wait", () => {
  it("clears its timer when the caller aborts, so a stopping process is not kept alive", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fake = fakeFetch([status(503), chat({ content: "never" })]);
      const port = createOpenAICompatiblePort({ baseUrl: "https://llm.example.test/v1", model: "m", contextTokens: 1000, fetch: fake.fetch, log: () => {} });
      const pending = port.complete(asks([{ role: "user", content: "hi" }]), controller.signal).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      const err = (await pending) as { kind: string };
      expect(err.kind).toBe("aborted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

describe("cache marks", () => {
  const WHO = "## who\nA Lar.";
  const SYSTEM = `${WHO}\n\n## nature\nA voice.`;
  const RECENT = "Recent here:\nrow one";
  const USER = `${RECENT}\n\nNew:\nrow two`;
  const layoutedSystem = { role: "system" as const, content: SYSTEM, layout: [
    { name: "who", cls: "fixed" as const, end: WHO.length },
    { name: "nature", cls: "notes" as const, end: SYSTEM.length },
  ] };
  const layoutedUser = { role: "user" as const, content: USER, layout: [
    { name: "recent", cls: "page" as const, end: RECENT.length },
    { name: "new", cls: "turn" as const, end: USER.length },
  ] };
  const marked = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });

  it("sends the same wire body as before when cache marks are off, layouts or not", async () => {
    const withLayout = harness([chat({ role: "assistant", content: "ok" })]);
    const withoutLayout = harness([chat({ role: "assistant", content: "ok" })]);

    await withLayout.port.complete(asks([layoutedSystem, layoutedUser]));
    await withoutLayout.port.complete(
      asks([{ role: "system", content: SYSTEM }, { role: "user", content: USER }]),
    );

    expect(withLayout.calls[0]?.body).toEqual(withoutLayout.calls[0]?.body);
    expect(withLayout.calls[0]?.body.messages[0].content).toBe(SYSTEM);
    expect(withLayout.calls[0]?.body.messages[1].content).toBe(USER);
  });

  it("sends the system and user text as text parts, with a mark at the end of the page, the system and the last message", async () => {
    const { port, calls } = harness([chat({ role: "assistant", content: "ok" })], { cacheMarks: true });

    await port.complete(asks([layoutedSystem, layoutedUser]));

    const [system, user] = calls[0]?.body.messages ?? [];
    expect(system.content).toEqual([marked(SYSTEM)]);
    expect(user.content).toEqual([marked(RECENT), marked("\n\nNew:\nrow two")]);
  });

  it("keeps the pictures after the text parts when marks are on", async () => {
    const { port, calls } = harness([chat({ role: "assistant", content: "ok" })], { cacheMarks: true });
    const images = [{ type: "image" as const, mime: "image/png", dataBase64: "AAAA" }];

    await port.complete(asks([layoutedSystem, { ...layoutedUser, images }]));

    const user = calls[0]?.body.messages[1];
    expect(user.content.at(-1)).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    expect(user.content.slice(0, -1)).toEqual([marked(RECENT), marked("\n\nNew:\nrow two")]);
  });

  it("moves the last-message mark to the tool message that ends a tool loop, and leaves an unmarked assistant message as text", async () => {
    const { port, calls } = harness([chat({ role: "assistant", content: "ok" })], { cacheMarks: true });
    const messages: ModelRequest["messages"] = [
      layoutedSystem,
      layoutedUser,
      { role: "assistant", content: "Reading.", toolCalls: [{ id: "c1", name: "read_note", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "{\"ok\":true}" },
    ];

    await port.complete(asks(messages));

    const wire = calls[0]?.body.messages;
    expect(wire[2].content).toBe("Reading.");
    expect(wire[3].content).toEqual([marked("{\"ok\":true}")]);
    expect(JSON.stringify(wire).match(/cache_control/g)).toHaveLength(3);
  });

  it("sends no mark on a request built without layouts, beyond the last message", async () => {
    const { port, calls } = harness([chat({ role: "assistant", content: "ok" })], { cacheMarks: true });

    await port.complete(asks([{ role: "system", content: SYSTEM }, { role: "user", content: USER }]));

    expect(calls[0]?.body.messages[0].content).toEqual([{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }]);
    expect(calls[0]?.body.messages[1].content).toEqual([marked(USER)]);
  });
});

describe("headers and effort map", () => {
  it("sends the configured headers, and the key header always wins", async () => {
    const { port, calls } = harness([chat({ content: "ok" })], {
      headers: { "x-session": "s-1", "user-agent": "natalis-test", authorization: "Bearer other" },
    });
    await port.complete(asks([{ role: "user", content: "hi" }]));
    expect(calls[0]?.headers["x-session"]).toBe("s-1");
    expect(calls[0]?.headers["user-agent"]).toBe("natalis-test");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends an effort under its mapped wire value, and an unmapped effort as it is", async () => {
    const { port, calls } = harness([chat({ content: "a" }), chat({ content: "b" })], {
      effortParam: "reasoning_effort",
      effortMap: { xhigh: "max" },
    });
    await port.complete(asks([{ role: "user", content: "hi" }], { effort: "xhigh" }));
    await port.complete(asks([{ role: "user", content: "hi" }], { effort: "low" }));
    expect(calls[0]?.body.reasoning_effort).toBe("max");
    expect(calls[1]?.body.reasoning_effort).toBe("low");
  });

  it("leaves reasoning items from a /responses reply out of a chat request", async () => {
    const { port, calls } = harness([chat({ content: "ok" })]);
    await port.complete(asks([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "recall", arguments: "{}" }],
        providerState: { responsesReasoning: [{ type: "reasoning", encrypted_content: "x" }], reasoning_details: [1] },
      },
      { role: "tool", toolCallId: "c1", content: "found" },
    ]));
    const assistant = calls[0]?.body.messages[1];
    expect(assistant.responsesReasoning).toBeUndefined();
    expect(assistant.reasoning_details).toEqual([1]);
  });
});

describe("the responses protocol", () => {
  const responses = (output: unknown[], extra: Record<string, unknown> = {}): Response =>
    ok({ object: "response", status: "completed", output, ...extra });

  it("posts to /responses with messages as input items, flat tools, stateless storage and the effort under reasoning", async () => {
    const tools: ToolSpec[] = [{ name: "recall", description: "Find a note.", parameters: { type: "object" } }];
    const { port, calls } = harness([responses([{ type: "message", content: [{ type: "output_text", text: "hi" }] }])], {
      api: "responses",
      effortParam: "reasoning_effort",
    });
    await port.complete(asks(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Look.", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] },
      ],
      { tools, toolChoice: "auto", maxOutputTokens: 500, effort: "high" },
    ));
    expect(calls[0]?.url).toBe("https://llm.example.test/v1/responses");
    expect(calls[0]?.body).toEqual({
      model: "test-model",
      input: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Look." },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "recall", description: "Find a note.", parameters: { type: "object" } }],
      tool_choice: "auto",
      max_output_tokens: 500,
      reasoning: { effort: "high" },
    });
  });

  it("reads text, tool calls, the reasoning summary and usage, and sends the reasoning items back before the calls", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need the note." }], encrypted_content: "enc" };
    const { port, calls } = harness([
      responses(
        [
          reasoning,
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
          { type: "function_call", call_id: "fc_1", name: "recall", arguments: "{\"q\":\"x\"}" },
        ],
        { usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940, input_tokens_details: { cached_tokens: 800 } } },
      ),
      responses([{ type: "message", content: [{ type: "output_text", text: "Found it." }] }]),
    ], { api: "responses" });

    const first = await port.complete(asks([{ role: "user", content: "Find x." }]));
    expect(first.content).toBe("Let me look.");
    expect(first.toolCalls).toEqual([{ id: "fc_1", name: "recall", arguments: "{\"q\":\"x\"}" }]);
    expect(first.finish).toBe("tool_calls");
    expect(first.reasoning).toBe("Need the note.");
    expect(first.usage).toEqual({ inputTokens: 900, outputTokens: 40, totalTokens: 940, cacheHitTokens: 800 });

    const second = await port.complete(asks([
      { role: "user", content: "Find x." },
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, providerState: first.providerState },
      { role: "tool", toolCallId: "fc_1", content: "x is here" },
    ]));
    expect(second.content).toBe("Found it.");
    expect(second.finish).toBe("stop");
    expect(calls[1]?.body.input).toEqual([
      { role: "user", content: "Find x." },
      reasoning,
      { role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "fc_1", name: "recall", arguments: "{\"q\":\"x\"}" },
      { type: "function_call_output", call_id: "fc_1", output: "x is here" },
    ]);
  });

  it("maps an incomplete reply to its reason, and a failed one to an unavailable error", async () => {
    const { port } = harness([
      responses([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      responses([], { status: "failed", error: { message: "server fault" } }),
    ], { api: "responses" });
    expect((await port.complete(asks([{ role: "user", content: "hi" }]))).finish).toBe("length");
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("unavailable");
    expect(err.message).toContain("server fault");
  });

  it("treats a reply with no output list as malformed, and a call with no name as malformed", async () => {
    const { port } = harness([ok({ status: "completed" }), responses([{ type: "function_call", call_id: "c" }])], { api: "responses" });
    expect((await errorOf(port.complete(asks([{ role: "user", content: "hi" }])))).kind).toBe("malformed");
    expect((await errorOf(port.complete(asks([{ role: "user", content: "hi" }])))).kind).toBe("malformed");
  });
});

describe("a streamed reply", () => {
  /** A stream of server-sent events: each piece as one data line, then [DONE] unless `end` is false. */
  const sse = (pieces: unknown[], end = true): Response => {
    const lines = pieces.map((piece) => `data: ${JSON.stringify(piece)}\n\n`);
    if (end) lines.push("data: [DONE]\n\n");
    return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  /** A stream that sends its first pieces, then nothing until the call is aborted. */
  const stalls = (pieces: unknown[]): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(`data: ${JSON.stringify(piece)}\n\n`));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  it("asks for a stream with its token counts, and joins the pieces into one reply", async () => {
    const { port, calls } = harness(
      [
        sse([
          delta({ role: "assistant", reasoning_content: "The user " }),
          delta({ reasoning_content: "wants an echo." }),
          delta({ content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "" } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: "{\"text\":" } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: "\"hi\"}" } }] }),
          delta({}, "tool_calls"),
          { choices: [], usage: { prompt_tokens: 292, completion_tokens: 54, total_tokens: 346, prompt_tokens_details: { cached_tokens: 128 } } },
        ]),
      ],
      { stream: true },
    );

    const reply = await port.complete(asks([{ role: "user", content: "Call echo." }]));

    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(reply).toMatchObject({
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", arguments: "{\"text\":\"hi\"}" }],
      finish: "tool_calls",
      reasoning: "The user wants an echo.",
      usage: { inputTokens: 292, outputTokens: 54, totalTokens: 346, cacheHitTokens: 128 },
      providerState: { reasoning_content: "The user wants an echo." },
    });
  });

  it("keeps streamed reasoning in the reasoning field as the summary, and does not send it back", async () => {
    const { port } = harness([sse([delta({ reasoning: "Plain thought." }), delta({ content: "ok" }, "stop")])], { stream: true });

    const reply = await port.complete(asks([{ role: "user", content: "Hi." }]));

    expect(reply.reasoning).toBe("Plain thought.");
    expect(reply.providerState).toBeUndefined();
  });

  it("keeps two tool calls apart by their index, and words with no tool call", async () => {
    const { port } = harness(
      [
        sse([
          delta({ tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] }),
          delta({ tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "{}" } }] }),
          delta({}, "tool_calls"),
        ]),
        sse([delta({ content: "Hello" }), delta({ content: " there." }, "stop")]),
      ],
      { stream: true },
    );

    const both = await port.complete(asks([{ role: "user", content: "two" }]));
    expect(both.toolCalls.map((c) => c.name)).toEqual(["first", "second"]);

    const words = await port.complete(asks([{ role: "user", content: "words" }]));
    expect(words).toMatchObject({ content: "Hello there.", toolCalls: [], finish: "stop" });
  });

  it("fails as a timeout when the stream goes silent, so a backup can answer", async () => {
    const { port } = harness([stalls([delta({ reasoning_content: "Thinking" })])], { stream: true, idleTimeoutMs: 30 });

    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure.kind).toBe("timeout");
    expect(failure.message).toBe("the model service sent nothing for 30 ms");
  });

  it("fails as a timeout when nothing at all comes back, not even the headers", async () => {
    const { port } = harness(["hang"], { stream: true, idleTimeoutMs: 30 });

    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure).toMatchObject({ kind: "timeout", message: "the model service sent nothing for 30 ms" });
  });

  it("without a stream, a set silence limit bounds each attempt (the muse backup on the responses protocol)", async () => {
    // P1-3 (polish audit 2026-10-26): a non-streaming backup had no silence watch, only the 15 min attempt limit.
    const { port } = harness(["hang"], { api: "responses", idleTimeoutMs: 30, timeoutMs: 60_000, maxAttempts: 1 });

    const started = Date.now();
    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure).toMatchObject({ kind: "timeout", message: "the model service sent nothing for 30 ms" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("S-C: after a silence cut without a stream, the next try gets the full attempt limit, so a slow reply ends", async () => {
    // Every answer takes 60 ms; the silence cap is 30 ms. Before S-C every try was cut and the call never succeeded.
    const body = () => ok({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "slow but fine" }] }] });
    let calls = 0;
    const slowFetch: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(body()), 60);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    };
    const lines: string[] = [];
    const { port } = harness([], { api: "responses", idleTimeoutMs: 30, timeoutMs: 5_000, maxAttempts: 3, fetch: slowFetch, log: (l) => lines.push(l) });

    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));

    expect(reply.content).toBe("slow but fine");
    expect(calls).toBe(2);
    expect(lines.some((l) => l.includes("attempt cap without a stream"))).toBe(true);
  });

  it("R8 S1: a reply at 0.85 x timeoutMs after a cut fits in the call, and the next call on that thread is not cut again", async () => {
    // Scaled live ratio: idle = timeout/3, call slack 12 (120 s at x0.1). Every answer takes 77 ms (0.85 x 90).
    const body = () => ok({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "late" }] }] });
    let calls = 0;
    const slowFetch: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(body()), 77);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    };
    const { port } = harness([], { api: "responses", idleTimeoutMs: 30, timeoutMs: 90, callDeadlineMs: 102, maxAttempts: 3, fetch: slowFetch, log: () => {} });

    expect((await port.complete(asks([{ role: "user", content: "hi" }], { thread: "a" }))).content).toBe("late");
    expect(calls).toBe(2);
    expect((await port.complete(asks([{ role: "user", content: "again" }], { thread: "a" }))).content).toBe("late");
    expect(calls).toBe(3);
  });

  it("R8 N3: a cut uncaps only its own thread", async () => {
    const body = () => ok({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "late" }] }] });
    let calls = 0;
    const slowFetch: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(body()), 60);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    };
    const { port } = harness([], { api: "responses", idleTimeoutMs: 30, timeoutMs: 5_000, maxAttempts: 3, fetch: slowFetch, log: () => {} });

    await port.complete(asks([{ role: "user", content: "hi" }], { thread: "a" }));
    expect(calls).toBe(2);
    await port.complete(asks([{ role: "user", content: "hi" }], { thread: "b" }));
    expect(calls).toBe(4);
    await port.complete(asks([{ role: "user", content: "hi" }], { thread: "a" }));
    expect(calls).toBe(5);
  });

  it("without a stream and no silence limit set, only the attempt limit applies", async () => {
    const { port } = harness(["hang"], { api: "responses", timeoutMs: 40, maxAttempts: 1 });

    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure).toMatchObject({ kind: "timeout", message: "no reply from the model service within 40 ms" });
  });

  it("tries again when the stream is cut off before its end", async () => {
    const { port, calls } = harness(
      [sse([delta({ content: "Hel" })], false), sse([delta({ content: "Hello." }, "stop")])],
      { stream: true },
    );

    const reply = await port.complete(asks([{ role: "user", content: "hi" }]));

    expect(reply.content).toBe("Hello.");
    expect(calls).toHaveLength(2);
  });

  it("says when every try was cut off", async () => {
    const cut = () => sse([delta({ content: "Hel" })], false);
    const { port } = harness([cut(), cut()], { stream: true, maxAttempts: 2 });

    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure).toMatchObject({ kind: "unavailable", message: "model service stream was cut off before its end, after 2 attempts" });
  });

  it("treats an error the service sends inside the stream as an outage, without the key", async () => {
    const { port } = harness([sse([{ error: { message: `upstream overloaded for ${KEY}` } }])], { stream: true });

    const failure = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));

    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toBe("model service sent an error in its stream: upstream overloaded for [key removed]");
  });

  it("reads a plain JSON reply even when it asked for a stream", async () => {
    const { port } = harness([chat({ role: "assistant", content: "plain" })], { stream: true });
    expect((await port.complete(asks([{ role: "user", content: "hi" }]))).content).toBe("plain");
  });

  it("asks for no stream when stream is off, and never on the responses protocol", async () => {
    const off = harness([chat({ role: "assistant", content: "plain" })]);
    await off.port.complete(asks([{ role: "user", content: "hi" }]));
    expect(off.calls[0]?.body).not.toHaveProperty("stream");
    expect(off.calls[0]?.body).not.toHaveProperty("stream_options");

    const responses = harness(
      [ok({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }], status: "completed" })],
      { stream: true, api: "responses" },
    );
    await responses.port.complete(asks([{ role: "user", content: "hi" }]));
    expect(responses.calls[0]?.body).not.toHaveProperty("stream");
  });
});

describe("quota windows on a 429", () => {
  it("names the limit from OpenCode's GoUsageLimitError metadata and the reset from Retry-After", async () => {
    const body = { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" }, metadata: { limitName: "weekly" } };
    const { port } = harness([status(429, body, { "retry-after": "14102" })]);
    const before = Date.now();
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
    expect(err.quota?.limit).toBe("weekly");
    expect(err.quota?.resetAtMs).toBeGreaterThanOrEqual(before + 14_102_000);
    expect(err.quota?.resetAtMs).toBeLessThan(Date.now() + 14_102_000 + 1);
  });

  it("reads a 5-hour limit from the message words when there is no metadata, and no reset without Retry-After", async () => {
    const { port } = harness([status(429, { error: { message: "5-hour usage limit exceeded" } })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
    expect(err.quota).toEqual({ limit: "5-hour" });
  });
});

describe("AU-HANG round 6", () => {
  it("S2: a plain 'Rate limit exceeded' 429 is a rate limit, and takes the normal schedule", async () => {
    const { port } = harness([status(429, { error: { message: "Rate limit exceeded" } }), status(429, { error: { message: "Rate limit exceeded" } }), status(429, { error: { message: "Rate limit exceeded" } }), status(429, { error: { message: "Rate limit exceeded" } }), status(429, { error: { message: "Rate limit exceeded" } }), status(429, { error: { message: "Rate limit exceeded" } })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("rate_limit");
    const plan = planRetry({ delays: [30_000, 600_000], failed: 0, kind: err.kind, quota: err.quota, unknownQuotaFails: 0, nowMs: Date.now() });
    expect(plan.basis).toBe("schedule");
  });

  it("S-B: 'You have exceeded the rate limit for this model' is a rate limit on the normal schedule", async () => {
    const body = { error: { message: "You have exceeded the rate limit for this model" } };
    const { port } = harness([status(429, body), status(429, body), status(429, body), status(429, body), status(429, body), status(429, body)]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("rate_limit");
    const plan = planRetry({ delays: [30_000, 600_000], failed: 0, kind: err.kind, quota: err.quota, unknownQuotaFails: 0, nowMs: Date.now() });
    expect(plan.basis).toBe("schedule");
  });

  it("S-B: 'exceeded your usage limit' is out of credit", async () => {
    const { port } = harness([status(429, { error: { message: "You have exceeded your usage limit" } })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
  });

  it("S2: a 429 naming metadata.limitName is still out of credit", async () => {
    const { port } = harness([status(429, { error: { message: "Rate limit exceeded" }, metadata: { limitName: "weekly" } })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(err.kind).toBe("out_of_credit");
  });

  it("S3: a Retry-After HTTP date 3 h ahead becomes the reset", async () => {
    const date = new Date(Date.now() + 3 * 3600_000).toUTCString();
    const { port } = harness([status(429, { error: { message: "Go usage limit exceeded" } }, { "retry-after": date })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    const target = Date.parse(date);
    expect(Math.abs((err.quota?.resetAtMs ?? 0) - target)).toBeLessThan(5_000);
    const plan = planRetry({ delays: [30_000], failed: 0, kind: err.kind, quota: err.quota, unknownQuotaFails: 0, nowMs: Date.now() });
    expect(plan.basis).toBe("reset");
  });

  it("N1: an out-of-range Retry-After does not make planRetry throw", async () => {
    const { port } = harness([status(429, { error: { message: "Go usage limit exceeded" } }, { "retry-after": "9000000000000" })]);
    const err = await errorOf(port.complete(asks([{ role: "user", content: "hi" }])));
    expect(() => planRetry({ delays: [30_000], failed: 0, kind: err.kind, quota: err.quota, unknownQuotaFails: 0, nowMs: Date.now() })).not.toThrow();
  });
});
