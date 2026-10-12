import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as DatabaseSyncCtor, type DatabaseSync } from "node:sqlite";
import { FORGOTTEN_LINE } from "../../notebook/forget.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARMED_MS, admitObservation, DOMUS_DB_FILE, DOMUS_STATE_FILE, forgetInDomusFile, forgetText, HeartbeatBook, markSpanUndone, newestObservation,
  openDomusDb, pruneObservations, type Row,
  type ObservationRow,
} from "./store.js";

const NOW = 1_800_000_000_000;
let dir: string;
let db: DatabaseSync | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-store-"));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function row(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    observationId: "helper-1.1",
    digest: "digest-a",
    thread: "domus:slot3",
    world: "slot3",
    branch: "branch-1",
    session: "telemetry-1",
    attachment: "helper-1",
    body: "sim-9",
    snapshot: "7",
    seq: 1,
    sourceTimeMs: NOW - 1000,
    expiresAtMs: NOW + 30_000,
    receiptTimeMs: NOW,
    lineageClass: "LIVE",
    payloadJson: JSON.stringify({ options: [] }),
    ...overrides,
  };
}

describe("observation admission", () => {
  it("admits a new id, answers the same id and digest as a duplicate with the first receipt time, and a new digest as a conflict", () => {
    db = openDomusDb(dir);
    expect(admitObservation(db, row())).toEqual({ status: "admitted", receiptTimeMs: NOW });
    expect(admitObservation(db, row({ receiptTimeMs: NOW + 500 }))).toEqual({ status: "duplicate", receiptTimeMs: NOW });
    expect(admitObservation(db, row({ digest: "digest-b", receiptTimeMs: NOW + 900 }))).toEqual({ status: "conflict" });
  });

  it("keeps dedup and the newest view across a restart", () => {
    db = openDomusDb(dir);
    admitObservation(db, row({ payloadJson: JSON.stringify({ options: [{ object: "Test kettle" }] }) }));
    db.close();
    db = openDomusDb(dir);
    expect(admitObservation(db, row({ receiptTimeMs: NOW + 1 }))).toEqual({ status: "duplicate", receiptTimeMs: NOW });
    expect(newestObservation(db, "domus:slot3")?.payload).toEqual({ options: [{ object: "Test kettle" }] });
  });

  it("reads the newest admitted view of a thread, and nothing from another thread", () => {
    db = openDomusDb(dir);
    admitObservation(db, row({ observationId: "h.1", payloadJson: JSON.stringify({ options: [] }) }));
    admitObservation(db, row({ observationId: "h.2", digest: "d2", payloadJson: JSON.stringify({ options: [{ object: "Second" }] }) }));
    admitObservation(db, row({ observationId: "h.3", digest: "d3", thread: "domus:slot4" }));
    expect(newestObservation(db, "domus:slot3")?.observationId).toBe("h.2");
    expect(newestObservation(db, "domus:nowhere")).toBeUndefined();
  });

  it("prunes only views whose window closed a day ago, and keeps the newest of each thread", () => {
    db = openDomusDb(dir);
    const old = NOW - 2 * 24 * 60 * 60 * 1000;
    admitObservation(db, row({ observationId: "old.1", digest: "o1", sourceTimeMs: old, expiresAtMs: old + 1000 }));
    admitObservation(db, row({ observationId: "old.2", digest: "o2", sourceTimeMs: old, expiresAtMs: old + 1000, thread: "domus:slot4" }));
    admitObservation(db, row({ observationId: "fresh.1", digest: "f1" }));
    expect(pruneObservations(db, NOW)).toBe(1);
    expect(admitObservation(db, row({ observationId: "old.2", digest: "o2", receiptTimeMs: NOW + 1, sourceTimeMs: old, expiresAtMs: old + 1000, thread: "domus:slot4" })))
      .toEqual({ status: "duplicate", receiptTimeMs: NOW });
    expect(newestObservation(db, "domus:slot4")?.observationId).toBe("old.2");
  });
});

