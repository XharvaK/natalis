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
