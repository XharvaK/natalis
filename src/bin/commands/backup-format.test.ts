import { describe, expect, it } from "vitest";
import { PLAIN_FILES } from "./backup-format.js";

describe("the plain backup file list", () => {
  it("does not hold thread-hash.key, which documents the current choice: a restore rotates the key", () => {
    expect(PLAIN_FILES).not.toContain("thread-hash.key");
  });
});
