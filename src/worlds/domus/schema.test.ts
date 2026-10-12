import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type DatabaseSync as Db } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORGOTTEN_LINE } from "../../notebook/forget.js";
import { DOMUS_DB_FILE, DOMUS_FOLDER, DOMUS_SCHEMA_VERSION, forgetInDomusFile, openDomusDb, type Row } from "./store.js";

let dir: string;
let db: Db | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-schema-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A database as version 1 left it: the acts table without verb and args_json, and one act already in it. */
function writeVersionOne(): void {
  mkdirSync(join(dir, DOMUS_FOLDER), { recursive: true });
  const old = new DatabaseSync(join(dir, DOMUS_FOLDER, DOMUS_DB_FILE));
  old.exec(`
    CREATE TABLE acts (
      act_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, thread TEXT NOT NULL, attachment TEXT NOT NULL,
      observation_id TEXT, option_ref TEXT NOT NULL, object_id TEXT NOT NULL, guid64 TEXT NOT NULL,
      label TEXT NOT NULL, state TEXT NOT NULL, requested_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, for_summoner INTEGER NOT NULL, answer_json TEXT,
      words TEXT, pulled_at_ms INTEGER
    );
    INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state,
      requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json, words, pulled_at_ms)
      VALUES ('a1', 't1', 'domus:slot3', 'helper-1', NULL, 'a3', '77', '901', 'Boil water (Kettle)', 'finished', 1, 2, 3, 0, NULL, 'hello', NULL);
    PRAGMA user_version = 1;
  `);
  old.close();
}

describe("the Domus schema, version 2", () => {
  it("is version 2 in code", () => {
    expect(DOMUS_SCHEMA_VERSION).toBe(2);
  });

  it("migrates a version 1 database: adds the act columns and the new tables, keeps the rows", () => {
    writeVersionOne();
    db = openDomusDb(dir);
    expect(Number((db.prepare("PRAGMA user_version").get() as Row).user_version)).toBe(2);
    const columns = (db.prepare("PRAGMA table_info(acts)").all() as Row[]).map((column) => String(column.name));
    expect(columns).toEqual(expect.arrayContaining(["verb", "args_json", "words", "pulled_at_ms"]));
    const kept = db.prepare("SELECT label, words FROM acts WHERE act_id = 'a1'").get() as Row;
    expect(kept).toEqual({ label: "Boil water (Kettle)", words: "hello" });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining(["lists", "catalog_asks", "catalog_seen"]));
  });

  it("forgets words in a true version 1 store (no lists or catalogue tables yet) without an error, and migrates it", () => {
    // A version 1 store is the version 2 store without the four tables version 2 added, at version 1.
    openDomusDb(dir).close();
    const old = new DatabaseSync(join(dir, DOMUS_FOLDER, DOMUS_DB_FILE));
    old.exec("DROP TABLE lists; DROP TABLE catalog_asks; DROP TABLE catalog_seen; DROP TABLE list_marks; PRAGMA user_version = 1;");
    old.exec("INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state, requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json, words, pulled_at_ms) VALUES ('a1', 't1', 'domus:slot3', 'helper-1', NULL, 'a3', '77', '901', 'Boil water (Kettle)', 'finished', 1, 2, 3, 0, NULL, 'hello', NULL)");
    old.close();
    expect(forgetInDomusFile(dir, ["kettle"])).toBe(1);
    db = openDomusDb(dir);
    // The row matched the word, so its text is forgotten; the row itself is kept.
    expect((db.prepare("SELECT label, words FROM acts WHERE act_id = 'a1'").get() as Row)).toEqual({ label: FORGOTTEN_LINE, words: FORGOTTEN_LINE });
    expect(Number((db.prepare("PRAGMA user_version").get() as Row).user_version)).toBe(2);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining(["lists", "catalog_asks", "catalog_seen"]));
  });

  it("opens a version 2 database again without changes", () => {
    writeVersionOne();
    openDomusDb(dir).close();
    db = openDomusDb(dir);
    expect(Number((db.prepare("PRAGMA user_version").get() as Row).user_version)).toBe(2);
  });

  it("refuses a database from a later version", () => {
    mkdirSync(join(dir, DOMUS_FOLDER), { recursive: true });
    const later = new DatabaseSync(join(dir, DOMUS_FOLDER, DOMUS_DB_FILE));
    later.exec("PRAGMA user_version = 3");
    later.close();
    expect(() => openDomusDb(dir)).toThrow(/schema version 3/);
  });
});