describe("undo", () => {
  it("undoes the views of the span after the time, and only those; a second call undoes none", () => {
    db = openDomusDb(dir);
    const span = { thread: "domus:slot3", world: "slot3", branch: "branch-1", session: "telemetry-1", reason: "HELPER_UNDO" };
    admitObservation(db, row({ observationId: "u.1", digest: "u1", sourceTimeMs: NOW - 5000 }));
    admitObservation(db, row({ observationId: "u.2", digest: "u2", sourceTimeMs: NOW - 1000 }));
    admitObservation(db, row({ observationId: "u.3", digest: "u3", sourceTimeMs: NOW - 1000, session: "other" }));
    expect(markSpanUndone(db, { ...span, afterSourceTimeMs: NOW - 2000 }, NOW + 1)).toBe(1);
    // u.2 is no longer the newest view; the newest one left in the thread is u.3, from the other session.
    expect(newestObservation(db, "domus:slot3")?.observationId).toBe("u.3");
    expect(markSpanUndone(db, { ...span, afterSourceTimeMs: NOW - 2000 }, NOW + 2)).toBe(0);
  });
});

describe("heartbeat state", () => {
  it("is attached while the latest heartbeat says so and is recent, and persists across a restart", () => {
    const book = new HeartbeatBook(dir);
    expect(book.latest()).toBeUndefined();
    book.record("helper-1", { sentAtMs: NOW, attached: true, probeVersion: "2.30.0" }, NOW);
    expect(book.attachedAt(NOW + 1000)).toBe(true);
    expect(book.attachedAt(NOW + ARMED_MS + 1)).toBe(false);
    const again = new HeartbeatBook(dir);
    expect(again.attachedAt(NOW + 1000)).toBe(true);
    expect(again.latest()).toMatchObject({ session: "helper-1", attached: true, probeVersion: "2.30.0" });
  });

  it("keeps the probe version a session named when a later heartbeat does not name one (NATALIS2-6)", () => {
    const book = new HeartbeatBook(dir);
    book.record("helper-1", { sentAtMs: NOW, attached: true, probeVersion: "2.40.0" }, NOW);
    book.record("helper-1", { sentAtMs: NOW + 60_000, attached: true }, NOW + 60_000);
    expect(book.probeOf("helper-1")).toBe("2.40.0");
    expect(new HeartbeatBook(dir).probeOf("helper-1")).toBe("2.40.0");
    book.record("helper-1", { sentAtMs: NOW + 120_000, attached: true, probeVersion: "2.41.0" }, NOW + 120_000);
    expect(book.probeOf("helper-1")).toBe("2.41.0");
  });

  it("keeps the time the attached value last changed, so 'not attached since' is right", () => {
    const book = new HeartbeatBook(dir);
    book.record("helper-1", { sentAtMs: NOW, attached: true }, NOW);
    book.record("helper-1", { sentAtMs: NOW + 60_000, attached: false }, NOW + 60_000);
    book.record("helper-1", { sentAtMs: NOW + 120_000, attached: false }, NOW + 120_000);
    expect(book.latest()).toMatchObject({ attached: false, changedAtMs: NOW + 60_000 });
    expect(book.attachedAt(NOW + 120_000)).toBe(false);
  });

  it("refuses a damaged state file loudly rather than guessing", () => {
    mkdirSync(join(dir, "domus"), { recursive: true });
    writeFileSync(join(dir, "domus", DOMUS_STATE_FILE), "{ not json");
    expect(() => new HeartbeatBook(dir)).toThrow(/damaged/);
    writeFileSync(join(dir, "domus", DOMUS_STATE_FILE), JSON.stringify({ version: 2, sessions: {} }));
    expect(() => new HeartbeatBook(dir)).toThrow(/unknown version/);
  });
});

