import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRiver } from "../river/index.js";
import { captureWindow, worldOf } from "./capture.js";
import { EVENTS_FILE, readEventFile, readSayFile, REFERENCE_FILE, TRANSCRIPT_FILE } from "./files.js";

const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);
const MIN = 60_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-capture-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A river with one event before the window, four inside it (one forgotten), and a say; the file is then closed. */
function seedRiver(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const river = openRiver(join(dir, "river.db"));
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", actor: "owner", text: "Before the window.", atMs: T0 - MIN });
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", actor: "owner", text: "Hello, Mara.", atMs: T0 + 2 * MIN });
  river.append({ thread: "cli:owner", kind: "say", source: "self", place: "cli:owner", text: "Hello. Good to see you.", atMs: T0 + 3 * MIN });
  river.append({ thread: "room:harbour", kind: "event", source: "outside", place: "room:harbour", actor: "tomas", text: "The boats are in.", data: { importedId: "m-1" }, atMs: T0 + MIN });
  river.append({ thread: "room:harbour", kind: "event", source: "outside", place: "room:harbour", actor: "tomas", text: "A secret word, forgotten later.", atMs: T0 + 4 * MIN });
  river.forget({ text: "forgotten later" }, "owner", "a test forget");
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", text: "After the window.", atMs: T0 + 60 * MIN });
  river.close();
}

describe("worldOf", () => {
  it("takes the part of the place before the first colon", () => {
    expect(worldOf("discord:dm:owner")).toBe("discord");
    expect(worldOf("domus:home")).toBe("domus");
    expect(worldOf("self")).toBe("self");
  });
});

describe("captureWindow", () => {
  it("writes the events and the says in the window, in time order, and skips forgotten rows", () => {
    const dir = join(root, "entity");
    seedRiver(dir);
    const out = join(root, "capture");
    const result = captureWindow({ dir, sinceMs: T0, untilMs: T0 + 30 * MIN, outDir: out });

    // Inside the window: the boats (1 min), Hello (2 min); the forgotten row (4 min) is counted, not written.
    expect(result).toMatchObject({ events: 2, says: 1, forgotten: 1 });
    const events = readEventFile(join(out, EVENTS_FILE));
    expect(events.map((event) => [event.atMs - T0, event.world, event.place, event.source, event.text])).toEqual([
      [MIN, "room", "room:harbour", "outside", "The boats are in."],
      [2 * MIN, "cli", "cli:owner", "owner", "Hello, Mara."],
    ]);
    expect(events[0]?.actor).toBe("tomas");
    expect(events[0]?.data).toEqual({ importedId: "m-1" });

    const says = readSayFile(join(out, REFERENCE_FILE));
    expect(says).toEqual([{ atMs: T0 + 3 * MIN, place: "cli:owner", text: "Hello. Good to see you.", thread: "cli:owner" }]);
  });

  it("treats the end of the window as exclusive", () => {
    const dir = join(root, "entity");
    seedRiver(dir);
    const out = join(root, "capture");
    const result = captureWindow({ dir, sinceMs: T0 + 2 * MIN, untilMs: T0 + 3 * MIN, outDir: out });
    expect(result.events).toBe(1);
    expect(result.says).toBe(0);
  });

  it("leaves the river as it was (a read, not a change)", () => {
    const dir = join(root, "entity");
    seedRiver(dir);
    const snapshot = (): string => {
      const river = openRiver(join(dir, "river.db"));
      try {
        return JSON.stringify(river.read({ limit: 1000 }));
      } finally {
        river.close();
      }
    };
    const before = snapshot();
    captureWindow({ dir, sinceMs: T0, untilMs: T0 + 90 * MIN, outDir: join(root, "capture") });
    expect(snapshot()).toBe(before);
  });

  it("refuses an empty or backwards window", () => {
    const dir = join(root, "entity");
    seedRiver(dir);
    expect(() => captureWindow({ dir, sinceMs: T0, untilMs: T0, outDir: join(root, "x") })).toThrow(/later than --since/);
    expect(() => captureWindow({ dir, sinceMs: 1.5, untilMs: T0, outDir: join(root, "x") })).toThrow(/whole-millisecond/);
  });
});

describe("reading the replay files", () => {
  it("names the file and line of a bad event", () => {
    const file = join(root, EVENTS_FILE);
    writeFileSync(
      file,
      [
        JSON.stringify({ world: "cli", place: "cli:owner", source: "owner", atMs: T0 }),
        JSON.stringify({ world: "cli", place: "cli:owner", source: "robot", atMs: T0 }),
      ].join("\n"),
    );
    expect(() => readEventFile(file)).toThrow(/line 2: source must be owner, outside, self or body/);
  });

  it("refuses a line that is not JSON, with its line number", () => {
    const file = join(root, EVENTS_FILE);
    writeFileSync(file, "{}\n{nope\n");
    expect(() => readEventFile(file)).toThrow(/line 1: must be one JSON object|line 2: is not valid JSON/);
  });

  it("defaults the thread to the place and sorts events by time, keeping file order for ties", () => {
    const file = join(root, EVENTS_FILE);
    writeFileSync(
      file,
      [
        JSON.stringify({ world: "cli", place: "cli:owner", source: "owner", text: "second", atMs: T0 + MIN }),
        JSON.stringify({ world: "cli", place: "cli:owner", source: "owner", text: "first-a", atMs: T0 }),
        JSON.stringify({ world: "cli", place: "cli:owner", source: "owner", text: "first-b", atMs: T0 }),
      ].join("\n"),
    );
    const events = readEventFile(file);
    expect(events.map((event) => event.text)).toEqual(["first-a", "first-b", "second"]);
    expect(events[0]?.thread).toBe("cli:owner");
  });

  it("skips wake rows when reading what was said, and reads a run folder's transcript", () => {
    const run = join(root, "run");
    mkdirSync(run);
    writeFileSync(
      join(run, TRANSCRIPT_FILE),
      [
        JSON.stringify({ atMs: T0, place: "cli:owner", text: "Hi." }),
        JSON.stringify({ wake: { id: "abcd1234", atMs: T0 + MIN, why: "check", scheduledIn: "cli:owner" } }),
        JSON.stringify({ atMs: T0 + 2 * MIN, place: "cli:owner", text: "Back.", replyTo: "m9" }),
      ].join("\n"),
    );
    const says = readSayFile(run);
    expect(says.map((say) => say.text)).toEqual(["Hi.", "Back."]);
    expect(says[1]?.replyTo).toBe("m9");
    expect(existsSync(join(run, TRANSCRIPT_FILE))).toBe(true);
    expect(() => readSayFile(join(root, "missing"))).toThrow(/does not exist/);
  });
});
