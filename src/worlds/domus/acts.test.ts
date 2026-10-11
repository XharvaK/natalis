import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOption, type OptionObject } from "./options.js";
import type { Found } from "./answers.js";
import {
  ACT_TTL_MS, expireDue, nextState, pendingCounts, PLAN_STEP_MAX_MS, requestAct, syncActs, type RequestResult, type SyncAct,
} from "./acts.js";
import { openDomusDb } from "./store.js";
import type { DomusActPhase, SyncEvent } from "./wire.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
const HELPER = "helper-1";

/** An invented view: a kettle and a bench, with a question about a note (a dialog, with rules). */
const VIEW: OptionObject[] = [
  { object: "Test kettle", object_id: "obj-kettle", where: "here, 2.0 m", acts: [
    { ref: "a1", guid64: "111", text: "Boil water" },
    { ref: "a2", guid64: "112", text: "Tidy up" },
  ] },
  { object: "Test bench", object_id: "obj-bench", acts: [
    { ref: "a3", guid64: "211", text: "Sit down" },
    { ref: "a4", guid64: "212", text: "Stand up" },
  ] },
];

let dir: string;
let db: DatabaseSync;
let turn: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-acts-"));
  db = openDomusDb(dir);
  turn = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function found(ref: string): Found {
  const hit = findOption(VIEW, ref);
  if (!hit) throw new Error(`fixture has no ${ref}`);
  return hit;
}

function ask(now: number, option: string, extra: { then?: string[]; forSummoner?: boolean; attachment?: string } = {}): RequestResult {
  turn += 1;
  return requestAct(db, {
    thread: THREAD,
    turnId: `turn-${turn}`,
    attachment: extra.attachment ?? HELPER,
    observationId: "helper-1.1",
    found: found(option),
    label: `${found(option).act.text} (${found(option).object.object})`,
    forSummoner: extra.forSummoner === true,
    then: (extra.then ?? []).map((ref) => ({ ref, found: found(ref) })),
    nowMs: now,
  });
}

function sync(now: number, events: SyncEvent[] = [], attachment = HELPER) {
  return syncActs(db, { attachment, events, nowMs: now });
}

function ev(actId: string, phase: DomusActPhase, atMs: number, detail?: Record<string, unknown>): SyncEvent {
  return { actId, phase, atMs, ...(detail ? { detail } : {}) };
}

function completed(actId: string, at: number): SyncEvent {
  return ev(actId, "finished", at, { finishing_type: "NATURAL", started: true });
}

function actFor(acts: SyncAct[], objectId: string): SyncAct | undefined {
  return acts.find((act) => act.object_id === objectId);
}

function okId(result: RequestResult): string {
  if (!result.ok) throw new Error("the request was refused");
  return result.actId;
}

describe("phase rules", () => {
  it("move forward only, and never overwrite a terminal phase", () => {
    expect(nextState("requested", "received", false)).toBe("received");
    expect(nextState("received", "requested" as DomusActPhase, false)).toBeNull();
    expect(nextState("pushed", "received", false)).toBeNull();
    expect(nextState("received", "pushed", false)).toBe("pushed");
    expect(nextState("finished", "accepted", false)).toBeNull();
    expect(nextState("unknown", "finished", false)).toBeNull();
    expect(nextState("unknown", "finished", true)).toBe("finished");
    expect(nextState("unknown", "received", true)).toBe("received");
  });
});