describe("forgetText: the game's own words", () => {
  const THREAD_NAME = "domus:slot3";

  /** Writes one row into each table that keeps game or Lar text, with an invented place name in each. */
  function seedGameText(database: DatabaseSync): void {
    admitObservation(database, row({ observationId: "helper-1.1", payloadJson: JSON.stringify({ options: [{ object: "Lantern Yard door", acts: [{ text: "Open it" }] }] }) }));
    admitObservation(database, row({ observationId: "helper-1.2", seq: 2, digest: "digest-b", payloadJson: JSON.stringify({ note: "The quay is quiet" }) }));
    const insertAct = database.prepare(`INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label,
      state, requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json) VALUES (?, 't', ?, 'helper-1', ?, 'a1', 'obj', '111', ?, 'finished', ?, ?, ?, 0, ?)`);
    insertAct.run("act-1", THREAD_NAME, "helper-1.1", "Walk to Lantern Yard", NOW, NOW + 90_000, NOW, JSON.stringify({ text: { name: "Lantern" } }));
    insertAct.run("act-2", THREAD_NAME, "helper-1.2", "Sit down", NOW, NOW + 90_000, NOW, null);
    database.prepare("INSERT INTO act_events (act_id, phase, at_ms, received_at_ms, detail_json) VALUES ('act-1', 'finished', ?, ?, ?)")
      .run(NOW, NOW, JSON.stringify({ reason: "the Lantern Yard gate is locked" }));
    database.prepare(`INSERT INTO plan_steps (plan_id, step, thread, attachment, option_ref, object_id, guid64, label, for_summoner, state,
      reason, act_id, planned_at_ms, updated_at_ms) VALUES ('act-2', 1, ?, 'helper-1', 'a2', 'obj', '112', 'Lantern Yard walk', 0, 'planned', NULL, NULL, ?, ?)`)
      .run(THREAD_NAME, NOW, NOW);
    database.prepare(`INSERT INTO undos (thread, world, branch, session, after_source_time_ms, reason, observations, undone_at_ms)
      VALUES (?, 'slot3', 'branch-1', 'telemetry-1', ?, 'Lantern Yard went away', 1, ?)`).run(THREAD_NAME, NOW, NOW);
  }

  it("erases the text of every row that holds all the words, in every table, and keeps the rows", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    expect(forgetText(db, ["LANTERN", "yard"])).toBe(5);

    const observations = db.prepare("SELECT observation_id, payload_json FROM observations ORDER BY seq").all() as Row[];
    expect(observations).toEqual([
      { observation_id: "helper-1.1", payload_json: "{}" },
      { observation_id: "helper-1.2", payload_json: JSON.stringify({ note: "The quay is quiet" }) },
    ]);
    const acts = db.prepare("SELECT act_id, label, answer_json FROM acts ORDER BY act_id").all() as Row[];
    expect(acts).toEqual([
      { act_id: "act-1", label: FORGOTTEN_LINE, answer_json: "{}" },
      { act_id: "act-2", label: "Sit down", answer_json: null },
    ]);
    expect(db.prepare("SELECT detail_json FROM act_events").get()).toEqual({ detail_json: "{}" });
    expect(db.prepare("SELECT label FROM plan_steps").get()).toEqual({ label: FORGOTTEN_LINE });
    expect(db.prepare("SELECT reason FROM undos").get()).toEqual({ reason: FORGOTTEN_LINE });
  });

  it("withdraws a requested act whose words it erased, with its waiting steps, and leaves the other waiting act", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    db.prepare("UPDATE acts SET state = 'requested'").run();
    db.prepare(`INSERT INTO plan_steps (plan_id, step, thread, attachment, option_ref, object_id, guid64, label, for_summoner, state,
      reason, act_id, planned_at_ms, updated_at_ms) VALUES ('act-1', 1, ?, 'helper-1', 'a3', 'obj', '113', 'Sit on the bench', 0, 'planned', NULL, NULL, ?, ?)`)
      .run(THREAD_NAME, NOW, NOW);
    forgetText(db, ["lantern", "yard"]);

    expect(db.prepare("SELECT act_id, state FROM acts ORDER BY act_id").all()).toEqual([
      { act_id: "act-1", state: "expired" },
      { act_id: "act-2", state: "requested" },
    ]);
    expect(db.prepare("SELECT detail_json FROM act_events WHERE act_id = 'act-1' AND phase = 'expired'").get())
      .toEqual({ detail_json: JSON.stringify({ code: "FORGOTTEN" }) });
    expect(db.prepare("SELECT plan_id, label, state, reason FROM plan_steps ORDER BY plan_id").all()).toEqual([
      { plan_id: "act-1", label: "Sit on the bench", state: "dropped", reason: "forgotten" },
      { plan_id: "act-2", label: FORGOTTEN_LINE, state: "dropped", reason: "forgotten" },
    ]);
  });

  it("counts a second forget of the same words as nothing, and forgets nothing for no words", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    expect(forgetText(db, [])).toBe(0);
    expect(forgetText(db, ["lantern", "yard"])).toBe(5);
    expect(forgetText(db, ["lantern", "yard"])).toBe(0);
    expect(forgetText(db, ["forgotten", "summoner"])).toBe(0);
  });

  it("keeps a row whose text lacks one of the words", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    expect(forgetText(db, ["quay", "lantern"])).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM observations WHERE payload_json = '{}'").get()).toEqual({ n: 0 });
  });

  it("leaves rows the rest of the code can still read: a forgotten newest view offers no choices", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    expect(forgetText(db, ["quay"])).toBe(1);
    expect(newestObservation(db, THREAD_NAME)).toMatchObject({ observationId: "helper-1.2", payload: {} });
  });

  it("does nothing, and creates no file, when the Lar has no game store", () => {
    expect(forgetInDomusFile(dir, ["lantern"])).toBe(0);
    expect(existsSync(join(dir, "domus", DOMUS_DB_FILE))).toBe(false);
  });

  it("forgets in the store file of a Lar that is not running", () => {
    db = openDomusDb(dir);
    seedGameText(db);
    db.close();
    db = undefined;
    expect(forgetInDomusFile(dir, ["lantern", "yard"])).toBe(5);
    expect(forgetInDomusFile(dir, ["lantern", "yard"])).toBe(0);
  });
});

