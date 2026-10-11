import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../contracts.js";
import { openDomusDb } from "./store.js";
import {
  checkSnapshot,
  expireSnapshots,
  gameSnapshotTool,
  openSnapshots,
  requestSnapshot,
  settleFailed,
  settleTaken,
  SNAPSHOT_PICTURE_MAX,
  SNAPSHOT_TTL_MS,
  withdrawSnapshots,
} from "./snapshot.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
const HELPER = "helper-1";
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString("base64");

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-snapshot-"));
  db = openDomusDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function askAt(nowMs: number, thread = THREAD) {
  return requestSnapshot(db, { thread, attachment: HELPER, nowMs });
}

describe("requests", () => {
  it("keeps one open request per game thread, and says when the open one was asked", () => {
    const first = askAt(T0);
    expect(first).toMatchObject({ ok: true, expiresAtMs: T0 + SNAPSHOT_TTL_MS });
    expect(askAt(T0 + 5_000)).toEqual({ ok: false, openSinceMs: T0 });
    expect(askAt(T0 + 5_000, "domus:slot4")).toMatchObject({ ok: true });
  });

  it("does not count a request past its time as open, even before the timed pass has expired it", () => {
    askAt(T0);
    expect(askAt(T0 + SNAPSHOT_TTL_MS - 1)).toEqual({ ok: false, openSinceMs: T0 });
    expect(askAt(T0 + SNAPSHOT_TTL_MS)).toMatchObject({ ok: true });
  });

  it("lists the open requests of one helper session, oldest first, and only within their time", () => {
    const first = askAt(T0) as { snapshotId: string };
    const second = askAt(T0 + 1_000, "domus:slot4") as { snapshotId: string };
    expect(openSnapshots(db, { helperSession: HELPER, nowMs: T0 + 2_000 })).toEqual([
      { snapshot_id: first.snapshotId },
      { snapshot_id: second.snapshotId },
    ]);
    expect(openSnapshots(db, { helperSession: "helper-2", nowMs: T0 + 2_000 })).toEqual([]);
    expect(openSnapshots(db, { helperSession: HELPER, nowMs: T0 + SNAPSHOT_TTL_MS + 500 })).toEqual([{ snapshot_id: second.snapshotId }]);
  });

  it("expires requests not taken in time, once, with a note that does not wake", () => {
    askAt(T0);
    expect(expireSnapshots(db, T0 + SNAPSHOT_TTL_MS - 1)).toEqual([]);
    const notes = expireSnapshots(db, T0 + SNAPSHOT_TTL_MS);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ thread: THREAD, wake: false, data: { status: "expired" } });
    expect(expireSnapshots(db, T0 + SNAPSHOT_TTL_MS + 1)).toEqual([]);
  });

  it("withdraws every waiting request when the stop goes on, once, with a note that does not wake", () => {
    askAt(T0);
    const notes = withdrawSnapshots(db, T0 + 1);
    expect(notes).toEqual([
      expect.objectContaining({ thread: THREAD, wake: false, text: "Your picture request was withdrawn: your summoner's emergency stop is on.", data: expect.objectContaining({ status: "withdrawn" }) }),
    ]);
    expect(withdrawSnapshots(db, T0 + 2)).toEqual([]);
    expect(openSnapshots(db, { helperSession: HELPER, nowMs: T0 + 2 })).toEqual([]);
  });
});