describe("requested acts", () => {
  it("are returned to their own helper, in the wire's shape, until that helper reports them", () => {
    const now = T0;
    const result = ask(now, "a1");
    const actId = okId(result);
    expect(result).toMatchObject({ ok: true, expiresAtMs: now + ACT_TTL_MS });
    const first = sync(now + 100);
    expect(first.acts).toEqual([{ act_id: actId, object_id: "obj-kettle", guid64: "111", expires_at_ms: now + ACT_TTL_MS }]);
    expect(sync(now + 100, [], "helper-2").acts).toEqual([]);
    const reported = sync(now + 200, [ev(actId, "received", now + 150)]);
    expect(reported.applied).toBe(1);
    expect(reported.acts).toEqual([]);
  });

  it("ignores a report about an act of another helper session", () => {
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 10, [ev(actId, "accepted", T0 + 5)], "helper-2");
    expect(result.applied).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("keeps every report once, moves phases forward, and keeps a late report with a note that says so", () => {
    const actId = okId(ask(T0, "a1"));
    const accepted = sync(T0 + 10, [ev(actId, "accepted", T0 + 10)]);
    expect(accepted.applied).toBe(1);
    expect(accepted.notes[0]).toMatchObject({ thread: THREAD, wake: false });
    expect(accepted.notes[0]?.text).toContain('Your act "Boil water (Test kettle)" (a1): the game accepted it.');
    // Once per act and phase: the same report again is not applied.
    expect(sync(T0 + 11, [ev(actId, "accepted", T0 + 10)]).applied).toBe(0);
    // Pushed, then a late received: kept, not moved back.
    sync(T0 + 12, [ev(actId, "pushed", T0 + 12)]);
    const late = sync(T0 + 13, [ev(actId, "received", T0 + 9)]);
    expect(late.applied).toBe(1);
    expect(late.notes[0]?.data).toMatchObject({ phase: "received", late: true });
    // Finished is terminal: a later accepted is kept but does not overwrite it.
    sync(T0 + 14, [completed(actId, T0 + 14)]);
    const after = sync(T0 + 15, [ev(actId, "rejected", T0 + 15, { code: "LATE" })]);
    expect(after.applied).toBe(1);
    expect(after.notes[0]).toMatchObject({ wake: true, data: { phase: "rejected", late: true } });
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(actId)).toEqual({ state: "finished" });
  });

  it("wakes the thread for rejected, unknown and expired, and not for the rest", () => {
    const actId = okId(ask(T0, "a1"));
    const rejected = sync(T0 + 1, [ev(actId, "rejected", T0 + 1, { code: "NOT_ATTACHED" })]).notes[0];
    expect(rejected).toMatchObject({ wake: true });
    expect(rejected?.text).toContain("the game refused it (NOT_ATTACHED)");
    const other = okId(ask(T0, "a2"));
    expect(sync(T0 + 1, [ev(other, "pushed", T0 + 1)]).notes[0]).toMatchObject({ wake: false });
  });

  it("wakes the thread for every way an act finishes, not only the refusals and expiries", () => {
    // A finished act that completed, one that opened the game's question, and one the game cut short: each wakes.
    const natural = okId(ask(T0, "a1"));
    const done = sync(T0 + 1, [completed(natural, T0 + 1)]).notes[0];
    expect(done).toMatchObject({ wake: true, data: { phase: "finished" } });
    expect(done?.text).toContain("it finished");

    const asked = okId(ask(T0, "a2"));
    const question = sync(T0 + 2, [ev(asked, "finished", T0 + 2, { finishing_type: "ASKED" })]).notes[0];
    expect(question).toMatchObject({ wake: true, data: { phase: "finished" } });
    expect(question?.text).toContain("it opened a question from the game");

    const cut = okId(ask(T0, "a3"));
    const cancelled = sync(T0 + 3, [ev(cut, "finished", T0 + 3, { finishing_type: "USER_CANCEL", started: true })]).notes[0];
    expect(cancelled).toMatchObject({ wake: true, data: { phase: "finished" } });
    expect(cancelled?.text).toContain("it was cut short");
  });

  it("expires an act its helper never picked up within 90 s, and the game never sees it", () => {
    const actId = okId(ask(T0, "a1"));
    const late = sync(T0 + ACT_TTL_MS + 1);
    expect(late.acts).toEqual([]);
    expect(late.notes).toEqual([
      expect.objectContaining({ wake: true, data: expect.objectContaining({ actId, phase: "expired" }) }),
    ]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(actId)).toEqual({ state: "expired" });
  });

  it("expires on the timer's pass too, so a detached game still wakes the Lar", () => {
    const actId = okId(ask(T0, "a1"));
    expect(expireDue(db, T0 + ACT_TTL_MS - 1)).toEqual([]);
    const notes = expireDue(db, T0 + ACT_TTL_MS);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ thread: THREAD, wake: true, data: { actId, phase: "expired" } });
    expect(expireDue(db, T0 + ACT_TTL_MS + 5)).toEqual([]);
  });

  it("marks an act for the summoner so the helper gets it first, and stores an answer for the helper", () => {
    ask(T0, "a1", { forSummoner: true });
    const acts = sync(T0 + 1).acts;
    expect(acts[0]).toMatchObject({ owner: true });
    const plain = ask(T0 + 2, "a3");
    expect(sync(T0 + 3).acts.find((act) => act.act_id === okId(plain))).not.toHaveProperty("owner");
  });

  it("refuses a second choice in the same turn, and says so", () => {
    turn += 1;
    const first = requestAct(db, { thread: THREAD, turnId: "same", attachment: HELPER, observationId: "x", found: found("a1"), label: "x", forSummoner: false, then: [], nowMs: T0 });
    expect(first.ok).toBe(true);
    const second = requestAct(db, { thread: THREAD, turnId: "same", attachment: HELPER, observationId: "x", found: found("a2"), label: "y", forSummoner: false, then: [], nowMs: T0 });
    expect(second).toEqual({ ok: false, code: "one_act_per_turn" });
  });

  it("counts what is requested and what is planned for the now board", () => {
    ask(T0, "a1", { then: ["a3"] });
    expect(pendingCounts(db, T0)).toEqual({ requested: 1, planned: 1 });
    expect(pendingCounts(db, T0 + ACT_TTL_MS)).toEqual({ requested: 0, planned: 1 });
  });
});

