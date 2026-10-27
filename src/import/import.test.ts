import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "../bin/commands/import.js";
import type { RiverRow } from "../contracts.js";
import type { EntityConfig } from "../entity/config.js";
import { acquireLarLock, LAR_LOCK_BUSY_MESSAGE } from "../entity/lar-lock.js";
import { openEntity, STATE_FILE } from "../entity/runtime.js";
import { openRiver } from "../river/index.js";
import { createSecretScanner } from "../secrets/index.js";
import { ScriptedModel } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { applyImport, buildState, chronological } from "./apply.js";
import { readBundle, checkNotebookPath, type Problem } from "./bundle.js";
import { readEntityFolder } from "./folder.js";
import { runImport } from "./index.js";
import { makePlan } from "./plan.js";

// The fake credential is built from parts at run time, so no token-shaped literal sits in the source.
const FAKE_KEY = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");

const T0 = Date.UTC(2026, 1, 28, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://model.example.invalid/v1", model: "scripted", contextTokens: 32_000 },
  owner: { alias: "owner" },
};

const GOOD_ROWS: Array<Record<string, unknown>> = [
  { atMs: T0, thread: "cli:owner", kind: "event", source: "owner", actor: "owner", place: "cli:owner", text: "Hello, Mara." },
  { atMs: T0 + 1_000, thread: "cli:owner", kind: "say", source: "self", place: "cli:owner", text: "Hello. Good to see you." },
  {
    atMs: T0 + HOUR,
    thread: "room:harbour",
    kind: "event",
    source: "outside",
    actor: "tomas",
    place: "room:harbour",
    text: "The boats are in.",
    data: { importedId: "m-1" },
  },
  { atMs: T0 + 2 * HOUR, thread: "cli:owner", kind: "note", source: "body", text: "The model was swapped." },
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-import-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

type Spec = {
  meta?: Record<string, unknown>;
  rows?: Array<Record<string, unknown> | string>;
  tombstones?: Array<Record<string, unknown> | string>;
  notes?: Record<string, string | Buffer>;
  provenance?: Record<string, string>;
};

/** Writes a bundle folder with sensible defaults; any part can be replaced by the test. */
function writeBundle(spec: Spec = {}): string {
  const dir = join(root, `bundle-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "bundle.json"),
    JSON.stringify({
      format: "natalis-seed-bundle",
      version: 1,
      source: "an older notebook export",
      createdAt: "2026-03-01T10:00:00Z",
      ...(spec.meta ?? {}),
    }),
  );
  const rows = spec.rows ?? GOOD_ROWS;
  writeFileSync(join(dir, "river.jsonl"), rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n");
  const tombstones = spec.tombstones ?? [
    { atMs: T0 + 3 * HOUR, by: "owner", reason: "forgotten by the owner (3 rows)", count: 3, what: "message" },
  ];
  writeFileSync(
    join(dir, "tombstones.jsonl"),
    tombstones.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") + "\n",
  );
  const notes = spec.notes ?? { "people/mara.md": "# Mara\n\nA friend from the harbour.\n" };
  for (const [path, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(dir, "notes", path)), { recursive: true });
    writeFileSync(join(dir, "notes", path), text);
  }
  for (const [path, text] of Object.entries(spec.provenance ?? {})) {
    mkdirSync(dirname(join(dir, "provenance", path)), { recursive: true });
    writeFileSync(join(dir, "provenance", path), text);
  }
  return dir;
}

/** The problem reported for one line. */
function messageAt(problems: Problem[], line: number): string {
  return problems.find((problem) => problem.line === line)?.message ?? "";
}

/** SQLite leaves its -wal and -shm coordination files beside river.db when it is opened read-only. No data is in them. */
function withoutSqliteFiles(tree: string[]): string[] {
  return tree.filter((line) => !/river.db-(wal|shm) /.test(line));
}

function listTree(dir: string): string[] {
  if (!existsSync(dir)) return ["(missing)"];
  const out: string[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), rel);
      else out.push(`${rel} ${statSync(join(folder, entry.name)).size}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** A fresh entity folder, as a first start leaves it: seeded notebook, empty river, state file. */
async function freshEntity(name = "entity"): Promise<string> {
  const dir = join(root, name);
  const entity = await openEntity({
    dir,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  await entity.stop();
  return dir;
}

function read(bundleDir: string) {
  const result = readBundle(bundleDir, createSecretScanner());
  if (!result.ok) throw new Error(`expected a readable bundle: ${JSON.stringify(result.problems)}`);
  return result;
}

function problemsOf(bundleDir: string): Problem[] {
  const result = readBundle(bundleDir, createSecretScanner());
  if (result.ok) throw new Error("expected problems");
  return result.problems;
}

describe("reading a bundle", () => {
  it("reads a good bundle: notes, rows, tombstones and provenance", () => {
    const bundle = read(writeBundle({ provenance: { "ids/discord.md": "Platform ids kept here.\n" } })).bundle;
    expect(bundle.source).toBe("an older notebook export");
    expect(bundle.rows).toHaveLength(4);
    expect(bundle.rows[2]?.data).toEqual({ importedId: "m-1" });
    expect(bundle.tombstones).toHaveLength(1);
    expect(bundle.notes.map((file) => file.path)).toEqual(["people/mara.md"]);
    expect(bundle.provenance.map((file) => file.path)).toEqual(["provenance/ids/discord.md"]);
  });

  it("refuses a bundle with the wrong format or version, and a missing source", () => {
    const wrongFormat = problemsOf(writeBundle({ meta: { format: "other" } }));
    expect(wrongFormat.some((p) => p.file === "bundle.json" && /format/.test(p.message))).toBe(true);
    const wrongVersion = problemsOf(writeBundle({ meta: { version: 2 } }));
    expect(wrongVersion.some((p) => /version/.test(p.message))).toBe(true);
    const noSource = problemsOf(writeBundle({ meta: { source: "" } }));
    expect(noSource.some((p) => /source/.test(p.message))).toBe(true);
  });

  it("names the first row that is out of time order, by line number", () => {
    const rows = [GOOD_ROWS[0], GOOD_ROWS[2], GOOD_ROWS[1]];
    const problems = problemsOf(writeBundle({ rows }));
    expect(problems).toEqual([
      expect.objectContaining({ file: "river.jsonl", line: 3, message: expect.stringMatching(/sorted by atMs/) }),
    ]);
  });

  it("checks every river field and its enum, with the line number", () => {
    const problems = problemsOf(
      writeBundle({
        rows: [
          { atMs: 1.5, thread: "a", kind: "event", source: "owner" },
          { atMs: T0, thread: "a", kind: "tombstone", source: "owner" },
          { atMs: T0, thread: "a", kind: "event", source: "robot" },
          { atMs: T0, thread: "", kind: "event", source: "owner" },
          { atMs: T0, thread: "a", kind: "event", source: "owner", data: [1] },
          { atMs: T0, thread: "a", kind: "event", source: "owner", extra: true },
          "{not json",
        ],
      }),
    );
    const lines = problems.map((p) => p.line);
    expect(lines.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(messageAt(problems, 1)).toMatch(/whole number/);
    expect(messageAt(problems, 2)).toMatch(/event, say or note/);
    expect(messageAt(problems, 7)).toMatch(/not valid JSON/);
  });

  it("checks the tombstone fields and keeps them whether or not they are in order", () => {
    const readable = read(
      writeBundle({
        tombstones: [
          { atMs: T0 + HOUR, by: "self", reason: "a later forget" },
          { atMs: T0, by: "owner", reason: "an earlier forget", count: 2 },
        ],
      }),
    ).bundle;
    expect(readable.tombstones.map((item) => item.atMs)).toEqual([T0 + HOUR, T0]);
    const problems = problemsOf(writeBundle({ tombstones: [{ atMs: T0, by: "robot", reason: "x", count: -1 }] }));
    expect(problems.map((p) => p.message).join(" ")).toMatch(/by must be/);
    expect(problems.map((p) => p.message).join(" ")).toMatch(/count must be/);
  });

  it("accepts only .md and .txt notes, UTF-8 text, and no links", () => {
    const problems = problemsOf(
      writeBundle({
        notes: { "people/mara.md": "ok", "photos/cat.png": "not text", "people/bad.md": Buffer.from([0xff, 0xfe, 0x00]) },
      }),
    );
    const files = problems.map((p) => p.file).sort();
    expect(files).toEqual(["notes/people/bad.md", "notes/photos/cat.png"]);
    expect(problems.find((p) => p.file === "notes/people/bad.md")?.message).toMatch(/UTF-8|zero byte/);
  });

  it("refuses paths that would leave the notebook or reach git's own folder", () => {
    const problems: Problem[] = [];
    const ok = (rel: string) => checkNotebookPath(rel, "notes/x.md", problems, true);
    expect(ok("people/mara.md")).toBe("people/mara.md");
    expect(ok("a/../b.md")).toBeUndefined();
    expect(ok("/etc/x.md")).toBeUndefined();
    expect(ok("a\\b.md")).toBeUndefined();
    expect(ok("c:x.md")).toBeUndefined();
    expect(ok(".git/config.md")).toBeUndefined();
    expect(ok("notes./x.md")).toBeUndefined();
    expect(ok("forgotten.md")).toBeUndefined();
    expect(checkNotebookPath("forgotten.md", "provenance/forgotten.md", problems, false)).toBe("forgotten.md");
    expect(problems.length).toBeGreaterThan(6);
  });

  it("reports a missing bundle folder and a bundle with no bundle.json", () => {
    expect(readBundle(join(root, "nowhere"), createSecretScanner())).toMatchObject({ ok: false });
    const empty = join(root, "empty-bundle");
    mkdirSync(empty);
    expect(problemsOf(empty)[0]?.message).toMatch(/missing/);
  });
});

describe("secret scan", () => {
  it("refuses items that hold a credential-like string, by file and line, never by value", () => {
    const dir = writeBundle({
      rows: [GOOD_ROWS[0], { ...GOOD_ROWS[1], text: `the key is ${FAKE_KEY}` }],
      notes: { "people/mara.md": `# Mara\n\nFine line.\nkey: ${FAKE_KEY}\n` },
      tombstones: [{ atMs: T0, by: "owner", reason: `forgot ${FAKE_KEY}` }],
    });
    const result = read(dir);
    expect(result.refused.map((r) => [r.file, r.line, r.item])).toEqual([
      ["river.jsonl", 2, "river row"],
      ["tombstones.jsonl", 1, "tombstone"],
      ["notes/people/mara.md", 4, "note"],
    ]);
    const shown = JSON.stringify(result.refused);
    expect(shown).not.toContain(FAKE_KEY);
    expect(shown).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("holds a secret in a note even when the secret spans lines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    const result = read(writeBundle({ notes: { "people/mara.md": `intro\n${pem}\n` } }));
    expect(result.refused.map((r) => r.line)).toEqual([2]);
  });
});

describe("the plan", () => {
  it("is a dry run by default: it prints the plan and writes nothing", async () => {
    const bundleDir = writeBundle({ provenance: { "ids/discord.md": "ids\n" } });
    const target = join(root, "not-yet");
    const outcome = await runImport({ dir: target, bundleDir, apply: false, skipRefused: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toBe(false);
    expect(existsSync(target)).toBe(false);
    const text = outcome.lines.join("\n");
    expect(text).toMatch(/Dry run: nothing was written/);
    expect(text).toMatch(/new\s+people\/mara\.md/);
    expect(text).toMatch(/2026-02: 4/);
    expect(text).toMatch(/event\/owner: 1/);
    expect(text).toMatch(/Tombstones to write: 1/);
    expect(text).toMatch(/no entity\.json yet/);
  });

  it("does not change an existing entity folder in a dry run", async () => {
    const dir = await freshEntity();
    const before = listTree(dir);
    await runImport({ dir, bundleDir: writeBundle(), apply: false, skipRefused: false });
    expect(withoutSqliteFiles(listTree(dir))).toEqual(withoutSqliteFiles(before));
  });

  it("says a note replaces a seed, and marks a note over an existing seed file", async () => {
    const dir = await freshEntity();
    const bundleDir = writeBundle({ notes: { "self/character.md": "# Character\n\nI am Mara.\n", "people/README.md": "# people\n\nMine.\n" } });
    const folder = readEntityFolder(dir);
    const plan = makePlan(read(bundleDir).bundle, [], folder, { skipRefused: false });
    expect(plan.notes.map((note) => [note.path, note.action])).toEqual([
      ["people/README.md", "replaces seed"],
      ["self/character.md", "replaces seed"],
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it("counts rows per month and per kind and source, and splits off refused rows", () => {
    const folder = readEntityFolder(join(root, "no-such-entity"));
    const bundle = read(writeBundle({ rows: [...GOOD_ROWS, { atMs: T0 + 3 * HOUR, thread: "a", kind: "say", source: "self", text: "token " + FAKE_KEY }] })).bundle;
    const refused = read(writeBundle({ rows: [...GOOD_ROWS, { atMs: T0 + 3 * HOUR, thread: "a", kind: "say", source: "self", text: "token " + FAKE_KEY }] })).refused;
    const plan = makePlan(bundle, refused, folder, { skipRefused: true });
    expect(plan.rows.written).toBe(4);
    expect(plan.rows.refused).toBe(1);
    expect(plan.rows.byKindSource).toEqual([
      { key: "event/outside", count: 1 },
      { key: "event/owner", count: 1 },
      { key: "note/body", count: 1 },
      { key: "say/self", count: 1 },
    ]);
  });
});

describe("conflicts and blocks", () => {
  it("stops at an existing notebook file that is not a seed, and writes nothing", async () => {
    const dir = await freshEntity();
    mkdirSync(join(dir, "notebook", "memory"), { recursive: true });
    writeFileSync(join(dir, "notebook", "memory", "old.md"), "already here\n");
    const before = listTree(dir);
    const outcome = await runImport({ dir, bundleDir: writeBundle(), apply: true, skipRefused: false });
    expect(outcome.applied).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/notebook\/memory\/old\.md already exists/);
    expect(withoutSqliteFiles(listTree(dir))).toEqual(withoutSqliteFiles(before));
  });

  it("stops when the river already holds rows", async () => {
    const dir = await freshEntity();
    const river = openRiver(join(dir, "river.db"));
    river.append({ thread: "cli:owner", kind: "note", source: "body", text: "started" });
    river.close();
    const outcome = await runImport({ dir, bundleDir: writeBundle(), apply: true, skipRefused: false });
    expect(outcome.applied).toBe(false);
    expect(outcome.lines.join("\n")).toMatch(/already holds 1 rows/);
  });

  it("stops at refused items unless --skip-refused is given, and then leaves them out", async () => {
    const bundleDir = writeBundle({ notes: { "people/mara.md": `key ${FAKE_KEY}\n`, "people/tomas.md": "A boat man.\n" } });
    const blockedDir = join(root, "blocked");
    const blocked = await runImport({ dir: blockedDir, bundleDir, apply: true, skipRefused: false });
    expect(blocked.applied).toBe(false);
    expect(blocked.lines.join("\n")).toMatch(/notes\/people\/mara\.md line 1: note; looks like it holds a credential/);
    expect(blocked.lines.join("\n")).not.toContain(FAKE_KEY);
    expect(existsSync(blockedDir)).toBe(false);

    const skipDir = join(root, "skipped");
    const applied = await runImport({ dir: skipDir, bundleDir, apply: true, skipRefused: true });
    expect(applied.applied).toBe(true);
    const notebook = join(skipDir, "notebook");
    expect(readFileSync(join(notebook, "people", "tomas.md"), "utf8")).toBe("A boat man.\n");
    expect(existsSync(join(notebook, "people", "mara.md"))).toBe(false);
  });
});

describe("applying", () => {
  it("writes the notes, the river in order with its times, the tombstones and the forgotten list", async () => {
    const dir = join(root, "fresh");
    const bundleDir = writeBundle({
      provenance: { "ids/discord.md": "Platform ids are kept here.\n" },
      tombstones: [
        { atMs: T0 + 3 * HOUR, by: "owner", reason: "forgotten by the owner (3 rows)", count: 3, what: "message" },
        { atMs: T0 + HOUR / 2, by: "self", reason: "let go of a belief" },
      ],
    });
    const outcome = await runImport({ dir, bundleDir, apply: true, skipRefused: false });
    expect(outcome.applied).toBe(true);
    expect(outcome.counts).toMatchObject({ rows: 4, tombstones: 2, notes: 1, provenance: 1 });

    const river = openRiver(join(dir, "river.db"));
    const rows = river.read({ limit: 100 });
    river.close();
    const kinds = rows.map((row: RiverRow) => `${row.kind}:${row.atMs - T0}`);
    expect(kinds).toEqual([
      "event:0",
      "say:1000",
      "tombstone:1800000",
      "event:3600000",
      "note:7200000",
      "tombstone:10800000",
    ]);
    const owner = rows.find((row) => row.kind === "tombstone" && row.source === "owner");
    expect(owner?.text).toBeUndefined();
    expect(owner?.data).toEqual({ by: "owner", reason: "forgotten by the owner (3 rows)", count: 3, what: "message", imported: true });
    expect(rows.find((row) => row.kind === "event" && row.thread === "room:harbour")?.data).toEqual({ importedId: "m-1" });

    const notebook = join(dir, "notebook");
    expect(readFileSync(join(notebook, "people", "mara.md"), "utf8")).toContain("A friend from the harbour.");
    expect(readFileSync(join(notebook, "provenance", "ids", "discord.md"), "utf8")).toBe("Platform ids are kept here.\n");
    const forgotten = readFileSync(join(notebook, "forgotten.md"), "utf8");
    expect(forgotten).toContain("by owner: forgotten by the owner (3 rows) (count 3, kind message)");
    expect(forgotten).toContain("by self: let go of a belief");
    expect(forgotten).not.toContain("Hello, Mara");
    const subjects = execFileSync("git", ["-C", notebook, "log", "--format=%s|%an"], { encoding: "utf8" });
    expect(subjects).toContain("Imported from an older notebook export|body");
    expect(existsSync(join(notebook, "self", "character.md"))).toBe(true);
  });

  it("writes state.json calm: caught up threads, no asks, wakes or mood, and the newest owner time", async () => {
    const dir = join(root, "calm");
    await runImport({ dir, bundleDir: writeBundle(), apply: true, skipRefused: false });
    const state = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Record<string, unknown>;
    expect(state).toEqual({
      lastSeq: 5,
      threads: {
        "cli:owner": { seenSeq: 5 },
        "room:harbour": { seenSeq: 5 },
      },
      asks: [],
      wakes: [],
      mood: null,
      lastOwnerMs: T0,
    });
  });

  it("starts with no scripted replies and runs no turn: imported history never starts a turn", async () => {
    const dir = join(root, "started");
    await runImport({ dir, bundleDir: writeBundle({ notes: { "people/mara.md": "Mara.\n", "self/constitution.md": "Mine.\n" } }), apply: true, skipRefused: false });
    const model = new ScriptedModel([]);
    const entity = await openEntity({
      dir,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    await entity.start();
    await entity.idle();
    const lastSeq = entity.river.lastSeq();
    await entity.stop();
    expect(model.requests).toHaveLength(0);
    // Five imported rows, then the body's start note, which is the sixth.
    expect(lastSeq).toBe(6);
    expect(entity.notebook.read("people/mara.md")).toBe("Mara.\n");
    expect(entity.notebook.read("self/constitution.md")).toBe("Mine.\n");
    expect(entity.notebook.read("people/README.md")).toContain("# people");
    expect(entity.notebook.read("forgotten.md")).toContain("Forgotten before the import");
  });

  it("replaces a seed stub with the bundle's note, and keeps the other seeds", async () => {
    const dir = await freshEntity("seeded");
    const bundleDir = writeBundle({ notes: { "self/character.md": "# Character\n\nI am Mara's friend.\n" } });
    const outcome = await runImport({ dir, bundleDir, apply: true, skipRefused: false });
    expect(outcome.applied).toBe(true);
    expect(readFileSync(join(dir, "notebook", "self", "character.md"), "utf8")).toBe("# Character\n\nI am Mara's friend.\n");
    expect(readFileSync(join(dir, "notebook", "self", "constitution.md"), "utf8")).toContain("Nothing is written here yet");
    expect(readFileSync(join(dir, "notebook", "people", "README.md"), "utf8")).toContain("# people");
  });

  it("a second apply is refused: the river is no longer empty", async () => {
    const dir = join(root, "twice");
    const bundleDir = writeBundle();
    expect((await runImport({ dir, bundleDir, apply: true, skipRefused: false })).applied).toBe(true);
    const again = await runImport({ dir, bundleDir, apply: true, skipRefused: false });
    expect(again.applied).toBe(false);
    expect(again.lines.join("\n")).toMatch(/already holds/);
  });

  it("without state.json, an imported folder refuses to start, so a cut-short import cannot run", async () => {
    const dir = join(root, "cut-short");
    const bundle = read(writeBundle()).bundle;
    const plan = makePlan(bundle, [], readEntityFolder(dir), { skipRefused: false });
    await applyImport(dir, bundle, plan);
    // The import writes state.json last. Without it the runtime refuses a river that has rows and no state file.
    rmSync(join(dir, STATE_FILE));
    await expect(openEntity({ dir, config: CONFIG, model: new ScriptedModel([]), worlds: [] })).rejects.toThrow(
      /state\.json is missing/,
    );
  });
});

describe("natalis import and the Lar folder lock", () => {
  it("import --apply is refused while another holder has the lock; a dry run does not need it", async () => {
    const target = join(root, "iris");
    mkdirSync(target);
    writeFileSync(join(target, "entity.json"), JSON.stringify(CONFIG));
    const bundleDir = writeBundle();
    const logged: string[] = [];
    const complained: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      complained.push(args.map(String).join(" "));
    });
    try {
      const lock = acquireLarLock(target);
      try {
        expect(await importCommand(["--dir", target, "--bundle", bundleDir, "--apply"])).toBe(1);
        expect(complained.join("\n")).toContain(LAR_LOCK_BUSY_MESSAGE);
        expect(existsSync(join(target, "river.db"))).toBe(false);
        // A dry run writes nothing, so it does not need the lock.
        expect(await importCommand(["--dir", target, "--bundle", bundleDir])).toBe(0);
        expect(logged.join("\n")).toContain("Dry run: nothing was written");
      } finally {
        lock.release();
      }
      // With the lock free, the same apply goes ahead.
      expect(await importCommand(["--dir", target, "--bundle", bundleDir, "--apply"])).toBe(0);
      expect(existsSync(join(target, "river.db"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("the helpers", () => {
  it("merges rows and tombstones in time order, with a row first when the times are equal", () => {
    const bundle = read(
      writeBundle({
        rows: [GOOD_ROWS[0], GOOD_ROWS[1]],
        tombstones: [{ atMs: T0 + 1_000, by: "owner", reason: "same moment" }],
      }),
    ).bundle;
    const order = chronological(bundle.rows, bundle.tombstones).map((entry) => `${entry.kind}:${entry.atMs - T0}`);
    expect(order).toEqual(["row:0", "row:1000", "tombstone:1000"]);
  });

  it("builds a calm state, with the newest owner time and every imported thread caught up", () => {
    const rows = read(writeBundle()).bundle.rows;
    expect(buildState(9, rows)).toEqual({
      lastSeq: 9,
      threads: { "cli:owner": { seenSeq: 9 }, "room:harbour": { seenSeq: 9 } },
      asks: [],
      wakes: [],
      mood: null,
      lastOwnerMs: T0,
    });
    expect(buildState(0, [])).toEqual({ lastSeq: 0, threads: {}, asks: [], wakes: [], mood: null });
  });
});
