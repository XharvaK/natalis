import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../contracts.js";
import { modelFromConfig, worldModelsFromConfig } from "./from-config.js";

// Built at runtime so no token-shaped literal sits in the repository.
const KEY = ["sk", "test", "abc123"].join("-");
const KEY_VAR = "NATALIS_TEST_MODEL_KEY";

const config = {
  baseUrl: "https://llm.example.test/v1",
  model: "test-model",
  apiKeyEnv: KEY_VAR,
  contextTokens: 16000,
};

const ask: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [{ name: "recall", description: "d", parameters: {} }] };

/** Stubs the global fetch and records what the port sent; the port reads it at call time. */
function stubFetch(): Array<{ headers: Record<string, string>; body: Record<string, unknown> }> {
  const sent: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent.push({
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
      });
    },
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("modelFromConfig", () => {
  it("names the environment variable, not its value, when the key is missing", () => {
    const env = { OTHER_VAR: KEY };
    expect(() => modelFromConfig(config, env)).toThrow(KEY_VAR);
    try {
      modelFromConfig(config, env);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(KEY);
    }
  });

  it("treats an empty key variable as missing", () => {
    expect(() => modelFromConfig(config, { [KEY_VAR]: "" })).toThrow(KEY_VAR);
  });

  it("reads the key from the named variable and sends it as a Bearer token", async () => {
    const sent = stubFetch();
    const port = modelFromConfig(config, { [KEY_VAR]: KEY });
    await port.complete(ask);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(port.info).toEqual({ id: "openai-compatible:test-model", contextTokens: 16000, nativeTools: true });
  });

  it("needs no key when no key variable is named", async () => {
    const sent = stubFetch();
    const { apiKeyEnv: _unused, ...keyless } = config;
    void _unused;
    const port = modelFromConfig(keyless, {});
    await port.complete(ask);
    expect(sent[0]?.headers.authorization).toBeUndefined();
  });

  it("wraps with emulation when nativeTools is false, so no tools are sent", async () => {
    const sent = stubFetch();
    const port = modelFromConfig({ ...config, nativeTools: false }, { [KEY_VAR]: KEY });
    expect(port.info.nativeTools).toBe(false);
    await port.complete(ask);
    expect("tools" in (sent[0]?.body ?? {})).toBe(false);
  });

  it("passes effort through when configured", async () => {
    const sent = stubFetch();
    const port = modelFromConfig({ ...config, effortParam: "reasoning_effort" }, { [KEY_VAR]: KEY });
    await port.complete({ messages: [{ role: "user", content: "hi" }], effort: "medium" });
    expect(sent[0]?.body.reasoning_effort).toBe("medium");
  });
});

