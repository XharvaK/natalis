// The embeddings block of entity.json: where recall by meaning sends its texts, which model makes the vectors, and
// which environment variable holds the key. The key itself is never written here, only the name of its variable.

export type EmbeddingsConfig = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  dimensions?: number;
  batch?: number;
  timeoutMs?: number;
};

const DEFAULT_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 30_000;

const ALLOWED_KEYS = ["baseUrl", "model", "apiKeyEnv", "dimensions", "batch", "timeoutMs"] as const;

/** Validates the `embeddings` part of entity.json. Absent batch and timeoutMs take their defaults. */
export function parseEmbeddings(value: unknown): EmbeddingsConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("embeddings must be an object.");
  }
  const block = value as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown field "${key}" in embeddings. Allowed: ${ALLOWED_KEYS.join(", ")}.`);
    }
  }

  const config: EmbeddingsConfig = {
    baseUrl: baseUrlOf(block["baseUrl"]),
    model: textOf(block["model"], "embeddings.model"),
    apiKeyEnv: keyEnvOf(block["apiKeyEnv"]),
    batch: block["batch"] === undefined ? DEFAULT_BATCH : wholeNumber(block["batch"], "embeddings.batch", 1, 256),
    timeoutMs:
      block["timeoutMs"] === undefined
        ? DEFAULT_TIMEOUT_MS
        : wholeNumber(block["timeoutMs"], "embeddings.timeoutMs", 1_000, 120_000),
  };
  if (block["dimensions"] !== undefined) {
    config.dimensions = wholeNumber(block["dimensions"], "embeddings.dimensions", 64, 4096);
  }
  return config;
}

function baseUrlOf(value: unknown): string {
  const baseUrl = textOf(value, "embeddings.baseUrl");
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new Error("embeddings.baseUrl must be a full http:// or https:// address.");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("embeddings.baseUrl must start with http:// or https://.");
  }
  return baseUrl;
}

function keyEnvOf(value: unknown): string {
  const name = textOf(value, "embeddings.apiKeyEnv");
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error("embeddings.apiKeyEnv must be a name in capitals and digits, such as NATALIS_EMBEDDINGS_KEY.");
  }
  return name;
}

function textOf(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty text.`);
  return value.trim();
}

function wholeNumber(value: unknown, where: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw new Error(`${where} must be a whole number from ${low} to ${high}.`);
  }
  return value;
}
