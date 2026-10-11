import { describe, expect, it } from "vitest";
import { parseFlags, UsageError } from "./shared.js";

describe("parseFlags", () => {
  it("reads --name value and --name=value, and bare switches", () => {
    const flags = parseFlags(["--dir", "entity", "--since=2026-10-01T00:00:00Z", "--apply"], ["--dir", "--since"], ["--apply"]);
    expect(flags.values.get("--dir")).toBe("entity");
    expect(flags.values.get("--since")).toBe("2026-10-01T00:00:00Z");
    expect(flags.switches.has("--apply")).toBe(true);
  });

  it("refuses an unknown argument, a repeated flag, and a flag with no value", () => {
    expect(() => parseFlags(["--nope", "x"], ["--dir"], [])).toThrow(UsageError);
    expect(() => parseFlags(["--dir", "a", "--dir", "b"], ["--dir"], [])).toThrow(/given twice/);
    expect(() => parseFlags(["--apply", "--apply"], [], ["--apply"])).toThrow(/given twice/);
    expect(() => parseFlags(["--dir"], ["--dir"], [])).toThrow(/needs a value/);
    expect(() => parseFlags(["--dir", "--apply"], ["--dir"], ["--apply"])).toThrow(/needs a value/);
  });
});