describe("a backup model named in the model block", () => {
  type Sent = { model: string; authorization?: string; body: any };

  /** Routes each request by the model it names. A busy service answers at once: Retry-After 0 keeps the test quick. */
  function routeFetch(answer: (model: string) => Response): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      const headers = { ...(init?.headers as Record<string, string>) };
      sent.push({ model: body.model, authorization: headers.authorization, body });
      return answer(body.model);
    });
    return sent;
  }

  const busy = (): Response =>
    new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503, headers: { "retry-after": "0" } });
  const refused = (): Response =>
    new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
  const reply = (): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content: "from the backup" }, finish_reason: "stop" }] }), {
      status: 200,
    });

  const withPictures: ModelRequest = {
    messages: [{ role: "user", content: "Look.", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] }],
  };

  it("answers with the backup when the main model is unavailable, on the same service and key", async () => {
    const sent = routeFetch((model) => (model === "test-model" ? busy() : reply()));
    const port = modelFromConfig({ ...config, fallback: { model: "backup-model" } }, { [KEY_VAR]: KEY });

    const answer = await port.complete(ask);

    expect(answer).toMatchObject({ content: "from the backup", servedBy: "backup-model" });
    expect(sent.map((call) => call.model)).toEqual(["test-model", "test-model", "test-model", "test-model", "backup-model"]);
    expect(sent.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(port.info.id).toBe("openai-compatible:test-model");
  });

  it("is not used when the main model refuses the key", async () => {
    const sent = routeFetch(() => refused());
    const port = modelFromConfig({ ...config, fallback: { model: "backup-model" } }, { [KEY_VAR]: KEY });

    await expect(port.complete(ask)).rejects.toMatchObject({ kind: "auth" });
    expect(sent.map((call) => call.model)).toEqual(["test-model"]);
  });

  it("sends the backup without pictures unless the backup is marked vision", async () => {
    const sent = routeFetch((model) => (model === "test-model" ? busy() : reply()));
    const blind = modelFromConfig({ ...config, fallback: { model: "backup-model" } }, { [KEY_VAR]: KEY });
    await blind.complete(withPictures);
    const blindBackup = sent.find((call) => call.model === "backup-model");
    expect(JSON.stringify(blindBackup?.body)).not.toContain("image_url");
    expect(blindBackup?.body.messages[0].content).toContain("[A picture was here; the backup model cannot see it.]");

    sent.length = 0;
    const seeing = modelFromConfig({ ...config, fallback: { model: "backup-model", vision: true } }, { [KEY_VAR]: KEY });
    await seeing.complete(withPictures);
    const seeingBackup = sent.find((call) => call.model === "backup-model");
    expect(JSON.stringify(seeingBackup?.body)).toContain("image_url");
  });

  it("sends the backup effort through the same effort field, at the backup's own effort when it names one", async () => {
    const sent = routeFetch((model) => (model === "test-model" ? busy() : reply()));
    const inherit = modelFromConfig(
      { ...config, effortParam: "reasoning_effort", fallback: { model: "backup-model" } },
      { [KEY_VAR]: KEY },
    );
    await inherit.complete({ messages: [{ role: "user", content: "hi" }], effort: "medium" });
    expect(sent.find((call) => call.model === "test-model")?.body.reasoning_effort).toBe("medium");
    expect(sent.find((call) => call.model === "backup-model")?.body.reasoning_effort).toBe("medium");

    sent.length = 0;
    const own = modelFromConfig(
      { ...config, effortParam: "reasoning_effort", fallback: { model: "backup-model", effort: "xhigh" } },
      { [KEY_VAR]: KEY },
    );
    await own.complete({ messages: [{ role: "user", content: "hi" }], effort: "low" });
    expect(sent.find((call) => call.model === "backup-model")?.body.reasoning_effort).toBe("xhigh");
  });

  it("sends no effort to the backup when the backup names no effort field and the main model has none", async () => {
    const sent = routeFetch((model) => (model === "test-model" ? busy() : reply()));
    const port = modelFromConfig({ ...config, fallback: { model: "backup-model" } }, { [KEY_VAR]: KEY });
    await port.complete({ messages: [{ role: "user", content: "hi" }], effort: "high" });
    expect("reasoning_effort" in (sent.find((call) => call.model === "backup-model")?.body ?? {})).toBe(false);
  });

  it("is not sent to a backup whose context is smaller than the request, and the error says why", async () => {
    const sent = routeFetch(() => busy());
    const port = modelFromConfig({ ...config, fallback: { model: "backup-model", contextTokens: 100 } }, { [KEY_VAR]: KEY });
    const big: ModelRequest = { messages: [{ role: "user", content: "x".repeat(2000) }] };
    await expect(port.complete(big)).rejects.toThrow(/was not tried: this request is about 500 tokens, more than its 100-token context/);
    expect(sent.some((call) => call.model === "backup-model")).toBe(false);
  });

  it("keeps the no-tools setting of the main model for the backup too", async () => {
    const sent = routeFetch((model) => (model === "test-model" ? busy() : reply()));
    const port = modelFromConfig({ ...config, nativeTools: false, fallback: { model: "backup-model" } }, { [KEY_VAR]: KEY });
    const answer = await port.complete(ask);
    expect(answer.servedBy).toBe("backup-model");
    expect(sent.some((call) => "tools" in call.body)).toBe(false);
  });

  it("is not built at all when the block has no fallback", async () => {
    const sent = routeFetch(() => busy());
    const port = modelFromConfig(config, { [KEY_VAR]: KEY });
    await expect(port.complete(ask)).rejects.toMatchObject({ kind: "unavailable" });
    expect(sent.map((call) => call.model)).toEqual(["test-model", "test-model", "test-model", "test-model"]);
  });
});

