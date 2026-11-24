import { describe, expect, it } from "vitest";
import { createEmbeddingsClient } from "./embeddings.js";
import type { EmbeddingsConfig } from "./embeddings-config.js";

// Every host and key here is invented. The key is built from parts so no token-shaped literal sits in this file.
const KEY = ["sk", "unit", "example"].join("-");

type Call = {
  url: string;
  model: string;
  input: string[];
  dimensions: number | undefined;
  authorization: string | undefined;
};

function config(overrides: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  return {
    baseUrl: "https://embed.example.test/v1/",
    model: "small-embed",
    apiKeyEnv: "NATALIS_EMBEDDINGS_KEY",
    batch: 64,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** A fetch that records each call and answers through `reply`. No network is touched. */
function fakeFetch(reply: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: string[];
      dimensions?: number;
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      model: body.model,
      input: body.input,
      dimensions: body.dimensions,
      authorization: headers["authorization"],
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function vectorsFor(texts: readonly string[], tag = 0): string {
  const data = texts.map((text, index) => ({ index, embedding: [text.length, tag] }));
  return JSON.stringify({ data });
}

describe("createEmbeddingsClient", () => {
  it("sends 130 texts as three requests with a batch of 64", async () => {
    const texts = Array.from({ length: 130 }, (_, n) => `text ${n}`);
    const fake = fakeFetch((call) => new Response(vectorsFor(call.input)));

    const client = createEmbeddingsClient(config({ batch: 64 }), { key: KEY, fetch: fake.fetch });
    const vectors = await client.embed(texts);

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((call) => call.input.length)).toEqual([64, 64, 2]);
    expect(vectors).toHaveLength(130);
    expect(fake.calls[0]?.url).toBe("https://embed.example.test/v1/embeddings");
    expect(fake.calls[0]?.model).toBe("small-embed");
    expect(fake.calls[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("returns the vectors in input order even when the service answers out of order", async () => {
    const fake = fakeFetch((call) => {
      const data = call.input.map((text, index) => ({ index, embedding: [text.length] })).reverse();
      return new Response(JSON.stringify({ data }));
    });

    const client = createEmbeddingsClient(config(), { key: KEY, fetch: fake.fetch });
    const vectors = await client.embed(["aaaa", "bb", "ccc"]);

    expect(vectors.map((vector) => vector[0])).toEqual([4, 2, 3]);
  });

  it("sends dimensions when the config names them", async () => {
    const fake = fakeFetch((call) => new Response(vectorsFor(call.input)));
    const client = createEmbeddingsClient(config({ dimensions: 128 }), { key: KEY, fetch: fake.fetch });

    await client.embed(["hello"]);

    expect(fake.calls[0]?.dimensions).toBe(128);
  });

  it("turns a 401 into an error that does not hold the key", async () => {
    const fake = fakeFetch(
      () => new Response(JSON.stringify({ error: `the key ${KEY} was refused` }), { status: 401 }),
    );
    const client = createEmbeddingsClient(config(), { key: KEY, fetch: fake.fetch });

    let message = "";
    try {
      await client.embed(["hello"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("embeddings: the service answered 401");
    expect(message).not.toContain(KEY);
  });

  it("throws when the service answers the wrong number of vectors", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })));
    const client = createEmbeddingsClient(config(), { key: KEY, fetch: fake.fetch });

    await expect(client.embed(["one", "two"])).rejects.toThrow(
      "embeddings: the service answered 1 vectors for 2 texts",
    );
  });

  it("throws when the service goes quiet", async () => {
    const fake = fakeFetch(() => new Promise<Response>(() => undefined));
    const client = createEmbeddingsClient(config({ timeoutMs: 20 }), { key: KEY, fetch: fake.fetch });

    await expect(client.embed(["hello"])).rejects.toThrow("embeddings: no answer from the service within 20 ms");
  });

  it("makes no request for empty input", async () => {
    const fake = fakeFetch(() => new Response(vectorsFor([])));
    const client = createEmbeddingsClient(config(), { key: KEY, fetch: fake.fetch });

    await expect(client.embed([])).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
