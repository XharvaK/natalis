import { describe, expect, it } from "vitest";
import { GRANTS_FILE } from "../../entity/grants.js";
import { THREAD_HASH_KEY_FILE } from "../../river/thread-key.js";
import { isAllowedName, PLAIN_FILES } from "./backup-format.js";

describe("the plain backup file list", () => {
  it("does not hold thread-hash.key, which documents the current choice: a restore rotates the key", () => {
    expect(PLAIN_FILES).not.toContain("thread-hash.key");
  });

  it("never allows grants.db or the per-Lar key into a backup", () => {
    expect(PLAIN_FILES).not.toContain(GRANTS_FILE);
    expect(PLAIN_FILES).not.toContain(THREAD_HASH_KEY_FILE);
    expect(isAllowedName(GRANTS_FILE)).toBe(false);
    expect(isAllowedName(THREAD_HASH_KEY_FILE)).toBe(false);
  });
});
