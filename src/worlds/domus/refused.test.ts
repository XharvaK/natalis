import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import { openDomusDb } from "./store.js";
import { HIDE_AFTER_REFUSALS, HIDE_FOR_MS, withoutRefused } from "./refused.js";

const SESSION = "helperA:1";
const QUEUE: OptionObject = { object: "What you are doing", object_id: "queue:her", acts: [
  { ref: "a1", guid64: "201", text: "Cancel (queued): stand Passive" },
  { ref: "a2", guid64: "1", text: "Stop: sim stand" }] };
const BED: OptionObject = { object: "Bed", object_id: "77", acts: [{ ref: "a3", guid64: "500", text: "Sleep" }] };

let dir: string;
let db: DatabaseSync;
let n = 0;
const NOW = 1_800_000_000_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-refused-"));
  db = openDomusDb(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function act(attachment: string, objectId: string, guid64: string, code: string | undefined, state = "rejected", receivedMs = NOW): void {
  const id = `act${++n}`;
  db.prepare(`INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state,
    requested_at_ms, expires_at_ms, updated_at_ms, for_summoner) VALUES (?, 't', 'domus:slot8', ?, NULL, 'a1', ?, ?, 'x', ?, 1, 2, 3, 0)`)
    .run(id, attachment, objectId, guid64, state);
  if (code !== undefined) {
    db.prepare("INSERT INTO act_events (act_id, phase, at_ms, received_at_ms, detail_json) VALUES (?, 'rejected', ?, ?, ?)")
      .run(id, receivedMs, receivedMs, JSON.stringify({ code, by: "probe" }));
  }
}

describe("an act the game refused twice in this session is not offered again", () => {
  it("hides after the second refusal, not the first", () => {
    expect(HIDE_AFTER_REFUSALS).toBe(2);
    act(SESSION, "queue:her", "201", "NO_INTERACTION");
    expect(withoutRefused(db, SESSION, [QUEUE, BED], NOW)).toEqual([QUEUE, BED]);
    act(SESSION, "queue:her", "201", "NO_INTERACTION");
    expect(withoutRefused(db, SESSION, [QUEUE, BED], NOW)).toEqual([{ ...QUEUE, acts: [QUEUE.acts[1]] }, BED]);
  });

  it("drops an object left with no acts, and counts GAME_REFUSED too", () => {
    act(SESSION, "queue:her", "201", "NO_INTERACTION");
    act(SESSION, "queue:her", "201", "GAME_REFUSED");
    act(SESSION, "queue:her", "1", "GAME_REFUSED");
    act(SESSION, "queue:her", "1", "NO_INTERACTION");
    expect(withoutRefused(db, SESSION, [QUEUE, BED], NOW)).toEqual([BED]);
  });

  it("starts over in a new session", () => {
    act(SESSION, "queue:her", "201", "NO_INTERACTION");
    act(SESSION, "queue:her", "201", "NO_INTERACTION");
    expect(withoutRefused(db, "helperA:2", [QUEUE], NOW)).toEqual([QUEUE]);
    expect(withoutRefused(db, "helperB:1", [QUEUE], NOW)).toEqual([QUEUE]);
  });

  it("other refusals and other ends do not count", () => {
    act(SESSION, "77", "500", "BODY_BUSY");
    act(SESSION, "77", "500", "BODY_BUSY");
    act(SESSION, "77", "500", undefined, "finished");
    act(SESSION, "77", "500", undefined, "expired");
    expect(withoutRefused(db, SESSION, [BED], NOW)).toEqual([BED]);
  });
});

describe("the hide expires (S-D)", () => {
  it("lasts HIDE_FOR_MS (30 min) after the newest refusal, then the act is offered again", () => {
    expect(HIDE_FOR_MS).toBe(30 * 60_000);
    act(SESSION, "queue:her", "201", "NO_INTERACTION", "rejected", NOW - 40 * 60_000);
    act(SESSION, "queue:her", "201", "NO_INTERACTION", "rejected", NOW - 20 * 60_000);
    expect(withoutRefused(db, SESSION, [QUEUE], NOW)).toEqual([{ ...QUEUE, acts: [QUEUE.acts[1]] }]);
    expect(withoutRefused(db, SESSION, [QUEUE], NOW + 10 * 60_000 + 1)).toEqual([QUEUE]);
  });
});