describe("worldModelsFromConfig", () => {
  it("gives each listed world its own model on the same service, without pictures unless it can see", async () => {
    const sent = stubFetch();
    const ports = worldModelsFromConfig({ ...config, vision: true }, "high", { game: { model: "fast-model" } }, { [KEY_VAR]: KEY });
    expect(Object.keys(ports)).toEqual(["game"]);
    await ports["game"]?.complete({
      messages: [{ role: "user", content: "look", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] }],
    });
    expect(sent[0]?.body["model"]).toBe("fast-model");
    expect(JSON.stringify(sent[0]?.body)).not.toContain("image_url");
    expect(JSON.stringify(sent[0]?.body)).toContain("the backup model cannot see it");
  });

  it("gives no ports when no world has a model of its own", () => {
    expect(worldModelsFromConfig(config, undefined, undefined, { [KEY_VAR]: KEY })).toEqual({});
  });
});

describe("the routing of a world's own model", () => {
  it("keeps the backup's routing on a world model that cannot see pictures", () => {
    const ports = worldModelsFromConfig(config, "high", { game: { model: "fast-model" } }, { [KEY_VAR]: KEY });
    expect(ports["game"]?.routing?.()).toEqual({ onBackup: false, backup: config.model, backupEffort: "high" });
  });
});

describe("cacheMarks in the model block", () => {
  const system = { role: "system" as const, content: "## who\nA Lar.", layout: [{ name: "who", cls: "fixed" as const, end: 12 }] };
  const turn: ModelRequest = { messages: [system, { role: "user", content: "hi" }] };

  it("is off by default: the system text goes out as a plain string", async () => {
    const sent = stubFetch();
    await modelFromConfig(config, { [KEY_VAR]: KEY }).complete(turn);

    expect(sent[0]?.body.messages).toEqual([{ role: "system", content: "## who\nA Lar." }, { role: "user", content: "hi" }]);
  });

  it("passes the switch to the main model's port, so the system text goes out as marked parts", async () => {
    const sent = stubFetch();
    await modelFromConfig({ ...config, cacheMarks: true }, { [KEY_VAR]: KEY }).complete(turn);

    expect(sent[0]?.body.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "## who\nA Lar.", cache_control: { type: "ephemeral" } }],
    });
  });
});

describe("protocol, headers and effort map in the model block", () => {
  type Sent = { url: string; headers: Record<string, string>; body: any };

  /** Records each request; the model named busy answers 503 at once, the others answer in their protocol's shape. */
  function routeFetch(busyModel: string): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body });
      if (body.model === busyModel) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503, headers: { "retry-after": "0" } });
      }
      return String(url).endsWith("/responses")
        ? new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "r" }] }] }))
        : new Response(JSON.stringify({ choices: [{ message: { content: "c" }, finish_reason: "stop" }] }));
    });
    return sent;
  }

  it("sends the backup on its own protocol with the shared headers, and the main model's effort map stays the main model's", async () => {
    const sent = routeFetch("test-model");
    const port = modelFromConfig(
      {
        ...config,
        effortParam: "reasoning_effort",
        effortMap: { xhigh: "max" },
        headers: { "x-session": "s-1" },
        fallback: { model: "backup-model", api: "responses" },
      },
      { [KEY_VAR]: KEY },
    );
    const answer = await port.complete({ ...ask, effort: "xhigh" });
    expect(answer.content).toBe("r");
    const main = sent.find((s) => s.body.model === "test-model");
    const backup = sent.find((s) => s.body.model === "backup-model");
    expect(main?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(main?.body.reasoning_effort).toBe("max");
    expect(backup?.url).toBe("https://llm.example.test/v1/responses");
    expect(backup?.body.reasoning).toEqual({ effort: "xhigh" });
    expect(backup?.headers["x-session"]).toBe("s-1");
  });

  it("falls a world model back to the main model on the main model's protocol and effort map", async () => {
    const sent = routeFetch("fast-model");
    const ports = worldModelsFromConfig(
      { ...config, effortParam: "reasoning_effort", effortMap: { xhigh: "max" } },
      "xhigh",
      { game: { model: "fast-model", api: "responses" } },
      { [KEY_VAR]: KEY },
    );
    await ports["game"]?.complete({ ...ask, effort: "high" });
    const world = sent.find((s) => s.body.model === "fast-model");
    const main = sent.find((s) => s.body.model === "test-model");
    expect(world?.url).toBe("https://llm.example.test/v1/responses");
    expect(world?.body.reasoning).toEqual({ effort: "high" });
    expect(main?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(main?.body.reasoning_effort).toBe("max");
  });
});