describe("the helper's answer", () => {
  it("refuses an unknown id, a request that is not open, and another session, with v1's codes", () => {
    const asked = askAt(T0) as { snapshotId: string };
    expect(checkSnapshot(db, { helperSession: HELPER, snapshotId: "nope", pngBase64: PNG_BASE64 })).toEqual({ ok: false, code: "unknown_snapshot" });
    expect(checkSnapshot(db, { helperSession: "helper-2", snapshotId: asked.snapshotId, pngBase64: PNG_BASE64 })).toEqual({ ok: false, code: "wrong_attachment" });
    expect(checkSnapshot(db, { helperSession: HELPER, snapshotId: asked.snapshotId, pngBase64: PNG_BASE64 })).toEqual({ ok: true, thread: THREAD, bytes: expect.any(Buffer) });
    settleTaken(db, { snapshotId: asked.snapshotId, thread: THREAD, pictureId: "m-ABCD2345", nowMs: T0 + 1 });
    expect(checkSnapshot(db, { helperSession: HELPER, snapshotId: asked.snapshotId, pngBase64: PNG_BASE64 })).toEqual({ ok: false, code: "not_requested" });
  });

  it("checks the picture: base64, size and the PNG signature", () => {
    const asked = askAt(T0) as { snapshotId: string };
    const check = (pngBase64: string) => checkSnapshot(db, { helperSession: HELPER, snapshotId: asked.snapshotId, pngBase64 });
    expect(check("AAAA")).toEqual({ ok: false, code: "not_png" });
    expect(check("AA!A")).toEqual({ ok: false, code: "invalid_body" });
    expect(check("AAA")).toEqual({ ok: false, code: "invalid_body" });
    expect(check("A".repeat(Math.ceil((SNAPSHOT_PICTURE_MAX * 4) / 3) + 4))).toEqual({ ok: false, code: "too_large" });
  });

  it("settles a failure and a taken picture as notes that wake the thread, with the words the Lar reads", () => {
    const failed = askAt(T0) as { snapshotId: string };
    expect(settleFailed(db, { snapshotId: failed.snapshotId, failed: "no_game_window", thread: THREAD, nowMs: T0 + 1 })).toEqual({
      thread: THREAD,
      text: "Your picture of the game could not be taken: no game window was found.",
      data: { snapshotId: failed.snapshotId, status: "failed", reason: "no_game_window" },
      wake: true,
    });
    const minimized = askAt(T0 + 4_000, "domus:slot5") as { snapshotId: string };
    expect(settleFailed(db, { snapshotId: minimized.snapshotId, failed: "minimized", thread: "domus:slot5", nowMs: T0 + 5 })).toEqual({
      thread: "domus:slot5",
      text: "No picture: the game is minimized on the summoner's screen, so it would show an old moment.",
      data: { snapshotId: minimized.snapshotId, status: "failed", reason: "minimized" },
      wake: true,
    });
    const notFront = askAt(T0 + 6_000, "domus:slot6") as { snapshotId: string };
    expect(settleFailed(db, { snapshotId: notFront.snapshotId, failed: "not_front", thread: "domus:slot6", nowMs: T0 + 7 })).toMatchObject({
      text: "No picture: the game is not the front window on the summoner's screen, so it would show an old moment.",
    });
    const taken = askAt(T0 + 2_000, "domus:slot4") as { snapshotId: string };
    expect(settleTaken(db, { snapshotId: taken.snapshotId, thread: "domus:slot4", pictureId: "m-ABCD2345", nowMs: T0 + 3 })).toMatchObject({
      text: "Your picture of the game is on your shelf as m-ABCD2345.",
      wake: true,
    });
  });
});

describe("the game_snapshot tool", () => {
  const context = (thread: string): ToolContext => ({ thread, turnId: "t", nowMs: T0, river: undefined as never, notebook: undefined as never });

  it("refuses while the world is not running, outside a game thread, and while the game is not attached", async () => {
    expect(await gameSnapshotTool(() => null).run({}, context(THREAD))).toMatchObject({ ok: false, refused: { code: "not_running" } });
    const game = { db, nowMs: () => T0, attachedSession: () => undefined };
    expect(await gameSnapshotTool(() => game).run({}, context(THREAD))).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect(await gameSnapshotTool(() => game).run({}, context("cli:summoner"))).toMatchObject({ ok: false, refused: { code: "not_a_game_thread" } });
  });

  it("asks for the attached session and says the request is only asked for, not taken", async () => {
    const game = { db, nowMs: () => T0, attachedSession: () => HELPER };
    const receipt = await gameSnapshotTool(() => game).run({}, context(THREAD));
    expect(receipt).toMatchObject({ ok: true, data: { expiresAtMs: T0 + SNAPSHOT_TTL_MS } });
    expect(receipt.summary).toContain("comes to your shelf");
    expect(openSnapshots(db, { helperSession: HELPER, nowMs: T0 })).toHaveLength(1);
  });
});
