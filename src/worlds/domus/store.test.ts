import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARMED_MS, admitObservation, DOMUS_STATE_FILE, HeartbeatBook, markSpanUndone, newestObservation, openDomusDb, pruneObservations,
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