describe("schema migration (version 1 adds acts.words and acts.pulled_at_ms; version 2 is checked in schema.test.ts)", () => {
  /** The acts table as version 0 wrote it, with one act in it, and no user_version set. */
  function writeVersionZeroStore(): void {
    // Every table as it is, then acts rebuilt with the version 0 columns (no words, no pulled_at_ms) and one act in it.
    db = openDomusDb(dir);
    db.exec(`ALTER TABLE acts RENAME TO acts_current;
      CREATE TABLE acts (
        act_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, thread TEXT NOT NULL, attachment TEXT NOT NULL, observation_id TEXT,
        option_ref TEXT NOT NULL, object_id TEXT NOT NULL, guid64 TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL,
        requested_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        for_summoner INTEGER NOT NULL, answer_json TEXT);
      INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state,
        requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json)
        VALUES ('act1', 'turn-1', 'domus:slot3', 'helper-1', NULL, 'a1', 'obj-1', '111', 'Boil water (Kettle)',
        'requested', ${NOW}, ${NOW + 90_000}, ${NOW}, 0, NULL);
      DROP TABLE acts_current;
      PRAGMA user_version = 0;`);
    db.close();
    db = undefined;
  }

  function columnsOf(handle: DatabaseSync): string[] {
    return (handle.prepare("PRAGMA table_info(acts)").all() as Row[]).map((column) => String(column.name));
  }

  it("adds the two columns to a store from before version 1, keeps its rows, and sets the version", () => {
    writeVersionZeroStore();
    db = openDomusDb(dir);
    expect(columnsOf(db)).toEqual(expect.arrayContaining(["words", "pulled_at_ms"]));
    const kept = db.prepare("SELECT label, words, pulled_at_ms FROM acts WHERE act_id = 'act1'").get() as Row;
    expect(kept).toEqual({ label: "Boil water (Kettle)", words: null, pulled_at_ms: null });
    expect((db.prepare("PRAGMA user_version").get() as Row).user_version).toBe(3);
  });

  it("changes nothing when the store is already at version 1 or later, and opening it again is safe", () => {
    db = openDomusDb(dir);
    db.close();
    db = openDomusDb(dir);
    expect(columnsOf(db).filter((name) => name === "words")).toHaveLength(1);
    expect((db.prepare("PRAGMA user_version").get() as Row).user_version).toBe(3);
  });

  it("forgets the words the Lar said in a store from before version 1, without opening it through the world", () => {
    writeVersionZeroStore();
    expect(forgetInDomusFile(dir, ["kettle"])).toBe(1);
    db = openDomusDb(dir);
    expect((db.prepare("SELECT label FROM acts WHERE act_id = 'act1'").get() as Row).label).toBe(FORGOTTEN_LINE);
  });

  it("refuses a store written by a later version, and does not touch it", () => {
    db = openDomusDb(dir);
    db.exec("PRAGMA user_version = 9");
    db.close();
    db = undefined;
    expect(() => openDomusDb(dir)).toThrow(/schema version 9/);
    const raw = new DatabaseSyncCtor(join(dir, "domus", DOMUS_DB_FILE));
    expect((raw.prepare("PRAGMA user_version").get() as Row).user_version).toBe(9);
    raw.close();
  });
});
