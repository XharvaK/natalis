import { describe, expect, it } from "vitest";
import { parseEmbeddings } from "./embeddings-config.js";

// Every host and name here is invented. Nothing reads a real key.
const FULL = {
  baseUrl: "https://embed.example.test/v1",
  model: "small-embed",
  apiKeyEnv: "NATALIS_EMBEDDINGS_KEY",
  dimensions: 256,
  batch: 32,
  timeoutMs: 12_000,
};

describe("parseEmbeddings", () => {
  it("keeps a full valid block as it was given", () => {
    expect(parseEmbeddings(FULL)).toEqual(FULL);
  });

  it("fills in the batch and the timeout when they are left out", () => {
    const config = parseEmbeddings({
      baseUrl: "https://embed.example.test/v1",
      model: "small-embed",
      apiKeyEnv: "NATALIS_EMBEDDINGS_KEY",
    });

    expect(config).toEqual({
      baseUrl: "https://embed.example.test/v1",
      model: "small-embed",
      apiKeyEnv: "NATALIS_EMBEDDINGS_KEY",
      batch: 64,
      timeoutMs: 30_000,
    });
    expect(config.dimensions).toBeUndefined();
  });

  it("refuses a block that is not an object", () => {
    expect(() => parseEmbeddings([])).toThrow("embeddings must be an object.");
    expect(() => parseEmbeddings("small-embed")).toThrow("embeddings must be an object.");
    expect(() => parseEmbeddings(null)).toThrow("embeddings must be an object.");
  });

  it("refuses an unknown key", () => {
    expect(() => parseEmbeddings({ ...FULL, size: 256 })).toThrow('Unknown field "size" in embeddings.');
  });

  it("refuses a base URL that is not http or https", () => {
    expect(() => parseEmbeddings({ ...FULL, baseUrl: "not a url" })).toThrow(
      "embeddings.baseUrl must be a full http:// or https:// address.",
    );
    expect(() => parseEmbeddings({ ...FULL, baseUrl: "ftp://embed.example.test/v1" })).toThrow(
      "embeddings.baseUrl must start with http:// or https://.",
    );
  });

  it("refuses a blank model", () => {
    expect(() => parseEmbeddings({ ...FULL, model: "   " })).toThrow("embeddings.model must be a non-empty text.");
    expect(() => parseEmbeddings({ ...FULL, model: 7 })).toThrow("embeddings.model must be a non-empty text.");
  });

  it("refuses an env name that is not in capitals", () => {
    expect(() => parseEmbeddings({ ...FULL, apiKeyEnv: "natalis_key" })).toThrow(
      "embeddings.apiKeyEnv must be a name in capitals and digits",
    );
    expect(() => parseEmbeddings({ ...FULL, apiKeyEnv: "NATALIS-KEY" })).toThrow(
      "embeddings.apiKeyEnv must be a name in capitals and digits",
    );
  });

  it("refuses dimensions outside 64 to 4096", () => {
    expect(() => parseEmbeddings({ ...FULL, dimensions: 63 })).toThrow(
      "embeddings.dimensions must be a whole number from 64 to 4096.",
    );
    expect(() => parseEmbeddings({ ...FULL, dimensions: 4097 })).toThrow(
      "embeddings.dimensions must be a whole number from 64 to 4096.",
    );
    expect(() => parseEmbeddings({ ...FULL, dimensions: 128.5 })).toThrow(
      "embeddings.dimensions must be a whole number from 64 to 4096.",
    );
  });

  it("refuses a batch outside 1 to 256", () => {
    expect(() => parseEmbeddings({ ...FULL, batch: 0 })).toThrow(
      "embeddings.batch must be a whole number from 1 to 256.",
    );
    expect(() => parseEmbeddings({ ...FULL, batch: 257 })).toThrow(
      "embeddings.batch must be a whole number from 1 to 256.",
    );
  });

  it("refuses a timeout outside 1000 to 120000", () => {
    expect(() => parseEmbeddings({ ...FULL, timeoutMs: 999 })).toThrow(
      "embeddings.timeoutMs must be a whole number from 1000 to 120000.",
    );
    expect(() => parseEmbeddings({ ...FULL, timeoutMs: 120_001 })).toThrow(
      "embeddings.timeoutMs must be a whole number from 1000 to 120000.",
    );
  });
});
