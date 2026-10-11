import { describe, expect, it } from "vitest";
import { parseSandboxFile, SANDBOX_DEFAULT_MAX_TIMEOUT_S, SANDBOX_DEFAULT_TIMEOUT_S } from "./config.js";

describe("sandbox.json", () => {
  it("fills in the defaults from the design", () => {
    expect(parseSandboxFile({})).toEqual({ timeoutSeconds: 120, maxTimeoutSeconds: 900 });
    expect(SANDBOX_DEFAULT_TIMEOUT_S).toBe(120);
    expect(SANDBOX_DEFAULT_MAX_TIMEOUT_S).toBe(900);
  });

  it("reads the design's example and an explicit bwrap path, trimmed", () => {
    expect(parseSandboxFile({ timeoutSeconds: 120, maxTimeoutSeconds: 900 })).toEqual({
      timeoutSeconds: 120,
      maxTimeoutSeconds: 900,
    });
    expect(parseSandboxFile({ bwrapPath: "  /opt/bin/bwrap " })).toEqual({
      timeoutSeconds: 120,
      maxTimeoutSeconds: 900,
      bwrapPath: "/opt/bin/bwrap",
    });
  });

  it("keeps the default timeout within a lower maximum when only the maximum is set", () => {
    expect(parseSandboxFile({ maxTimeoutSeconds: 60 })).toEqual({ timeoutSeconds: 60, maxTimeoutSeconds: 60 });
  });

  it("refuses unknown fields, a non-object root, and a timeout above its maximum", () => {
    expect(() => parseSandboxFile({ timeout: 5 })).toThrow(/Unknown field "timeout" in sandbox\.json/);
    expect(() => parseSandboxFile([])).toThrow(/must be an object/);
    expect(() => parseSandboxFile(null)).toThrow(/must be an object/);
    expect(() => parseSandboxFile({ timeoutSeconds: 1000 })).toThrow(/cannot be more than maxTimeoutSeconds \(900\)/);
  });

  it("validates the numbers: whole seconds from 1 to 3600", () => {
    for (const bad of [0, -5, 1.5, "120", null, 3601, Number.NaN]) {
      expect(() => parseSandboxFile({ timeoutSeconds: bad })).toThrow(/timeoutSeconds must be a whole number of seconds/);
      expect(() => parseSandboxFile({ maxTimeoutSeconds: bad })).toThrow(/maxTimeoutSeconds must be a whole number/);
    }
  });

  it("refuses an empty or non-text bwrap path", () => {
    expect(() => parseSandboxFile({ bwrapPath: "   " })).toThrow(/bwrapPath/);
    expect(() => parseSandboxFile({ bwrapPath: 7 })).toThrow(/bwrapPath/);
    expect(() => parseSandboxFile({ bwrapPath: "/usr/bin/bwrap\0" })).toThrow(/bwrapPath/);
  });
});
