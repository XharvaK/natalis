import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLedger } from "../../river/ledger.js";
import { openRiver, type SqliteRiver } from "../../river/index.js";
import { keepVaultEntry } from "../../worlds/web/vault.js";
import { probeCommand } from "./probe.js";

// Every person, place and word here is invented.
const DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 0, 1);
const markers = {
  life: "kestrelmarkerlife",
  lifeTwo: "kestrelmarkerwork",
  character: "kestrelmarkercharacter",
  note: "kestrelmarkernote",
  river: "kestrelmarkerriver",
  vault: "kestrelmarkervault",
  state: "kestrelmarkerstate",
  grants: "kestrelmarkergrants",
  requests: "kestrelmarkerrequests",
};

let root: string;
let dir: string;
let out: string[];
let err: string[];
let river: SqliteRiver | undefined;
let ledger: ReturnType<typeof openLedger> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-probe-"));
  dir = join(root, "iris");
  mkdirSync(join(dir, "notebook", "self"), { recursive: true });
  mkdirSync(join(dir, "notebook", "memory"), { recursive: true });
  mkdirSync(join(dir, "vault"), { recursive: true });
  out = [];
  err = [];
});

afterEach(() => {
  ledger?.close();
  river?.close();
  ledger = undefined;
  river = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function run(args: readonly string[]): Promise<number> {
  out = [];
  err = [];
  return probeCommand(args, (line) => out.push(line), (line) => err.push(line));
}

function report(): Record<string, unknown> {
  expect(err).toEqual([]);
  return JSON.parse(out.join("\n")) as Record<string, unknown>;
}

/** Every leaf value, with the dotted path that reaches it. */
function leaves(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      leaves(item, path === "" ? key : `${path}.${key}`),
    );
  }
  return [{ path, value }];
}

/** Every file under a folder, with its modification time. */
function fileTimes(folder: string): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.set(path, statSync(path).mtimeMs);
    }
  };
  walk(folder);
  return found;
}

function makeFixture(): { life: string; character: string; walBytes: number; shmBytes: number } {
  const life = `# Life\n\nI live near ${markers.life}.\n\n## Work\n\nI work with ${markers.lifeTwo}.\n`;
  const character = `# Character\n\nI am ${markers.character}.\n`;
  writeFileSync(join(dir, "notebook", "self", "life.md"), life, "utf8");
  writeFileSync(join(dir, "notebook", "self", "character.md"), character, "utf8");
  writeFileSync(join(dir, "notebook", "memory", "garden.md"), `# Garden\n\n${markers.note}\n`, "utf8");

  river = openRiver(join(dir, "river.db"));
  river.append({ thread: "self", kind: "note", source: "body", text: markers.river, data: { word: markers.river }, atMs: DAY0 });
  river.append({ thread: "cli:summoner", kind: "event", source: "owner", text: `${markers.river} again`, atMs: DAY0 + 1_000 });

  ledger = openLedger(join(dir, "river.db"));
  const addTurn = (atMs: number, threadKind: "summoner" | "game", promptTokens: number, cacheHitTokens: number): void => {
    ledger?.append({
      atMs,
      threadKind,
      endedBy: "end_turn",
      outcome: "answered",
      model: "test-model",
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
      cacheHitTokens,
      backupUsed: false,
    });
  };
  addTurn(DAY0, "summoner", 100, 80);
  addTurn(DAY0 + 1_000, "summoner", 100, 70);
  addTurn(DAY0 + 2_000, "summoner", 100, 60);
  addTurn(DAY0 + 2 * DAY, "summoner", 100, 80);
  addTurn(DAY0 + 2 * DAY + 1_000, "game", 50, 10);

  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      lastSeq: 2,
      threads: {},
      asks: [
        { place: `${markers.state}:one`, seq: 1, atMs: DAY0 },
        { place: `${markers.state}:two`, seq: 2, atMs: DAY0 + 1_000 },
      ],
      wakes: [{ id: "w1", atMs: DAY0, why: markers.state, scheduledIn: "self" }],
      mood: null,
      placeClaims: {},
      stopOn: false,
      proposals: [],
      actsSeenSeq: 0,
      stoppedCleanly: true,
      rhythmTagged: true,
    }),
    "utf8",
  );

  const grants = new DatabaseSync(join(dir, "grants.db"));
  try {
    grants.exec("CREATE TABLE grants (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE requests (id TEXT PRIMARY KEY, note TEXT);");
    grants.prepare("INSERT INTO grants (id, note) VALUES (?, ?)").run("g1", markers.grants);
    grants.prepare("INSERT INTO requests (id, note) VALUES (?, ?)").run("r1", markers.requests);
  } finally {
    grants.close();
  }

  keepVaultEntry(dir, "board_key", { host: "board.example.org", value: markers.vault });

  // The writer connections are held open, so the newest rows live in the write-ahead log. A probe that
  // opens the file in place without seeing the log would count too few rows, and one that locks or
  // checkpoints it would change the folder.
  const walBytes = statSync(join(dir, "river.db-wal")).size;
  const shmBytes = statSync(join(dir, "river.db-shm")).size;
  return { life, character, walBytes, shmBytes };
}

