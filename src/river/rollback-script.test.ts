import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLarLock, LarLockBusy } from "../entity/lar-lock.js";
import { grantsPath, openGrants } from "../entity/grants.js";
import { memoryRollbackCommand, runMemoryRollback } from "../bin/scripts/memory-rollback.js";
import { BASE_061AF27_DOMUS_SQLITE, BASE_061AF27_RIVER_DB, isBaseDomusTable } from "./base-tables.js";
import { derivedTableNames, registerDerivedStore, type DerivedStore, type OutsideCascade } from "./derived.js";
import { openRiver } from "./sqlite-river.js";
import { threadHashKeyPath } from "./thread-key.js";

// Every name and line here is invented. The word is built from parts so no test literal looks like data.
const PROBE_WORD = ["zor", "vil", "quen", "tay"].join("");

/** The probe store stands in for the U9-U12 tables: it lives in river.db and holds text. */
const PROBE_STORE: DerivedStore = {
  tables: ["probe_derived"],
  schema: [
    "CREATE TABLE IF NOT EXISTS probe_derived (id INTEGER PRIMARY KEY AUTOINCREMENT, source_seq INTEGER, text TEXT NOT NULL)",
  ],
  cascade() {
    return 0;
  },
};
registerDerivedStore(PROBE_STORE);

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-rollback-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function riverPath(): string {
  return join(dir, "river.db");
}

function makeRiver(text = "Other words stay here."): void {
  const river = openRiver(riverPath());
  try {
    river.append({ thread: "dm:owner", kind: "event", source: "owner", text });
  } finally {
    river.close();
  }
}

function seedDerived(sourceSeq = 1, text = `A ${PROBE_WORD} line.`): void {
  const db = new DatabaseSync(riverPath());
  try {
    db.prepare("INSERT INTO probe_derived (source_seq, text) VALUES (?, ?)").run(sourceSeq, text);
  } finally {
    db.close();
  }
}

function tableNames(file = riverPath()): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

function rowCount(table: string, file = riverPath()): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function userVersion(file = riverPath()): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
}

function fileHas(file: string, text: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file).includes(Buffer.from(text));
}

function walSize(): number {
  const file = `${riverPath()}-wal`;
  return existsSync(file) ? statSync(file).size : 0;
}

