import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStopOn, readStop } from "../../entity/stop.js";
import { stopCommand } from "./stop.js";

let root: string;
let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-stopcmd-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  // The command only needs the entity's entity.json to exist; its contents are not read here.
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function run(args: string[]): number {
  return stopCommand(args, (line) => out.push(line), (line) => err.push(line));
}

describe("natalis stop", () => {
  it("turns the stop on with a reason, and says so", () => {
    expect(run(["--dir", dir, "--reason", "Too many messages."])).toBe(0);
    expect(isStopOn(dir)).toBe(true);
    expect(readStop(dir)).toEqual({ on: true, reason: "Too many messages." });
    expect(out.join("\n")).toContain("Emergency stop is on");
    expect(out.join("\n")).toContain("Reason: Too many messages.");
  });

  it("turns the stop on with no reason when none is given", () => {
    expect(run(["--dir", dir])).toBe(0);
    expect(readStop(dir)).toEqual({ on: true });
  });

  it("says the stop was already on when it is turned on twice", () => {
    run(["--dir", dir]);
    out = [];
    run(["--dir", dir]);
    expect(out.join("\n")).toContain("already on");
  });

  it("lifts the stop with --off, and says when there was nothing to lift", () => {
    run(["--dir", dir, "--reason", "Pause."]);
    expect(run(["--dir", dir, "--off"])).toBe(0);
    expect(isStopOn(dir)).toBe(false);
    expect(out.at(-1)).toContain("Emergency stop is off");

    expect(run(["--dir", dir, "--off"])).toBe(0);
    expect(out.at(-1)).toContain("was not on");
  });

  it("refuses without a folder, and says how to use it", () => {
    expect(run([])).toBe(2);
    expect(err[0]).toContain("Usage: natalis stop");
  });

  it("refuses a folder that is not an entity's, and writes nothing there", () => {
    const other = join(root, "not-an-entity");
    expect(run(["--dir", other])).toBe(1);
    expect(err.join("\n")).toContain("No entity.json");
    expect(isStopOn(other)).toBe(false);
  });

  it("refuses an empty reason rather than writing a stop with a blank line", () => {
    expect(run(["--dir", dir, "--reason", "  "])).toBe(2);
    expect(isStopOn(dir)).toBe(false);
  });

  it("writes the STOP file as plain text", () => {
    run(["--dir", dir, "--reason", "Pause."]);
    expect(readFileSync(join(dir, "STOP"), "utf8")).toBe("Pause.\n");
  });
});
