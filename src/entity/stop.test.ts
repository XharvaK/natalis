import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStop, isStopOn, readStop, writeStop } from "./stop.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-stop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the emergency stop file", () => {
  it("is off when there is no STOP file", () => {
    expect(isStopOn(dir)).toBe(false);
    expect(readStop(dir)).toEqual({ on: false });
  });

  it("is on when STOP is there, with no reason when it is empty", () => {
    writeFileSync(join(dir, "STOP"), "", "utf8");
    expect(readStop(dir)).toEqual({ on: true });
  });

  it("writes the reason into the file and reads it back, trimmed", () => {
    writeStop(dir, "  Too many messages.  ");
    expect(readFileSync(join(dir, "STOP"), "utf8")).toBe("Too many messages.\n");
    expect(readStop(dir)).toEqual({ on: true, reason: "Too many messages." });
  });

  it("writes an empty file when there is no reason", () => {
    writeStop(dir);
    expect(readFileSync(join(dir, "STOP"), "utf8")).toBe("");
    expect(readStop(dir)).toEqual({ on: true });
  });

  it("keeps a long reason to 300 characters", () => {
    writeStop(dir, "x".repeat(1000));
    expect(readStop(dir).reason).toHaveLength(300);
  });

  it("removes the file when it is cleared, and says whether anything was cleared", () => {
    expect(clearStop(dir)).toBe(false);
    writeStop(dir, "Pause.");
    expect(clearStop(dir)).toBe(true);
    expect(isStopOn(dir)).toBe(false);
  });
});
