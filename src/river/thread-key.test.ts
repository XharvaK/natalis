import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createThreadHasher,
  readThreadHashKey,
  threadHash,
  THREAD_HASH_KEY_BYTES,
  THREAD_HASH_KEY_FILE,
} from "./thread-key.js";

let dir: string;
let other: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-thread-key-"));
  other = mkdtempSync(join(tmpdir(), "natalis-thread-key-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  rmSync(other, { recursive: true, force: true, maxRetries: 5 });
});

describe("the per-Lar thread hash key", () => {
  it("makes 32 random bytes on first need, keeps them stable, and writes them owner-only", () => {
    const key = readThreadHashKey(dir);
    expect(key).toHaveLength(THREAD_HASH_KEY_BYTES);
    expect(readThreadHashKey(dir).equals(key)).toBe(true);
    expect(existsSync(join(dir, THREAD_HASH_KEY_FILE))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, THREAD_HASH_KEY_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(readThreadHashKey(other).equals(key)).toBe(false);
  });

  it("hashes a thread with HMAC-SHA256, in the old 12-hex shape, differently under two keys", () => {
    const thread = "discord:dm:mara";
    const one = createThreadHasher(dir);
    const two = createThreadHasher(other);
    const first = one(thread);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(one(thread)).toBe(first);
    expect(createThreadHasher(dir)(thread)).toBe(first);
    expect(two(thread)).not.toBe(first);

    const bare = createHash("sha256").update(thread).digest("hex").slice(0, 12);
    expect(first).not.toBe(bare);
    expect(two(thread)).not.toBe(bare);
    expect(threadHash(readThreadHashKey(dir), thread)).toBe(first);
    expect(first).toBe(createHmac("sha256", readThreadHashKey(dir)).update(thread).digest("hex").slice(0, 12));
  });

  it("refuses a damaged key file loudly, without replacing it or showing its bytes", () => {
    const damaged = "not-a-thread-key";
    writeFileSync(join(dir, THREAD_HASH_KEY_FILE), damaged);
    let message = "";
    try {
      createThreadHasher(dir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(THREAD_HASH_KEY_FILE);
    expect(message).not.toContain(damaged);
    expect(readFileSync(join(dir, THREAD_HASH_KEY_FILE), "utf8")).toBe(damaged);
  });
});
