import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingsClient } from "../model/embeddings.js";
import { indexItems, openEmbeddings, type EmbeddingStore, type IndexItem, type NewEmbedding } from "./embeddings.js";
import { openRiver } from "./sqlite-river.js";

// Every name, note and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const MODEL = "small-embed";

let dir: string;
let store: EmbeddingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-embeddings-store-"));
  store = openEmbeddings(join(dir, "river.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function row(
  key: string,
  values: number[],
  options: { seq?: number; private?: boolean; hash?: string; model?: string } = {},
): NewEmbedding {
  return {
    kind: "row",
    key,
    seq: options.seq ?? Number(key),
    model: options.model ?? MODEL,
    private: options.private ?? false,
    hash: options.hash ?? `hash-${key}`,
    vec: new Float32Array(values),
    atMs: NOW,
  };
}

function note(key: string, values: number[], options: { private?: boolean; hash?: string } = {}): NewEmbedding {
  return {
    kind: "note",
    key,
    model: MODEL,
    private: options.private ?? false,
    hash: options.hash ?? `hash-${key}`,
    vec: new Float32Array(values),
    atMs: NOW,
  };
}

describe("EmbeddingStore", () => {
  it("ranks the closer vector first", () => {
    store.put([row("1", [1, 0]), row("2", [0, 1])]);

    const hits = store.search(new Float32Array([0.9, 0.1]), {
      model: MODEL,
      includePrivate: false,
      limit: 10,
    });

    expect(hits.map((hit) => hit.key)).toEqual(["1", "2"]);
    expect(hits[0]?.kind).toBe("row");
    expect(hits[0]?.seq).toBe(1);
    expect(hits[0]?.score).toBeCloseTo(0.9939, 3);
    expect(hits[1]?.score).toBeCloseTo(0.1104, 3);
  });

  it("hides private vectors unless they are asked for", () => {
    store.put([row("1", [1, 0]), row("2", [1, 0], { private: true })]);

    const hidden = store.search(new Float32Array([1, 0]), {
      model: MODEL,
      includePrivate: false,
      limit: 10,
    });
    const shown = store.search(new Float32Array([1, 0]), {
      model: MODEL,
      includePrivate: true,
      limit: 10,
    });

    expect(hidden.map((hit) => hit.key)).toEqual(["1"]);
    expect(shown.map((hit) => hit.key)).toEqual(["1", "2"]);
  });

  it("replaces a vector written again for the same kind, key and model", () => {
    store.put([row("1", [1, 0], { hash: "hash-before" })]);
    store.put([row("1", [0, 1], { hash: "hash-after" })]);

    expect(store.count(MODEL)).toBe(1);
    expect(store.hashes("row", MODEL).get("1")).toBe("hash-after");
    const hits = store.search(new Float32Array([0, 1]), {
      model: MODEL,
      includePrivate: false,
      limit: 10,
    });
    expect(hits.map((hit) => hit.key)).toEqual(["1"]);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
  });

  it("lists the hashes of one kind and model only", () => {
    store.put([row("1", [1, 0]), note("notes/garden.md#fruit", [1, 0]), row("9", [1, 0], { model: "other-embed" })]);

    expect(store.hashes("row", MODEL)).toEqual(new Map([["1", "hash-1"]]));
    expect(store.hashes("note", MODEL)).toEqual(new Map([["notes/garden.md#fruit", "hash-notes/garden.md#fruit"]]));
  });

  it("removes vectors by kind and key", () => {
    store.put([row("1", [1, 0]), row("2", [1, 0]), note("notes/a.md#top", [1, 0])]);

    expect(store.remove("row", ["1", "2", "3"])).toBe(2);
    expect(store.count(MODEL)).toBe(1);
    expect(store.hashes("note", MODEL).size).toBe(1);
  });
});

describe("the forget cascade", () => {
  it("removes the vectors of forgotten seqs and keeps the others", () => {
    const river = openRiver(join(dir, "river.db"));
    try {
      const first = river.append({ thread: "self", kind: "say", source: "self", text: "A first thing.", atMs: NOW });
      const second = river.append({
        thread: "self",
        kind: "say",
        source: "self",
        text: "A second thing.",
        atMs: NOW + 1,
      });
      store.put([
        row("first", [1, 0], { seq: first.seq }),
        row("second", [0, 1], { seq: second.seq }),
      ]);

      expect(river.forget({ seqs: [first.seq] }, "owner", "A plain reason.")).toBe(1);

      const hashes = store.hashes("row", MODEL);
      expect(hashes.has("first")).toBe(false);
      expect(hashes.has("second")).toBe(true);
      expect(store.count(MODEL)).toBe(1);
    } finally {
      river.close();
    }
  });

  it("removes every note vector on a text forget and the row vectors its seqs name", () => {
    const river = openRiver(join(dir, "river.db"));
    try {
      const apples = river.append({
        thread: "self",
        kind: "say",
        source: "self",
        text: "The apples are ripe.",
        atMs: NOW,
      });
      const pears = river.append({
        thread: "self",
        kind: "say",
        source: "self",
        text: "The pears are hard.",
        atMs: NOW + 1,
      });
      store.put([
        row("apples", [1, 0], { seq: apples.seq }),
        row("pears", [0, 1], { seq: pears.seq }),
        note("notes/garden.md#fruit", [1, 0]),
      ]);

      river.forget({ text: "apples" }, "owner", "Forget the apples.");

      expect(store.hashes("row", MODEL)).toEqual(new Map([["pears", "hash-pears"]]));
      expect(store.hashes("note", MODEL)).toEqual(new Map());
    } finally {
      river.close();
    }
  });
});

/** An embeddings client that answers from a function and records the texts it was given. */
function fakeClient(answer: (text: string) => number[], calls: string[][]): EmbeddingsClient {
  return {
    model: MODEL,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      calls.push([...texts]);
      return texts.map((text) => new Float32Array(answer(text)));
    },
  };
}