describe("plans", () => {
  it("runs a plan of three: each step is requested only when the one before completed", () => {
    const first = okId(ask(T0, "a1", { then: ["a3", "a4"], forSummoner: true }));
    const start = sync(T0 + 1);
    expect(start.acts.map((act) => act.object_id)).toEqual(["obj-kettle"]);
    expect(start.planned).toBe(2);
    sync(T0 + 2, [ev(first, "accepted", T0 + 2), completed(first, T0 + 3)]);
    const second = sync(T0 + 4);
    expect(second.acts.map((act) => act.object_id)).toEqual(["obj-bench"]);
    expect(actFor(second.acts, "obj-bench")).toMatchObject({ owner: true, guid64: "211" });
    expect(second.planned).toBe(1);
    sync(T0 + 5, [completed(second.acts[0]!.act_id, T0 + 6)]);
    const third = sync(T0 + 7);
    expect(third.acts.map((act) => act.guid64)).toEqual(["212"]);
    expect(third.planned).toBe(0);
    sync(T0 + 8, [completed(third.acts[0]!.act_id, T0 + 9)]);
    expect(sync(T0 + 10).acts).toEqual([]);
  });

  it("drops the rest of a plan when the game cuts the first act short, and says why", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    const reported = sync(T0 + 1, [ev(first, "finished", T0 + 2, { finishing_type: "USER_CANCEL", started: true })]);
    expect(reported.notes).toContainEqual(expect.objectContaining({
      wake: false,
      text: expect.stringContaining('Your plan stopped before "Sit down (Test bench)": the act before it was cut short'),
    }));
    const result = sync(T0 + 3);
    expect(result.acts).toEqual([]);
    expect(result.planned).toBe(0);
  });

  it("drops the plan on a refusal, and a rejected step is not requested", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    const refused = sync(T0 + 1, [ev(first, "rejected", T0 + 1, { code: "PROBE_TOO_OLD" })]);
    expect(refused.notes.map((note) => note.wake)).toEqual([true, false]);
    expect(refused.notes[1]?.text).toContain("the game refused the act before it");
    expect(sync(T0 + 2).acts).toEqual([]);
  });

  it("waits through a guessed unknown until the game's own verdict comes, then goes on", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "pushed", T0 + 1)]);
    sync(T0 + 2, [ev(first, "unknown", T0 + 2, { code: "GAME_DETACHED" })]);
    const waiting = sync(T0 + 3);
    expect(waiting.acts).toEqual([]);
    expect(waiting.planned).toBe(1);
    sync(T0 + 4, [completed(first, T0 + 4)]);
    expect(sync(T0 + 5).acts.map((act) => act.object_id)).toEqual(["obj-bench"]);
  });

  it("says a LEFT_QUEUE act ran at once: it never waited in her queue, and nothing says how it ended", () => {
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 1, [ev(actId, "unknown", T0 + 1, { code: "LEFT_QUEUE" })]);
    expect(result.notes[0]).toMatchObject({ thread: THREAD, wake: true });
    expect(result.notes[0]?.text).toBe('Your act "Boil water (Test kettle)" (a1): It never waited in her queue: the game took it at once or dropped it, and did not say how it ended. A phone act often runs this way; what changed in your next view tells.');
  });

  it("keeps the wording, with the code and the reason, for any other unknown", () => {
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 1, [ev(actId, "unknown", T0 + 1, { code: "SOMETHING_ELSE", reason: "the game gave no answer" })]);
    expect(result.notes[0]?.text).toBe('Your act "Boil water (Test kettle)" (a1): nothing says how it ended (SOMETHING_ELSE) - the game gave no answer.');
  });

  it("keeps an unknown the game did not guess as final, and ends the plan", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "unknown", T0 + 1, { code: "SOMETHING_ELSE" })]);
    expect(sync(T0 + 2).acts).toEqual([]);
    expect(sync(T0 + 2).planned).toBe(0);
  });

  it("lets a plan go whole when its next step would only be released after five minutes, and says so", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    const late = sync(T0 + PLAN_STEP_MAX_MS + 1, [completed(first, T0 + PLAN_STEP_MAX_MS + 1)]);
    expect(late.acts).toEqual([]);
    expect(late.planned).toBe(0);
    expect(late.notes).toContainEqual(expect.objectContaining({ text: expect.stringContaining("it was more than five minutes old") }));
  });

  it("lets a new choice replace what a plan still waited to do, silently; the earlier act stays requested", () => {
    const earlier = okId(ask(T0, "a1", { then: ["a3", "a4"] }));
    const replacement = okId(ask(T0 + 1, "a2"));
    const result = sync(T0 + 2);
    expect(result.planned).toBe(0);
    expect(result.acts.map((act) => act.act_id)).toEqual([earlier, replacement]);
    expect(result.notes.filter((note) => note.text.includes("plan"))).toEqual([]);
  });

  it("drops a plan when its session ends, and marks an act still in flight from that session unknown", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "pushed", T0 + 1)]);
    const other = sync(T0 + 2, [], "helper-2");
    expect(other.acts).toEqual([]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(first)).toEqual({ state: "unknown" });
    expect(db.prepare("SELECT detail_json FROM act_events WHERE act_id = ? AND phase = 'unknown'").get(first))
      .toEqual({ detail_json: JSON.stringify({ code: "SESSION_ENDED" }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM plan_steps WHERE state = 'planned'").get()).toEqual({ n: 0 });
  });

  it("counts an act that opened the game's question as done, so the next step goes on", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "finished", T0 + 1, { finishing_type: "ASKED" })]);
    expect(sync(T0 + 2).acts.map((act) => act.object_id)).toEqual(["obj-bench"]);
  });

  it("treats a finished act with no ending as cut short, and ends the plan", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "finished", T0 + 1)]);
    expect(sync(T0 + 2).acts).toEqual([]);
    expect(sync(T0 + 2).planned).toBe(0);
  });
});

describe("the answer the helper gets", () => {
  it("passes a stored answer back in the sync, with the game's row ids and counts", () => {
    const answer = JSON.stringify({ rows: [{ option_id: "555", count: 2 }], text: { title: "Ilse" } });
    const result = requestAct(db, {
      thread: THREAD, turnId: "answer-turn", attachment: HELPER, observationId: "helper-1.1", found: found("a1"),
      label: "answered Test question", forSummoner: false, answer: { json: answer }, then: [], nowMs: T0,
    });
    const id = okId(result);
    expect(sync(T0 + 1).acts).toEqual([expect.objectContaining({ act_id: id, answer: { rows: [{ option_id: "555", count: 2 }], text: { title: "Ilse" } } })]);
  });
});
