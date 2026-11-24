// The embeddings client: one adapter for any OpenAI-compatible /embeddings service. It sends a batch of texts, waits
// a bounded time, and returns one vector per text in the order the texts were given. The key reaches the request
// header and nowhere else: every failure is turned into a plain message with the key removed.

import type { EmbeddingsConfig } from "./embeddings-config.js";

export type EmbeddingsClient = {
  model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
};

const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
/** How much of a failure body a message keeps. */
const DETAIL_CHARS = 200;

export function createEmbeddingsClient(
  config: EmbeddingsConfig,
  options: { key: string; fetch?: typeof fetch },
): EmbeddingsClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const batchSize = Math.max(1, Math.floor(config.batch ?? DEFAULT_BATCH));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = options.key;
  const fetchFn = options.fetch ?? globalThis.fetch;

  /** A body or an error text with the key taken out and the length kept short. */
  const safe = (text: string): string => {
    const withoutKey = text.split(key).join("[key removed]");
    return withoutKey.length > DETAIL_CHARS ? `${withoutKey.slice(0, DETAIL_CHARS)}...` : withoutKey;
  };

  const request = async (texts: readonly string[], signal: AbortSignal | undefined): Promise<Float32Array[]> => {
    if (signal?.aborted) throw new Error("embeddings: the request was aborted");
    const body: Record<string, unknown> = { model: config.model, input: texts };
    if (config.dimensions !== undefined) body.dimensions = config.dimensions;

    const controller = new AbortController();
    let stop: (error: Error) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = reject;
    });
    // The timer bounds the request and the reading of its body, so a service that goes quiet cannot hold the call.
    const timer = setTimeout(() => {
      stop(new Error(`embeddings: no answer from the service within ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => {
      stop(new Error("embeddings: the request was aborted"));
      controller.abort();
    };
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    let text: string;
    try {
      const res = await Promise.race([
        fetchFn(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        stopped,
      ]);
      const read = Promise.race([res.text(), stopped]);
      text = await read;
      if (!res.ok) {
        const detail = text.trim() === "" ? "" : `: ${safe(text.trim())}`;
        throw new Error(`embeddings: the service answered ${res.status}${detail}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("embeddings:")) throw error;
      throw new Error(`embeddings: the service could not be reached: ${safe(message)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    return parseBatch(text, texts.length);
  };

  return {
    model: config.model,
    async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      let dims: number | undefined;
      for (let start = 0; start < texts.length; start += batchSize) {
        const vectors = await request(texts.slice(start, start + batchSize), signal);
        for (const vector of vectors) {
          if (vector.length === 0) throw new Error("embeddings: the service answered an empty vector for a text");
          if (dims === undefined) dims = vector.length;
          else if (vector.length !== dims) throw new Error("embeddings: the service answered vectors of different lengths");
          out.push(vector);
        }
      }
      return out;
    },
  };
}

/** Reads one reply into vectors in input order. Every part of the shape is checked, so a broken service fails loudly. */
function parseBatch(text: string, expected: number): Float32Array[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("embeddings: the service reply was not JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error("embeddings: the service reply had no data list");
  }
  if (parsed.data.length !== expected) {
    throw new Error(`embeddings: the service answered ${parsed.data.length} vectors for ${expected} texts`);
  }

  const items = parsed.data.map((raw: unknown, position: number) => {
    if (!isRecord(raw) || !Array.isArray(raw.embedding)) {
      throw new Error("embeddings: the service reply had an item with no embedding");
    }
    const vector = new Float32Array(raw.embedding.length);
    for (let i = 0; i < raw.embedding.length; i += 1) {
      const value: unknown = raw.embedding[i];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embeddings: the service reply had a vector value that is not a number");
      }
      vector[i] = value;
    }
    const index = typeof raw.index === "number" && Number.isSafeInteger(raw.index) ? raw.index : position;
    return { index, vector };
  });

  // The service may answer in any order; each item's index says which text it belongs to.
  items.sort((a, b) => a.index - b.index);
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position];
    if (item === undefined || item.index !== position) {
      throw new Error("embeddings: the service reply had indexes that do not match the request");
    }
  }
  return items.map((item) => item.vector);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