describe("a chain of backups, and a backup on a service of its own", () => {
  type Sent = { url: string; headers: Record<string, string>; model: string };
  const OTHER_KEY = ["sk", "other", "xyz789"].join("-");
  const OTHER_VAR = "NATALIS_TEST_OTHER_KEY";
  const env = { [KEY_VAR]: KEY, [OTHER_VAR]: OTHER_KEY };
  const other = "https://other.example.test/v1";

  /** Each model named in busy answers 503 at once; the others answer. */
  function routeFetch(busy: string[]): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, model: body.model });
      if (busy.includes(body.model)) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: `from ${body.model}` }, finish_reason: "stop" }] }));
    });
    return sent;
  }

  const chain = {
    ...config,
    headers: { "x-workspace": "w-1" },
    fallback: {
      model: "second",
      fallback: { model: "third", baseUrl: other, apiKeyEnv: OTHER_VAR, effort: "high" as const },
    },
  };

  it("goes down the chain, names the model that answered, and gives a backup on its own service only its own key and headers", async () => {
    const sent = routeFetch(["test-model", "second"]);
    const port = modelFromConfig(chain, env);

    const answer = await port.complete({ ...ask, effort: "low" });

    expect(answer).toMatchObject({ content: "from third", servedBy: "third" });
    const second = sent.find((s) => s.model === "second");
    const third = sent.find((s) => s.model === "third");
    expect(second?.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(second?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(second?.headers["x-workspace"]).toBe("w-1");
    expect(third?.url).toBe(`${other}/chat/completions`);
    expect(third?.headers["authorization"]).toBe(`Bearer ${OTHER_KEY}`);
    expect(third?.headers["x-workspace"]).toBeUndefined();
    expect(answer.mainError).toContain("; then second: ");
    // The next turn tries the main model first, so as it starts the main model is named.
    expect(port.routing?.()).toMatchObject({ onBackup: false, backup: "second" });
  });

  it("names the first backup when it is the one answering", async () => {
    routeFetch(["test-model"]);
    const port = modelFromConfig(chain, env);
    expect(port.routing?.()).toMatchObject({ onBackup: false, backup: "second" });
    const answer = await port.complete(ask);
    expect(answer.servedBy).toBe("second");
  });

  it("refuses a backup on its own service whose key variable is not set", () => {
    expect(() => modelFromConfig(chain, { [KEY_VAR]: KEY })).toThrow(`names the environment variable ${OTHER_VAR}`);
  });

  it("falls a world model back to its own chain, not to the main model", async () => {
    const sent = routeFetch(["fast-model"]);
    const ports = worldModelsFromConfig(
      config,
      "high",
      { game: { model: "fast-model", effort: "low", fallback: { model: "fast-elsewhere", baseUrl: other, apiKeyEnv: OTHER_VAR, effort: "low" } } },
      env,
    );
    const answer = await ports["game"]!.complete({ ...ask, effort: "low" });
    expect(answer).toMatchObject({ content: "from fast-elsewhere", servedBy: "fast-elsewhere" });
    expect(sent.some((s) => s.model === "test-model")).toBe(false);
  });
});

describe("streaming down a chain of backups", () => {
  /** Each model named in busy answers 503; the others answer with a plain reply. Records each model's request body. */
  function bodies(busy: string[]): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (busy.includes(String(body["model"]))) return new Response("{}", { status: 503, headers: { "retry-after": "0" } });
      if (body["input"] !== undefined) {
        return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
    return sent;
  }
  const env = { [KEY_VAR]: KEY };

  it("gives a chat backup the main model's stream, and never asks a responses backup for one", async () => {
    const sent = bodies(["test-model", "second"]);
    const port = modelFromConfig(
      { ...config, stream: true, fallback: { model: "second", fallback: { model: "third", api: "responses" } } },
      env,
    );

    await port.complete(ask);

    const of = (name: string) => sent.find((body) => body["model"] === name);
    expect(of("test-model")?.["stream"]).toBe(true);
    expect(of("second")?.["stream"]).toBe(true);
    expect(of("third")).not.toHaveProperty("stream");
  });

  it("lets a backup turn the stream off for itself", async () => {
    const sent = bodies(["test-model"]);
    const port = modelFromConfig({ ...config, stream: true, fallback: { model: "second", stream: false } }, env);

    await port.complete(ask);

    expect(sent.find((body) => body["model"] === "second")).not.toHaveProperty("stream");
  });
});
