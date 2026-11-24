// Recall by meaning: the vectors of river rows and notebook sections, kept in river.db as a derived store. An
// embedding is an index, like FTS5: nothing here writes words the Lar reads, it only ranks rows and note sections that
// already exist. The caller decides what may be sent; the store keeps the `private` flag it is given and hides those
// rows from a search that did not ask for them. A forget erases these vectors in the same transaction as the river.
//
// Vectors are Float32 little-endian blobs, so a file read on any machine gives the same numbers. Cosine is computed
// here in plain TypeScript; no native extension is loaded.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddingsClient } from "../model/embeddings.js";
import type { DerivedStore } from "./derived.js";

export const EMBEDDINGS_TABLE = "embeddings";

const EMBEDDINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${EMBEDDINGS_TABLE} (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('row', 'note')),
  key TEXT NOT NULL,
  seq INTEGER,
  model TEXT NOT NULL,
  private INTEGER NOT NULL,
  hash TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vec BLOB NOT NULL,
  at_ms INTEGER NOT NULL,
  UNIQUE (kind, key, model)
)`;

const EMBEDDINGS_MODEL_INDEX = `CREATE INDEX IF NOT EXISTS embeddings_model ON ${EMBEDDINGS_TABLE}(model)`;

/** How many seqs one DELETE names; keeps a huge forget under SQLite's parameter limit. */
const SEQ_CHUNK = 500;

export type EmbeddingKind = "row" | "note";

/** One vector to write. `key` is the river seq as text for a row, or `<note path>#<heading>` for a note section. */
export type NewEmbedding = {
  kind: EmbeddingKind;
  key: string;
  seq?: number;
  model: string;
  private: boolean;
  hash: string;
  vec: Float32Array;
  atMs: number;
};

export type EmbeddingHit = { kind: EmbeddingKind; key: string; seq: number | null; score: number };

export type EmbeddingSearch = {
  model: string;
  includePrivate: boolean;
  limit: number;
  kind?: EmbeddingKind;
};

export interface EmbeddingStore {
  /** Writes the vectors, replacing the ones with the same kind, key and model. Returns how many were written. */
  put(items: readonly NewEmbedding[]): number;
  /** The hashes already stored for a kind and model: key to hash, so an unchanged text is skipped. */
  hashes(kind: EmbeddingKind, model: string): Map<string, string>;
  /** Drops the vectors with these keys of one kind. Returns how many were dropped. */
  remove(kind: EmbeddingKind, keys: readonly string[]): number;
  /** Cosine similarity, exact, best first, over the rows of one model and vector length. */
  search(vec: Float32Array, options: EmbeddingSearch): EmbeddingHit[];
  count(model: string): number;
  /** The largest seq of a row of this model, or 0 when it has none: where the next index pass starts. */
  maxSeq(model: string): number;
  close(): void;
}

export class EmbeddingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsError";
  }
}

type StoredVector = { id: number; kind: string; key: string; seq: number | null; vec: Uint8Array };

