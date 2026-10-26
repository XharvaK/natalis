import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEntity, STATE_FILE } from "../entity/runtime.js";
import { openRiver } from "../river/index.js";
import { ScriptedModel } from "../testing/scripted-model.js";
import { copyForReplay } from "./copy.js";

const T0 = Date.UTC(2026, 5, 10, 9, 0, 0);
const MIN = 60_000;
const CUT = T0 + 15 * MIN;

const CONFIG = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://model.example.invalid/v1", model: "scripted", contextTokens: 32_000 },
  owner: { alias: "owner" },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-copy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** An entity folder as a real one looks: four rows, a state file that points at the last one, and a notebook with
 * two commits, the second one after the cut. */
function buildSource(dir: string): { firstSha: string; secondSha: string } {
  mkdirSync(dir, { recursive: true });
  const river = openRiver(join(dir, "river.db"));
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", text: "Hello.", atMs: T0 });
  river.append({ thread: "cli:owner", kind: "say", source: "self", place: "cli:owner", text: "Hello back.", atMs: T0 + 10 * MIN });
  river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", text: "Still there?", atMs: T0 + 20 * MIN });
  river.append({ thread: "room:harbour", kind: "event", source: "outside", place: "room:harbour", text: "Boats in.", atMs: T0 + 40 * MIN });
  river.close();

  writeFileSync(
    join(dir, STATE_FILE),
    `${JSON.stringify(
      {
        lastSeq: 4,
        threads: {
          "cli:owner": { seenSeq: 4, lastTurnMs: T0 + 41 * MIN },
          "room:harbour": { seenSeq: 1, lastTurnMs: T0 + 5 * MIN },
        },
        asks: [
          { place: "cli:owner", seq: 2, atMs: T0 },
          { place: "cli:owner", seq: 3, atMs: T0 + 20 * MIN },
        ],
        wakes: [{ id: "w1", atMs: T0 + 100 * MIN, why: "later", scheduledIn: "cli:owner" }],
        mood: "calm",
        lastOwnerMs: T0 + 20 * MIN,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);

  const notebook = join(dir, "notebook");
  mkdirSync(notebook);
  const git = (args: string[], when: number): void => {
    const date = new Date(when).toISOString();
    execFileSync("git", ["-C", notebook, "-c", "user.name=body", "-c", "user.email=body@example.invalid", ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  execFileSync("git", ["init", "--quiet", notebook]);
  writeFileSync(join(notebook, "a.md"), "first\n");
  execFileSync("git", ["-C", notebook, "add", "a.md"]);
  git(["commit", "--quiet", "-m", "First note"], T0 - 24 * 60 * MIN);
  const firstSha = execFileSync("git", ["-C", notebook, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(notebook, "b.md"), "second\n");
  execFileSync("git", ["-C", notebook, "add", "b.md"]);
  git(["commit", "--quiet", "-m", "Second note"], T0 + 30 * MIN);
  const secondSha = execFileSync("git", ["-C", notebook, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { firstSha, secondSha };
}

function lastSeqOf(dir: string): number {
  const river = openRiver(join(dir, "river.db"));
  try {
    return river.lastSeq();
  } finally {
    river.close();
  }
}

describe("copyForReplay", () => {
  it("cuts the river at the start time, and never touches the original", async () => {
    const source = join(root, "source");
    const { secondSha } = buildSource(source);
    const stateBefore = readFileSync(join(source, STATE_FILE), "utf8");
    const copy = join(root, "copy");

    const result = await copyForReplay({ from: source, to: copy, cutAtMs: CUT });

    expect(result.lastSeq).toBe(2);
    expect(lastSeqOf(copy)).toBe(2);
    const river = openRiver(join(copy, "river.db"));
    expect(river.read({ limit: 100 }).map((row) => row.text)).toEqual(["Hello.", "Hello back."]);
    river.close();

    expect(lastSeqOf(source)).toBe(4);
    expect(readFileSync(join(source, STATE_FILE), "utf8")).toBe(stateBefore);
    const headAfter = execFileSync("git", ["-C", join(source, "notebook"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(secondSha);
  });

  it("resets the notebook copy to its last commit before the cut", async () => {
    const source = join(root, "source");
    const { firstSha } = buildSource(source);
    const copy = join(root, "copy");

    const result = await copyForReplay({ from: source, to: copy, cutAtMs: CUT });

    expect(result.notebookCommit).toBe(firstSha);
    const notebook = join(copy, "notebook");
    // Windows git may check text out with CRLF when there is no .gitattributes; compare the words, not the line ends.
    expect(readFileSync(join(notebook, "a.md"), "utf8").replace(/\r\n/g, "\n")).toBe("first\n");
    expect(existsSync(join(notebook, "b.md"))).toBe(false);
    expect(execFileSync("git", ["-C", notebook, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(firstSha);
  });

  it("makes the state match the cut: cursors capped, asks past the cut dropped, wakes cleared, owner time recomputed", async () => {
    const source = join(root, "source");
    buildSource(source);
    const copy = join(root, "copy");
    await copyForReplay({ from: source, to: copy, cutAtMs: CUT });

    const state = JSON.parse(readFileSync(join(copy, STATE_FILE), "utf8")) as Record<string, unknown>;
    expect(state).toEqual({
      lastSeq: 2,
      threads: {
        "cli:owner": { seenSeq: 2 },
        "room:harbour": { seenSeq: 1, lastTurnMs: T0 + 5 * MIN },
      },
      asks: [{ place: "cli:owner", seq: 2, atMs: T0 }],
      wakes: [],
      mood: "calm",
      lastOwnerMs: T0,
    });
  });

  it("the copy opens as a normal entity with no turn to run", async () => {
    const source = join(root, "source");
    buildSource(source);
    const copy = join(root, "copy");
    await copyForReplay({ from: source, to: copy, cutAtMs: CUT });

    const model = new ScriptedModel([]);
    const entity = await openEntity({
      dir: copy,
      config: CONFIG,
      model,
      worlds: [],
    });
    await entity.start();
    await entity.idle();
    await entity.stop();
    expect(model.requests).toHaveLength(0);
  });

  it("uses a replacement config when one is given, and checks it before copying", async () => {
    const source = join(root, "source");
    buildSource(source);
    const replacement = join(root, "replacement.json");
    writeFileSync(replacement, JSON.stringify({ ...CONFIG, model: { ...CONFIG.model, model: "another-model" } }));
    const copy = join(root, "copy");
    await copyForReplay({ from: source, to: copy, cutAtMs: CUT, configPath: replacement });
    expect(JSON.parse(readFileSync(join(copy, "entity.json"), "utf8")).model.model).toBe("another-model");

    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ name: "x", model: { baseUrl: "ftp://nope", model: "m", contextTokens: 1 }, owner: { alias: "o" } }));
    const refusedCopy = join(root, "refused");
    await expect(copyForReplay({ from: source, to: refusedCopy, cutAtMs: CUT, configPath: bad })).rejects.toThrow(/http/);
    expect(existsSync(refusedCopy)).toBe(false);
  });

  it("refuses an output folder that already has files, and an entity with no state", async () => {
    const source = join(root, "source");
    buildSource(source);
    const busy = join(root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "mine");
    await expect(copyForReplay({ from: source, to: busy, cutAtMs: CUT })).rejects.toThrow(/not empty/);
    expect(readdirSync(busy)).toEqual(["keep.txt"]);

    const stateless = join(root, "stateless");
    mkdirSync(stateless);
    const riverOnly = join(stateless, "river.db");
    const river = openRiver(riverOnly);
    river.close();
    await expect(copyForReplay({ from: stateless, to: join(root, "x"), cutAtMs: CUT })).rejects.toThrow(/state\.json/);
  });

  it("a cut before every row gives an empty river and a calm state", async () => {
    const source = join(root, "source");
    buildSource(source);
    const copy = join(root, "copy");
    const result = await copyForReplay({ from: source, to: copy, cutAtMs: T0 - MIN });
    expect(result.lastSeq).toBe(0);
    const state = JSON.parse(readFileSync(join(copy, STATE_FILE), "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({ lastSeq: 0, asks: [], wakes: [], threads: { "cli:owner": { seenSeq: 0 }, "room:harbour": { seenSeq: 0 } } });
    expect(state).not.toHaveProperty("lastOwnerMs");
  });
});

describe("copyForReplay fork at row N", () => {
  it("keeps the rows before seq N, and cuts the notebook and state at row N's time", async () => {
    const source = join(root, "source");
    const { firstSha, secondSha } = buildSource(source);
    const atThree = await copyForReplay({ from: source, to: join(root, "c3"), cutAtSeq: 3 });
    expect(atThree.lastSeq).toBe(2);
    expect(atThree.notebookCommit).toBe(firstSha);
    const atFour = await copyForReplay({ from: source, to: join(root, "c4"), cutAtSeq: 4 });
    expect(atFour.lastSeq).toBe(3);
    expect(atFour.notebookCommit).toBe(secondSha);
    const river = openRiver(join(root, "c4", "river.db"));
    expect(river.read({ limit: 100 }).map((row) => row.text)).toEqual(["Hello.", "Hello back.", "Still there?"]);
    river.close();
    expect(lastSeqOf(source)).toBe(4);
  });

  it("refuses a row that is not in the river, and both a time and a row", async () => {
    const source = join(root, "source");
    buildSource(source);
    await expect(copyForReplay({ from: source, to: join(root, "x"), cutAtSeq: 9 })).rejects.toThrow(/no row 9/);
    await expect(copyForReplay({ from: source, to: join(root, "y"), cutAtSeq: 0 })).rejects.toThrow(/no row 0/);
    await expect(copyForReplay({ from: source, to: join(root, "z"), cutAtMs: CUT, cutAtSeq: 2 })).rejects.toThrow(/not both/);
  });
});