/** The 061af27 schema, made directly: rows, its two indexes, FTS5 with every shadow table, both ledgers. */
function makeBaseRiver(): void {
  const db = new DatabaseSync(riverPath());
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE rows (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        thread TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        place TEXT,
        actor TEXT,
        text TEXT,
        data_json TEXT,
        forgotten INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX rows_thread_seq ON rows(thread, seq);
      CREATE INDEX rows_at_ms ON rows(at_ms);
      CREATE VIRTUAL TABLE river_fts USING fts5(text);
      CREATE TABLE turn_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL);
      CREATE TABLE call_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL);
    `);
    db.prepare("INSERT INTO rows (at_ms, thread, kind, source, text) VALUES (?, ?, ?, ?, ?)").run(
      1_700_000_000_000,
      "dm:owner",
      "event",
      "owner",
      "A base row stays.",
    );
    db.exec("INSERT INTO river_fts(rowid, text) VALUES (1, 'A base row stays.')");
    db.exec("ANALYZE");
    db.exec("PRAGMA user_version = 1");
  } finally {
    db.close();
  }
}

function staticOutside(): { handler: OutsideCascade; calls: number[][] } {
  const calls: number[][] = [];
  return {
    handler: {
      store: "probe_outside",
      run(input) {
        calls.push([...input.seqs]);
      },
    },
    calls,
  };
}

describe("memory-rollback: the end state", () => {
  it("after the script the derived tables are empty, user_version is unchanged, rows and river_fts are untouched, and a known derived text is absent from river.db, river.db-wal and river.db-shm; river.db-wal is 0 bytes", async () => {
    makeRiver("Other words stay here.");
    seedDerived(1, `A ${PROBE_WORD} line.`);

    await runMemoryRollback({ dir });

    expect(tableNames()).toContain("probe_derived");
    expect(rowCount("probe_derived")).toBe(0);
    expect(userVersion()).toBe(1);
    for (const name of ["river.db", "river.db-wal", "river.db-shm"]) {
      expect(fileHas(join(dir, name), PROBE_WORD), name).toBe(false);
    }
    expect(walSize()).toBe(0);

    // The river's own row and its search index are untouched.
    const river = openRiver(riverPath());
    try {
      expect(river.read({}).map((row) => row.text)).toContain("Other words stay here.");
      expect(river.search("stay").map((hit) => hit.row.seq)).toEqual([1]);
    } finally {
      river.close();
    }
  });

  it("the script refuses while run holds the Lar lock, and changes nothing", async () => {
    makeRiver();
    seedDerived();
    const lock = acquireLarLock(dir);
    try {
      await expect(runMemoryRollback({ dir })).rejects.toBeInstanceOf(LarLockBusy);
    } finally {
      lock.release();
    }
    expect(rowCount("probe_derived")).toBe(1);
  });

  it("the rollback leaves exactly the Auditor's base set", async () => {
    makeRiver();
    seedDerived();
    const before = tableNames();
    const baseBefore = before.filter((name) => !name.startsWith("sqlite_") && !derivedTableNames().includes(name));

    await runMemoryRollback({ dir });

    const after = tableNames();
    const baseAfter = after.filter((name) => !name.startsWith("sqlite_") && !derivedTableNames().includes(name));
    expect(baseAfter).toEqual(baseBefore);
    for (const name of derivedTableNames()) {
      if (after.includes(name)) expect(rowCount(name), name).toBe(0);
    }
    // The Auditor's list is the one the script used.
    expect(BASE_061AF27_RIVER_DB).toEqual(
      expect.arrayContaining(["rows", "river_fts", "turn_ledger", "call_ledger", "sqlite_sequence"]),
    );
    expect(BASE_061AF27_DOMUS_SQLITE).toEqual(expect.arrayContaining(["observations", "sqlite_sequence"]));
    expect(isBaseDomusTable("sqlite_autoindex_observations_1")).toBe(true);
    expect(isBaseDomusTable("sqlite_autoindex_facts_1")).toBe(false);
  });

  it("keeps user_version unchanged, on a first run and a rerun", async () => {
    makeRiver();
    expect(userVersion()).toBe(1);
    await runMemoryRollback({ dir });
    expect(userVersion()).toBe(1);
    await runMemoryRollback({ dir });
    expect(userVersion()).toBe(1);
  });
});

describe("memory-rollback: pending cascades and refusals", () => {
  it("with a pending-cascade record the script drains it first; if one cannot be drained the script exits non-zero and changes nothing", async () => {
    makeRiver();
    seedDerived();
    openGrants(dir).close();
    const raw = new DatabaseSync(riverPath());
    try {
      raw.prepare("INSERT INTO pending_cascade (store, seqs_json, at_ms) VALUES (?, ?, ?)").run(
        "probe_outside",
        JSON.stringify([1]),
        1_700_000_000_000,
      );
    } finally {
      raw.close();
    }

    const failing: OutsideCascade = {
      store: "probe_outside",
      run() {
        throw new Error("the outside store is not ready");
      },
    };
    await expect(runMemoryRollback({ dir, outsideCascades: [failing] })).rejects.toThrow(/not ready/);
    expect(rowCount("pending_cascade")).toBe(1);
    expect(rowCount("probe_derived")).toBe(1);
    expect(existsSync(grantsPath(dir))).toBe(true);

    const { handler, calls } = staticOutside();
    await runMemoryRollback({ dir, outsideCascades: [handler] });
    expect(calls).toEqual([[1]]);
    expect(rowCount("pending_cascade")).toBe(0);
    expect(rowCount("probe_derived")).toBe(0);
  });

  it("a river.db with the 061af27 schema, FTS (all five shadow tables), both ledger tables and ANALYZE run passes the table check; the same plus an extra table foo is refused and nothing changes", async () => {
    makeBaseRiver();
    await runMemoryRollback({ dir });
    expect(userVersion()).toBe(1);
    const names = tableNames();
    for (const shadow of ["river_fts_data", "river_fts_idx", "river_fts_docsize", "river_fts_config", "river_fts_content"]) {
      expect(names).toContain(shadow);
    }

    const raw = new DatabaseSync(riverPath());
    try {
      raw.exec("CREATE TABLE foo (x TEXT); INSERT INTO foo (x) VALUES ('keep me')");
    } finally {
      raw.close();
    }
    await expect(runMemoryRollback({ dir })).rejects.toThrow(/foo/);
    expect(tableNames()).toContain("foo");
    expect(rowCount("foo")).toBe(1);
    expect(userVersion()).toBe(1);
    expect(fileHas(riverPath(), "keep me")).toBe(true);
  });

  it("a reader held open during the checkpoint makes the script exit non-zero", async () => {
    makeRiver();
    seedDerived();
    const reader = new DatabaseSync(riverPath());
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM rows").all();
      await expect(runMemoryRollback({ dir })).rejects.toThrow(/checkpoint/);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    // The reader is gone: a rerun meets the end state.
    await runMemoryRollback({ dir });
    expect(rowCount("probe_derived")).toBe(0);
    expect(walSize()).toBe(0);
  });
});

describe("memory-rollback: reruns after a partial failure", () => {
  it("fail after the DELETE commits but before VACUUM; a rerun exits 0 and meets the end state of the first test", async () => {
    makeRiver();
    seedDerived();
    await expect(
      runMemoryRollback({
        dir,
        hooks: {
          afterDelete() {
            throw new Error("stopped after the delete");
          },
        },
      }),
    ).rejects.toThrow(/stopped after the delete/);
    expect(rowCount("probe_derived")).toBe(0);
    expect(userVersion()).toBe(1);

    await runMemoryRollback({ dir });
    expect(rowCount("probe_derived")).toBe(0);
    for (const name of ["river.db", "river.db-wal", "river.db-shm"]) {
      expect(fileHas(join(dir, name), PROBE_WORD), name).toBe(false);
    }
    expect(walSize()).toBe(0);
  });

  it("fail after grants.db is removed but before the key file; a rerun exits 0 and both are gone", async () => {
    makeRiver();
    openGrants(dir).close();
    expect(existsSync(grantsPath(dir))).toBe(true);
    expect(existsSync(threadHashKeyPath(dir))).toBe(true);

    await expect(
      runMemoryRollback({
        dir,
        hooks: {
          afterGrantsRemoved() {
            throw new Error("stopped after grants");
          },
        },
      }),
    ).rejects.toThrow(/stopped after grants/);
    expect(existsSync(grantsPath(dir))).toBe(false);
    expect(existsSync(threadHashKeyPath(dir))).toBe(true);

    await runMemoryRollback({ dir });
    expect(existsSync(grantsPath(dir))).toBe(false);
    expect(existsSync(threadHashKeyPath(dir))).toBe(false);
  });

  it("grants.db and its key file are gone after the script", async () => {
    makeRiver();
    openGrants(dir).close();
    await runMemoryRollback({ dir });
    expect(existsSync(grantsPath(dir))).toBe(false);
    expect(existsSync(threadHashKeyPath(dir))).toBe(false);
    // A file already gone is not an error, so a rerun succeeds.
    await expect(runMemoryRollback({ dir })).resolves.toBeDefined();
  });
});

describe("memory-rollback: copies made while the new code ran", () => {
  it("backups and replay copies made after deploy are listed", async () => {
    makeRiver();
    seedDerived();

    const backup = join(dir, "backups", "20261027-120000");
    mkdirSync(backup, { recursive: true });
    copyFileSync(riverPath(), join(backup, "river.db"));
    const replay = join(dir, "runs", "replay-1", "entity");
    mkdirSync(replay, { recursive: true });
    copyFileSync(riverPath(), join(replay, "river.db"));

    // The pre-deploy cold copy has no derived tables and is clean: it is not listed.
    const cold = join(dir, "cold");
    mkdirSync(cold, { recursive: true });
    const coldDb = new DatabaseSync(join(cold, "river.db"));
    try {
      coldDb.exec("CREATE TABLE rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)");
      coldDb.exec("INSERT INTO rows (text) VALUES ('cold copy')");
    } finally {
      coldDb.close();
    }

    const result = await runMemoryRollback({ dir });
    expect(result.scrub).toEqual(expect.arrayContaining([join(backup, "river.db"), join(replay, "river.db")]));
    expect(result.scrub).not.toContain(join(cold, "river.db"));
    expect(result.scrub.some((path) => path === riverPath())).toBe(false);
  });
});

describe("memory-rollback command", () => {
  it("prints what it did and lists copies for scrubbing, never a forgotten word", async () => {
    makeRiver();
    seedDerived();
    const backup = join(dir, "backups", "b1");
    mkdirSync(backup, { recursive: true });
    copyFileSync(riverPath(), join(backup, "river.db"));

    const out: string[] = [];
    const err: string[] = [];
    const code = await memoryRollbackCommand(["--dir", dir], (line) => out.push(line), (line) => err.push(line));

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain(join(backup, "river.db"));
    expect(out.join("\n")).not.toContain(PROBE_WORD);
  });

  it("exits 1 while the Lar lock is held, and 2 for bad flags", async () => {
    makeRiver();
    const lock = acquireLarLock(dir);
    try {
      const out: string[] = [];
      const err: string[] = [];
      expect(await memoryRollbackCommand(["--dir", dir], (line) => out.push(line), (line) => err.push(line))).toBe(1);
      expect(out).toEqual([]);
      expect(err.join("\n")).toMatch(/already in use/);
    } finally {
      lock.release();
    }

    const err: string[] = [];
    expect(await memoryRollbackCommand([], () => {}, (line) => err.push(line))).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis memory-rollback");
  });
});