/** Opens the vectors in the river file. Close it when the Lar stops. */
export function openEmbeddings(riverPath: string): EmbeddingStore {
  const db = new DatabaseSync(riverPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON");
    db.exec(EMBEDDINGS_SCHEMA);
    db.exec(EMBEDDINGS_MODEL_INDEX);
  } catch (error) {
    db.close();
    throw error;
  }

  const upsert = db.prepare(
    `INSERT INTO ${EMBEDDINGS_TABLE} (kind, key, seq, model, private, hash, dims, vec, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, key, model) DO UPDATE SET
       seq = excluded.seq,
       private = excluded.private,
       hash = excluded.hash,
       dims = excluded.dims,
       vec = excluded.vec,
       at_ms = excluded.at_ms`,
  );
  const hashRows = db.prepare(`SELECT key, hash FROM ${EMBEDDINGS_TABLE} WHERE kind = ? AND model = ?`);
  const removeOne = db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE kind = ? AND key = ?`);
  const countRows = db.prepare(`SELECT COUNT(*) AS n FROM ${EMBEDDINGS_TABLE} WHERE model = ?`);
  const maxRowSeq = db.prepare(`SELECT MAX(seq) AS n FROM ${EMBEDDINGS_TABLE} WHERE kind = 'row' AND model = ?`);
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new EmbeddingsError("the embeddings store is closed");
  };

  const inTransaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    put(items: readonly NewEmbedding[]): number {
      ensureOpen();
      if (!Array.isArray(items)) throw new EmbeddingsError("items must be a list");
      for (const item of items) {
        checkKind(item.kind);
        checkText(item.key, "key");
        checkText(item.model, "model");
        checkText(item.hash, "hash");
        checkFlag(item.private, "private");
        checkTime(item.atMs);
        if (item.seq !== undefined) checkSeq(item.seq);
        if (!(item.vec instanceof Float32Array)) throw new EmbeddingsError("vec must be a Float32Array");
        if (item.vec.length === 0) throw new EmbeddingsError("vec must hold at least one number");
      }
      if (items.length === 0) return 0;
      return inTransaction(() => {
        for (const item of items) {
          upsert.run(
            item.kind,
            item.key,
            item.seq ?? null,
            item.model,
            item.private ? 1 : 0,
            item.hash,
            item.vec.length,
            encodeVector(item.vec),
            item.atMs,
          );
        }
        return items.length;
      });
    },

    hashes(kind: EmbeddingKind, model: string): Map<string, string> {
      ensureOpen();
      checkKind(kind);
      checkText(model, "model");
      const rows = hashRows.all(kind, model) as unknown as Array<{ key: string; hash: string }>;
      return new Map(rows.map((row) => [row.key, row.hash]));
    },

    remove(kind: EmbeddingKind, keys: readonly string[]): number {
      ensureOpen();
      checkKind(kind);
      if (!Array.isArray(keys)) throw new EmbeddingsError("keys must be a list");
      for (const key of keys) checkText(key, "key");
      if (keys.length === 0) return 0;
      return inTransaction(() => {
        let erased = 0;
        for (const key of keys) erased += Number(removeOne.run(kind, key).changes);
        return erased;
      });
    },

    search(vec: Float32Array, options: EmbeddingSearch): EmbeddingHit[] {
      ensureOpen();
      if (!(vec instanceof Float32Array)) throw new EmbeddingsError("vec must be a Float32Array");
      if (vec.length === 0) throw new EmbeddingsError("vec must hold at least one number");
      checkText(options.model, "model");
      checkFlag(options.includePrivate, "includePrivate");
      checkLimit(options.limit);
      if (options.kind !== undefined) checkKind(options.kind);

      const where = ["model = ?", "dims = ?", "(? = 1 OR private = 0)"];
      const params: Array<string | number> = [options.model, vec.length, options.includePrivate ? 1 : 0];
      if (options.kind !== undefined) {
        where.push("kind = ?");
        params.push(options.kind);
      }
      const rows = db
        .prepare(`SELECT id, kind, key, seq, vec FROM ${EMBEDDINGS_TABLE} WHERE ${where.join(" AND ")}`)
        .all(...params) as unknown as StoredVector[];

      const hits: Array<EmbeddingHit & { id: number }> = [];
      for (const row of rows) {
        if (row.kind !== "row" && row.kind !== "note") continue;
        const score = cosine(vec, decodeVector(row.vec));
        hits.push({
          id: Number(row.id),
          kind: row.kind,
          key: row.key,
          seq: row.seq === null ? null : Number(row.seq),
          score,
        });
      }
      hits.sort((a, b) => b.score - a.score || a.id - b.id);
      return hits.slice(0, options.limit).map(({ id: _id, ...hit }) => hit);
    },

    count(model: string): number {
      ensureOpen();
      checkText(model, "model");
      return Number((countRows.get(model) as { n: number }).n);
    },

    maxSeq(model: string): number {
      ensureOpen();
      checkText(model, "model");
      const highest = (maxRowSeq.get(model) as { n: number | null }).n;
      return highest === null ? 0 : Number(highest);
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * The store's part of the forget cascade. A seq forget erases every vector whose row seq was forgotten. A text
 * forget cannot be checked against vectors at all: the words have no relation to the numbers. So the rows it reached
 * are erased through the seqs the forget gives, and every note entry is erased too, since a note section is embedded
 * again from the notebook on the next index pass.
 */
export const embeddingsDerivedStore: DerivedStore = {
  tables: [EMBEDDINGS_TABLE],
  schema: [EMBEDDINGS_SCHEMA, EMBEDDINGS_MODEL_INDEX],
  cascade(db: DatabaseSync, forget): number {
    let erased = 0;
    const seqs = [...new Set(forget.seqs)];
    for (let start = 0; start < seqs.length; start += SEQ_CHUNK) {
      const chunk = seqs.slice(start, start + SEQ_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      erased += Number(
        db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE seq IN (${placeholders})`).run(...chunk).changes,
      );
    }
    if (forget.words.length > 0) {
      erased += Number(db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE kind = 'note'`).run().changes);
    }
    return erased;
  },
};

/** One text of the river or a notebook section, ready to be embedded unless its stored hash already matches. */
export type IndexItem = {
  kind: EmbeddingKind;
  key: string;
  seq?: number;
  text: string;
  private: boolean;
  atMs: number;
};

/**
 * Embeds the items whose text is not empty and whose hash differs from the one stored for that kind and key. The
 * caller decides which items may be sent; this function trusts its input. Returns how many vectors were written and
 * how many items were left alone.
 */
export async function indexItems(
  store: EmbeddingStore,
  client: EmbeddingsClient,
  items: readonly IndexItem[],
  options: { signal?: AbortSignal } = {},
): Promise<{ embedded: number; skipped: number }> {
  const model = client.model;
  const hashesByKind = new Map<EmbeddingKind, Map<string, string>>();
  const pending: Array<{ item: IndexItem; hash: string }> = [];
  let skipped = 0;

  for (const item of items) {
    if (item.text.trim() === "") {
      skipped += 1;
      continue;
    }
    let stored = hashesByKind.get(item.kind);
    if (stored === undefined) {
      stored = store.hashes(item.kind, model);
      hashesByKind.set(item.kind, stored);
    }
    const hash = indexHash(item);
    if (stored.get(item.key) === hash) {
      skipped += 1;
      continue;
    }
    pending.push({ item, hash });
  }

  if (pending.length === 0) return { embedded: 0, skipped };

  const vectors = await client.embed(
    pending.map((entry) => entry.item.text),
    options.signal,
  );
  if (vectors.length !== pending.length) {
    throw new EmbeddingsError(
      `embeddings: the service answered ${vectors.length} vectors for ${pending.length} texts`,
    );
  }
  store.put(
    pending.map((entry, index) => ({
      kind: entry.item.kind,
      key: entry.item.key,
      seq: entry.item.seq,
      model,
      private: entry.item.private,
      hash: entry.hash,
      vec: vectors[index] as Float32Array,
      atMs: entry.item.atMs,
    })),
  );
  return { embedded: pending.length, skipped };
}

/**
 * The hash an item is stored under: its privacy flag and its text. The flag is part of it, so an item whose flag
 * changed is embedded again rather than left with a vector that says it is private.
 */
export function indexHash(item: { text: string; private: boolean }): string {
  return sha256(`${item.private ? "p:" : "o:"}${item.text}`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Float32 numbers, little-endian, four bytes each. */
function encodeVector(vec: Float32Array): Uint8Array {
  const bytes = Buffer.alloc(vec.length * 4);
  for (let index = 0; index < vec.length; index += 1) {
    bytes.writeFloatLE(vec[index] ?? 0, index * 4);
  }
  return bytes;
}

function decodeVector(blob: Uint8Array): Float32Array {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vec = new Float32Array(Math.floor(blob.byteLength / 4));
  for (let index = 0; index < vec.length; index += 1) {
    vec[index] = view.getFloat32(index * 4, true);
  }
  return vec;
}

/** Cosine similarity in plain TypeScript. A zero vector has no direction, so it scores 0 against anything. */
function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function checkKind(kind: unknown): asserts kind is EmbeddingKind {
  if (kind !== "row" && kind !== "note") throw new EmbeddingsError('kind must be "row" or "note"');
}

function checkText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new EmbeddingsError(`${name} must be a non-empty text`);
}

function checkSeq(seq: unknown): asserts seq is number {
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new EmbeddingsError("seq must be a whole number, 1 or more");
  }
}

function checkTime(atMs: unknown): asserts atMs is number {
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs)) {
    throw new EmbeddingsError("atMs must be a whole number");
  }
}

function checkFlag(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new EmbeddingsError(`${name} must be true or false`);
}

function checkLimit(limit: unknown): asserts limit is number {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
    throw new EmbeddingsError("limit must be a whole number of zero or more");
  }
}
