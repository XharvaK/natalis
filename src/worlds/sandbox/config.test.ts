import { describe, expect, it } from "vitest";
import { parseSandboxFile, SANDBOX_DEFAULT_MAX_TIMEOUT_S, SANDBOX_DEFAULT_TIMEOUT_S } from "./config.js";

describe("sandbox.json", () => {
  it("fills in the defaults from the design", () => {
    expect(parseSandboxFile({})).toEqual({ timeoutSeconds: 120, maxTimeoutSeconds: 900, body: true, network: "wall" });
    expect(SANDBOX_DEFAULT_TIMEOUT_S).toBe(120);
    expect(SANDBOX_DEFAULT_MAX_TIMEOUT_S).toBe(900);
  });

  it("reads the design's example and an explicit bwrap path, trimmed", () => {
    expect(parseSandboxFile({ timeoutSeconds: 120, maxTimeoutSeconds: 900 })).toEqual({
      timeoutSeconds: 120,
      maxTimeoutSeconds: 900,
      body: true,
      network: "wall",
    });
    expect(parseSandboxFile({ bwrapPath: "  /opt/bin/bwrap " })).toEqual({
      timeoutSeconds: 120,
      maxTimeoutSeconds: 900,
      bwrapPath: "/opt/bin/bwrap",
      body: true,
      network: "wall",
    });
  });

  it("keeps the default timeout within a lower maximum when only the maximum is set", () => {
    expect(parseSandboxFile({ maxTimeoutSeconds: 60 })).toEqual({ timeoutSeconds: 60, maxTimeoutSeconds: 60, body: true, network: "wall" });
  });

  it("turns the body off only when it says false, and refuses anything but true or false", () => {
    expect(parseSandboxFile({ body: false })).toMatchObject({ body: false });
    expect(parseSandboxFile({ body: true })).toMatchObject({ body: true });
    expect(() => parseSandboxFile({ body: "no" })).toThrow(/body must be true or false/);
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

describe("sandbox.json: the network", () => {
  it("walls the network by default, and reads the three modes", () => {
    expect(parseSandboxFile({}).network).toBe("wall");
    for (const network of ["wall", "host", "none"]) {
      expect(parseSandboxFile({ network }).network).toBe(network);
    }
  });

  it("refuses any other network, and names the field", () => {
    for (const bad of ["open", "", "Host", 1, null, false]) {
      expect(() => parseSandboxFile({ network: bad })).toThrow(/network must be "wall", "host" or "none"/);
    }
  });

  it("reads a pasta path and an ip path, trimmed, and refuses an empty or non-text one", () => {
    expect(parseSandboxFile({ pastaPath: "  /opt/pasta " }).pastaPath).toBe("/opt/pasta");
    expect(parseSandboxFile({ ipPath: "/usr/sbin/ip" }).ipPath).toBe("/usr/sbin/ip");
    expect(parseSandboxFile({})).not.toHaveProperty("pastaPath");
    expect(() => parseSandboxFile({ pastaPath: "  " })).toThrow(/pastaPath must be the path to the program/);
    expect(() => parseSandboxFile({ ipPath: 3 })).toThrow(/ipPath must be the path to the program/);
  });
});
