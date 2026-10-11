import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "../contracts.js";
import { modelFromConfig } from "./from-config.js";

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