describe("natalis probe", () => {
  it("prints only numbers and booleans, and none of the words in the notes, rows, life, character or vault", async () => {
    const fixture = makeFixture();
    const before = fileTimes(dir);

    expect(await run(["--dir", dir])).toBe(0);
    const firstText = out.join("\n");
    const first = report();
    expect(await run(["--dir", dir, "--turns", "1"])).toBe(0);
    const secondText = out.join("\n");
    const oneTurn = report();

    const printed = `${firstText}\n${secondText}`;
    for (const marker of Object.values(markers)) expect(printed).not.toContain(marker);
    for (const leaf of leaves(first)) {
      expect(Number.isNaN(leaf.value)).toBe(false);
      expect(leaf.value).not.toBeNull();
      expect(["number", "boolean"]).toContain(typeof leaf.value);
      if (typeof leaf.value === "number") expect(Number.isFinite(leaf.value)).toBe(true);
    }
    expect(fileTimes(dir)).toEqual(before);

    expect(first.life).toEqual({ codePoints: [...fixture.life].length, headings: 2 });
    expect(first.character).toEqual({ codePoints: [...fixture.character].length });
    expect(first.river).toEqual({
      rows: 2,
      dbBytes: statSync(join(dir, "river.db")).size,
      walBytes: fixture.walBytes,
      shmBytes: fixture.shmBytes,
    });
    expect(first.stoppedCleanly).toBe(true);
    expect(first.rhythmTagged).toBe(true);
    expect(first.open).toEqual({ asks: 2, wakes: 1, grants: 1, requests: 1 });
    expect(first.tables).toMatchObject({ turn_ledger: 5, call_ledger: 0 });
    expect((first.tables as Record<string, number>).rows).toBeUndefined();
    expect((first.tables as Record<string, number>).river_fts).toBeUndefined();

    const defaultLedger = first.ledger as Record<string, unknown>;
    expect(defaultLedger.turns).toBe(5);
    expect(defaultLedger.measuredTurns).toBe(5);
    expect(defaultLedger.cacheShare).toBe(0.6667);
    expect(defaultLedger.turnsPerDay).toEqual({ game: 1, summoner: 1.33 });

    const narrowLedger = oneTurn.ledger as Record<string, unknown>;
    expect(narrowLedger.turns).toBe(1);
    expect(narrowLedger.cacheShare).toBe(0.2);
  });

  it("reads zeros and false from a folder with no state, notebook, river or grant store", async () => {
    expect(await run(["--dir", dir])).toBe(0);
    const first = report();
    expect(first).toEqual({
      life: { codePoints: 0, headings: 0 },
      character: { codePoints: 0 },
      river: { rows: 0, dbBytes: 0, walBytes: 0, shmBytes: 0 },
      tables: {},
      stoppedCleanly: false,
      rhythmTagged: false,
      open: { asks: 0, wakes: 0, grants: 0, requests: 0 },
      ledger: { turns: 0, measuredTurns: 0, cacheShare: 0, turnsPerDay: {} },
    });
    expect(readdirSync(dir).sort()).toEqual(["notebook", "vault"]);
  });

  it("refuses a missing --dir and a --turns that is not a whole number of turns", async () => {
    expect(await run([])).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis probe");
    expect(out).toEqual([]);

    err = [];
    expect(await run(["--dir", dir, "--turns", "0"])).toBe(2);
    expect(err.join("\n")).toContain("--turns");
    err = [];
    expect(await run(["--dir", dir, "--turns", "many"])).toBe(2);
    expect(err.join("\n")).toContain("--turns");
    expect(out).toEqual([]);
  });

  it("fails loudly when state.json is not readable as an object", async () => {
    writeFileSync(join(dir, "state.json"), `{ not json ${markers.state}`, "utf8");
    expect(await run(["--dir", dir])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("state.json");
    expect(err.join("\n")).not.toContain(markers.state);
  });
});