function item(overrides: Partial<IndexItem> & { key: string; text: string }): IndexItem {
  return {
    kind: "row",
    seq: 1,
    private: false,
    atMs: NOW,
    ...overrides,
  };
}

describe("indexItems", () => {
  it("embeds nothing on a second run over the same items", async () => {
    const calls: string[][] = [];
    const client = fakeClient(() => [1, 0], calls);
    const items = [
      item({ key: "1", seq: 1, text: "First words." }),
      item({ kind: "note", key: "notes/a.md#top", seq: undefined, text: "Second words." }),
    ];

    expect(await indexItems(store, client, items)).toEqual({ embedded: 2, skipped: 0 });
    expect(await indexItems(store, client, items)).toEqual({ embedded: 0, skipped: 2 });
    expect(calls).toHaveLength(1);
    expect(store.count(MODEL)).toBe(2);
  });

  it("embeds a changed text again and leaves the unchanged one alone", async () => {
    const calls: string[][] = [];
    const client = fakeClient((text) => (text.includes("changed") ? [0, 1] : [1, 0]), calls);
    await indexItems(store, client, [
      item({ key: "1", seq: 1, text: "First words." }),
      item({ key: "2", seq: 2, text: "Second words." }),
    ]);

    const result = await indexItems(store, client, [
      item({ key: "1", seq: 1, text: "First words changed." }),
      item({ key: "2", seq: 2, text: "Second words." }),
    ]);

    expect(result).toEqual({ embedded: 1, skipped: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["First words changed."]);
  });

  it("skips items with empty text without calling the service", async () => {
    const calls: string[][] = [];
    const client = fakeClient(() => [1, 0], calls);

    const result = await indexItems(store, client, [
      item({ key: "1", text: "" }),
      item({ key: "2", text: "   " }),
      item({ key: "3", text: "Something to embed." }),
    ]);

    expect(result).toEqual({ embedded: 1, skipped: 2 });
    expect(calls).toEqual([["Something to embed."]]);
  });

  it("keeps the private flag it was given", async () => {
    await indexItems(store, fakeClient(() => [1, 0], []), [
      item({ key: "1", text: "A quiet thing.", private: true }),
    ]);

    const hidden = store.search(new Float32Array([1, 0]), {
      model: MODEL,
      includePrivate: false,
      limit: 10,
    });
    const shown = store.search(new Float32Array([1, 0]), {
      model: MODEL,
      includePrivate: true,
      limit: 10,
    });

    expect(hidden).toEqual([]);
    expect(shown.map((hit) => hit.key)).toEqual(["1"]);
  });
});
