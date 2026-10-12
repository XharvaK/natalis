import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOption, type OptionObject } from "./options.js";
import type { Found } from "./answers.js";
import {
  ACT_TTL_MS, actRequestedMeanwhile, CODE_WORDS, expireDue, nextState, pendingCounts, PLAN_STEP_MAX_MS, requestAct, syncActs, type RequestResult, type SyncAct, wordsOfCode,
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
    const rejected = sync(T0 + 1, [ev(actId, "rejected", T0 + 1, { code: "NOT_ATTACHED", by: "game" })]).notes[0];
    expect(rejected).toMatchObject({ wake: true });
    expect(rejected?.text).toContain("the game refused it: the link to the game is not connected to the game");
    expect(rejected?.text).not.toContain("NOT_ATTACHED");
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

  it("keeps game acts in one turn one after another: a second and a third are accepted (Q-3)", () => {
    turn += 1;
    const request = (option: string) => requestAct(db, { thread: THREAD, turnId: "same", attachment: HELPER, observationId: "x", found: found(option), label: option, forSummoner: false, then: [], nowMs: T0 });
    expect(request("a1").ok).toBe(true);
    expect(request("a2").ok).toBe(true);
    expect(request("a3").ok).toBe(true);
  });

  it("refuses a game act after travel, a save or a planned event in the same turn, and says the slot is held (Q-3)", () => {
    const slot = (verb: string, turnId: string) => {
      db.prepare("INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state, requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json, words, verb, args_json) VALUES (?, ?, ?, ?, NULL, '', '0', '', 'slot', 'requested', ?, ?, ?, 0, NULL, NULL, ?, NULL)")
        .run(`slot-${verb}-${turnId}`, turnId, THREAD, HELPER, T0, T0 + 60_000, T0, verb);
    };
    for (const verb of ["go", "save", "event"]) {
      slot(verb, `after-${verb}`);
      expect(requestAct(db, { thread: THREAD, turnId: `after-${verb}`, attachment: HELPER, observationId: "x", found: found("a1"), label: "x", forSummoner: false, then: [], nowMs: T0 })).toEqual({ ok: false, code: "turn_slot_held" });
    }
  });

  it("counts what is requested and what is planned for the now board", () => {
    ask(T0, "a1", { then: ["a3"] });
    expect(pendingCounts(db, T0)).toEqual({ requested: 1, planned: 1 });
    expect(pendingCounts(db, T0 + ACT_TTL_MS)).toEqual({ requested: 0, planned: 1 });
  });
});

describe("plans", () => {
  it("holds a plan of six at most: the first act and five more (Q-4)", () => {
    ask(T0, "a1", { then: ["a2", "a3", "a4", "a1", "a2", "a3"] });
    expect(sync(T0 + 1).planned).toBe(5);
  });

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
    expect(result.notes[0]?.text).toBe('Your act "Boil water (Test kettle)" (a1): the game took it out of its queue and did not say how it ended; what changed in your next view tells what it did.');
  });

  it("keeps the wording, with the code and the reason, for any other unknown", () => {
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 1, [ev(actId, "unknown", T0 + 1, { code: "SOMETHING_ELSE", reason: "the game gave no answer" })]);
    expect(result.notes[0]?.text).toBe('Your act "Boil water (Test kettle)" (a1): nothing says how it ended: the game gave no answer.');
  });

  it("keeps an unknown the game did not guess as final, and ends the plan", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "unknown", T0 + 1, { code: "SOMETHING_ELSE" })]);
    expect(sync(T0 + 2).acts).toEqual([]);
    expect(sync(T0 + 2).planned).toBe(0);
  });

  it("ages a plan's next step from the end of the act before it, so a long first act does not let the rest go (B7)", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    const late = sync(T0 + PLAN_STEP_MAX_MS + 1, [completed(first, T0 + PLAN_STEP_MAX_MS + 1)]);
    expect(late.acts.map((act) => act.guid64)).toEqual(["211"]);
    expect(late.planned).toBe(0);
    expect(late.notes.some((note) => note.text.includes("it was more than five minutes old"))).toBe(false);
  });

  it("lets a plan go whole when the act before its next step has been unresolved for more than five minutes", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "unknown", T0 + 1, { code: "NO_PROBE_REPLY" })]);
    const late = sync(T0 + 1 + PLAN_STEP_MAX_MS + 1);
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

describe("W12: her words, the game's refusals, windows, pulls and a session's end", () => {
  /** A question with a text field and an ok button, for answers (a dialog the game holds open). */
  const QUESTION: Found = {
    object: {
      object: "The game asks: a test question", object_id: "dialog:q1",
      acts: [{ ref: "a9", guid64: "ok", text: "OK" }],
      answer_rules: { text: [{ name: "title", label: "Title", min_length: 1, max_length: 10, numeric: false, min_value: null, max_value: null, profanity_checked: false }] },
    },
    act: { ref: "a9", guid64: "ok", text: "OK" },
  };

  function requestWith(now: number, option: string, extra: { words?: string; turnId?: string; answer?: { json: string }; found?: Found } = {}): RequestResult {
    turn += 1;
    const hit = extra.found ?? found(option);
    return requestAct(db, {
      thread: THREAD, turnId: extra.turnId ?? `turn-${turn}`, attachment: HELPER, observationId: "helper-1.1", found: hit,
      label: `${hit.act.text} (${hit.object.object})`, forSummoner: false, then: [], nowMs: now,
      ...(extra.words !== undefined ? { words: extra.words } : {}),
      ...(extra.answer !== undefined ? { answer: extra.answer } : {}),
    });
  }

  it("keeps her words with the act, hands them to the helper, and shows them on the act's line (S1)", () => {
    const id = okId(requestWith(T0, "a3", { words: "Good morning" }));
    const pulled = sync(T0 + 1).acts.find((act) => act.act_id === id);
    expect(pulled?.words).toBe("Good morning");
    const done = sync(T0 + 2, [completed(id, T0 + 2)]).notes[0];
    expect(done?.text).toBe('Your act "Sit down (Test bench)" (a3): it finished. You said: "Good morning".');
  });

  it("gives no words to an act that had none", () => {
    const id = okId(requestWith(T0, "a3"));
    expect(sync(T0 + 1).acts.find((act) => act.act_id === id)).not.toHaveProperty("words");
  });

  it("says the codes the game and the probe added for travel, events, saves and sales in plain words, and never the code", () => {
    const cases: Array<[string, string]> = [
      ["TRAVEL_PENDING", "a trip is already under way"],
      ["IN_RABBIT_HOLE", "you are busy somewhere the game does not show"],
      ["NOT_AN_EVENT", "that is not an event the game has listed for you"],
      ["IN_INVENTORY", "that thing is in your inventory, so it cannot be moved."],
      ["SAVE_BUSY", "the game is already saving"],
    ];
    for (const [code, words] of cases) {
      const id = okId(requestWith(T0, "a1"));
      const note = sync(T0 + 1, [ev(id, "rejected", T0 + 1, { code, by: "probe" })]).notes[0];
      expect(note?.text).toContain(`the game's side refused it: ${words}`);
      expect(note?.text).not.toContain(code);
    }
    const id = okId(requestWith(T0, "a1"));
    const unconfirmed = sync(T0 + 1, [ev(id, "unknown", T0 + 1, { code: "SELL_UNCONFIRMED" })]).notes[0];
    expect(unconfirmed?.text).toContain("the thing was still there 30 seconds after the sale, so you were not paid");
    expect(unconfirmed?.text).not.toContain("SELL_UNCONFIRMED");
  });

  it("says the probe's reason for a left-out act in words, and never a detail word she cannot read", () => {
    const left = okId(requestWith(T0, "a1"));
    const excluded = sync(T0 + 1, [ev(left, "rejected", T0 + 1, { code: "EXCLUDED", by: "probe", detail: "deny_name" })]).notes[0]?.text ?? "";
    expect(excluded).toContain("that act is left out of your choices: a debug, cheat or test act");
    expect(excluded).not.toContain("deny_name");
    const clock = okId(requestWith(T0, "a1"));
    const created = sync(T0 + 1, [ev(clock, "rejected", T0 + 1, { code: "CREATE_FAILED", by: "probe", detail: "clock" })]).notes[0]?.text ?? "";
    expect(created).toContain("the game would not make the event: the game's clock could not be read");
    expect(created).not.toContain("CREATE_FAILED");
    const odd = okId(requestWith(T0, "a1"));
    const unknown = sync(T0 + 1, [ev(odd, "rejected", T0 + 1, { code: "NOT_A_REAL_CODE", by: "probe", detail: "step 9 of the picker" })]).notes[0]?.text ?? "";
    expect(unknown).toBe('Your act "Boil water (Test kettle)" (a1): the game\'s side refused it.');
  });

  it("words the refusal by who refused it, with the game's own sentence or the code's words, and no code", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ code: "NOT_ATTACHED", by: "game", text: "The game would not let her sit." }, "the game refused it: The game would not let her sit."],
      [{ code: "VARIANT_GONE", by: "probe" }, "the game's side refused it: that choice is no longer in the game's menu"],
      [{ code: "BAD_ARGS", by: "helper", text: "helper text" }, "the link to the game refused it: helper text"],
      [{ code: "STOP", by: "host" }, "the host refused it"],
      [{ code: "UNSAID" }, "it was refused"],
      [{ code: "SIM_NOT_CHOOSABLE", by: "probe", detail: "step 2 of the picker" }, "the game's side refused it: the game would not let that Sim be chosen for that act"],
    ];
    for (const [detail, words] of cases) {
      const id = okId(requestWith(T0, "a1"));
      const note = sync(T0 + 1, [ev(id, "rejected", T0 + 1, detail)]).notes[0];
      expect(note?.text).toContain(words);
      expect(note?.wake).toBe(true);
    }
    const long = okId(requestWith(T0, "a1"));
    const text = sync(T0 + 1, [ev(long, "rejected", T0 + 1, { code: "X", by: "game", text: "z".repeat(400) })]).notes[0]?.text ?? "";
    expect(text.endsWith(`: ${"z".repeat(240)}.`)).toBe(true);
  });

  it("holds a waiting act (not final) until the window closes, then finishes it, and says what the window is", () => {
    const id = okId(requestWith(T0, "a1"));
    sync(T0 + 1, [ev(id, "pushed", T0 + 1)]);
    const waiting = sync(T0 + 2, [ev(id, "waiting", T0 + 2, { code: "WINDOW_OPEN", window: "dialog 42" })]).notes[0];
    expect(waiting).toMatchObject({ wake: false });
    expect(waiting?.text).toBe('Your act "Boil water (Test kettle)" (a1): a window is open on the game (dialog 42), so the game keeps it out of your queue until the window closes.');
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "waiting" });
    const done = sync(T0 + 3, [completed(id, T0 + 3)]).notes[0];
    expect(done).toMatchObject({ wake: true });
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "finished" });
  });

  it("keeps a plan's next step waiting while the act before it is waiting, not dropping it", () => {
    const first = okId(ask(T0, "a1", { then: ["a3"] }));
    sync(T0 + 1, [ev(first, "waiting", T0 + 1, { code: "WINDOW_OPEN" })]);
    expect(sync(T0 + 2).planned).toBe(1);
    sync(T0 + 3, [completed(first, T0 + 3)]);
    expect(sync(T0 + 4).acts.map((act) => act.guid64)).toEqual(["211"]);
  });

  it("words a withheld screen as a noted, not final event, and the act can still be pushed and finish", () => {
    const id = okId(requestWith(T0, "a1"));
    const noted = sync(T0 + 1, [ev(id, "noted", T0 + 1, { code: "SCREEN_WITHHELD" })]).notes[0];
    expect(noted).toMatchObject({ wake: false });
    expect(noted?.text).toBe('Your act "Boil water (Test kettle)" (a1): the game opened a screen you cannot use, so it was cancelled.');
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "noted" });
    sync(T0 + 2, [ev(id, "pushed", T0 + 2)]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "pushed" });
    sync(T0 + 3, [completed(id, T0 + 3)]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "finished" });
  });

  it("says an answer sent while its question is still open is not yet answered", () => {
    const id = okId(requestWith(T0, "a1"));
    const note = sync(T0 + 1, [ev(id, "finished", T0 + 1, { code: "ANSWER_SENT_OPEN", finishing_type: "ANSWERED", started: true })]).notes[0];
    expect(note?.text).toBe('Your act "Boil water (Test kettle)" (a1): your answer was sent, but the game\'s question is still open.');
  });

  it("takes a late report for an act that a session's end made unknown, so it finishes (B5)", () => {
    const id = okId(requestWith(T0, "a1"));
    sync(T0 + 1, [ev(id, "pushed", T0 + 1)]);
    sync(T0 + 2, [], "helper-2");
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "unknown" });
    const late = sync(T0 + 3, [completed(id, T0 + 3)], "helper-2").notes;
    expect(late).toContainEqual(expect.objectContaining({ text: expect.stringContaining("it finished") }));
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "finished" });
  });

  it("keeps a final unknown final: the game took the act, then said it lost it, and a later finish does not undo that (B6)", () => {
    const id = okId(requestWith(T0, "a1"));
    sync(T0 + 1, [ev(id, "pushed", T0 + 1), ev(id, "unknown", T0 + 2, { code: "LEFT_QUEUE" })]);
    sync(T0 + 3, [completed(id, T0 + 3)]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "unknown" });
  });

  it("settles an unknown written before the game ever pushed the act (B6), so a later finish counts", () => {
    const id = okId(requestWith(T0, "a1"));
    sync(T0 + 1, [ev(id, "unknown", T0 + 1, { code: "TIMED_OUT" })]);
    sync(T0 + 2, [completed(id, T0 + 2)]);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "finished" });
  });

  it("does not expire an act the helper has pulled before its report: its time runs from the pull (B8)", () => {
    const id = okId(requestWith(T0, "a3"));
    expect(sync(T0 + 1).acts.map((act) => act.act_id)).toEqual([id]);
    const still = sync(T0 + ACT_TTL_MS).notes;
    expect(still.some((note) => note.text.includes("expired"))).toBe(false);
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "requested" });
    const received = sync(T0 + ACT_TTL_MS + 500, [ev(id, "received", T0 + ACT_TTL_MS + 500)]).notes[0];
    expect(received?.text).not.toContain("came after");
  });

  it("still expires an act nobody pulled at its time", () => {
    const id = okId(requestWith(T0, "a3"));
    const notes = sync(T0 + ACT_TTL_MS).notes;
    expect(notes).toContainEqual(expect.objectContaining({ text: expect.stringContaining("it expired before the game picked it up") }));
    expect(db.prepare("SELECT state FROM acts WHERE act_id = ?").get(id)).toEqual({ state: "expired" });
  });

  it("holds another thread for a live request only: a refused request holds nobody (B11)", () => {
    const refusedId = okId(requestWith(T0, "a1"));
    sync(T0 + 1, [ev(refusedId, "rejected", T0 + 1, { by: "game" })]);
    expect(actRequestedMeanwhile(db, { thread: "domus:other", nowMs: T0 + 2 })).toBeUndefined();
    okId(requestWith(T0 + 3, "a2"));
    expect(actRequestedMeanwhile(db, { thread: "domus:other", nowMs: T0 + 4 })).toMatchObject({ thread: THREAD, label: expect.stringContaining("Tidy up") });
    expect(actRequestedMeanwhile(db, { thread: THREAD, nowMs: T0 + 4 })).toBeUndefined();
  });

  it("lets an answer through, one answer per question per turn, and game acts after it (Q-3)", () => {
    const answer = { json: '{"rows":[]}' };
    const turnId = "turn-answers";
    expect(requestWith(T0, "a9", { turnId, found: QUESTION, answer }).ok).toBe(true);
    expect(requestWith(T0 + 1, "a9", { turnId, found: QUESTION, answer })).toEqual({ ok: false, code: "answer_repeated" });
    expect(requestWith(T0 + 2, "a1", { turnId }).ok).toBe(true);
    expect(requestWith(T0 + 3, "a2", { turnId }).ok).toBe(true);
  });
});

describe("plain words for every code the game's side and the helper send (NATALIS2-2, 4, 11; SEAM2-6; T4)", () => {
  /** Every code the probe and the helper send with an act, grepped from their sources (refused, unknown, finished, noted). */
  const SENT_CODES = [
    "NOT_SAMPLING", "E2_UNAVAILABLE", "BODY_UNAVAILABLE", "BODY_MISMATCH", "NO_OBJECT", "NOT_OFFERED", "OBJECT_EXCLUDED",
    "EXCLUDED", "NOT_USER_DIRECTED", "SIM_NEEDED", "SIM_NOT_CHOOSABLE", "NOT_A_SIM_ACT", "VARIANT_GONE", "BAD_VARIANT",
    "FIRE_REFUSED", "BUILD_MODE_REFUSED", "GAME_REFUSED", "PUSH_REFUSED", "PUSH_FAILED", "NO_DIALOG", "NOT_HELD", "NOT_HERS",
    "SHOWN_TO_USER", "IDENTITY_USER", "TEXT_NOT_HELD", "TEXT_INVALID", "NO_LIMIT", "NO_ROW", "ROW_DISABLED", "ROW_COUNT",
    "COUNT_INVALID", "NO_RESPONSE", "NO_PLAYER_SLOT", "SAVE_FAILED", "SAVE_LOCKED", "SAVE_BUSY", "SAVE_TOO_SOON",
    "TRAVEL_PENDING", "IN_RABBIT_HOLE", "SAME_ZONE", "NO_ZONE", "NOT_AN_EVENT", "NO_FUNDS", "CREATE_FAILED", "START_PAST",
    "NOT_HOME", "BUILD_MODE", "NOT_PURCHASABLE", "PRICE_ABOVE", "NO_SPOT", "NOT_FREE", "PLACE_FAILED", "NOT_IN_INVENTORY",
    "IN_INVENTORY", "MOVE_FAILED", "IN_USE", "NOT_MOVABLE", "NOT_SELLABLE", "SELL_FAILED", "SELL_PENDING", "SPOT_FAILED",
    "NOT_ATTACHED", "ARGS_INVALID", "ANSWER_INVALID", "UNKNOWN_ROOM", "PROBE_TOO_OLD", "REFUSED",
    "CHARGE_UNKNOWN", "REMOVE_UNCONFIRMED", "SELL_UNCONFIRMED", "SAVE_UNCONFIRMED", "ROW_INVALID", "LEFT_QUEUE",
    "SAMPLER_STOPPED", "TRAVEL_UNSEEN", "E2_EXCEPTION", "NO_PROBE_REPLY", "GAME_DETACHED", "NO_END_REPORTED", "SESSION_ENDED",
    "SAVED", "ARRIVED", "CREATED", "PLACED", "MOVED", "SOLD", "ANSWERED", "ANSWER_SENT_OPEN", "SCREEN_WITHHELD",
  ];

  it("has words for every code in the list, in second person and with no 'she' or 'her'", () => {
    for (const code of SENT_CODES) {
      const words = wordsOfCode(code);
      expect(words, code).toBeTruthy();
      expect(words, code).not.toMatch(/\b(she|her)\b/);
    }
  });

  it("gives the part before a colon's words to a code with a detail, and shows an unknown code as no words at all", () => {
    expect(wordsOfCode("E2_EXCEPTION:TypeError")).toBe(CODE_WORDS.E2_EXCEPTION);
    expect(wordsOfCode("NOT_A_REAL_CODE")).toBeUndefined();
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 1, [ev(actId, "rejected", T0 + 1, { code: "NOT_A_REAL_CODE", by: "probe" })]);
    expect(result.notes[0]?.text).toBe('Your act "Boil water (Test kettle)" (a1): the game\'s side refused it.');
  });

  it("says a buy whose money could not be read may be paid for, and that the thing was taken back out", () => {
    const actId = okId(ask(T0, "a1"));
    const result = sync(T0 + 1, [ev(actId, "unknown", T0 + 1, { code: "CHARGE_UNKNOWN" })]);
    expect(result.notes[0]?.text).toContain("it is not known whether you paid");
    expect(result.notes[0]?.text).not.toContain("CHARGE_UNKNOWN");
    expect(result.notes[0]?.text).toContain("taken back out");
  });

  it("gives a finished verb with no result the words of its code (the game saved), and keeps 'it finished' for a code it does not know", () => {
    const insert = db.prepare("INSERT INTO acts (act_id, turn_id, thread, attachment, observation_id, option_ref, object_id, guid64, label, state, requested_at_ms, expires_at_ms, updated_at_ms, for_summoner, answer_json, words, verb, args_json) VALUES (?, 't', ?, ?, NULL, '', '0', '', 'save the game', 'pushed', ?, ?, ?, 0, NULL, NULL, 'save', NULL)");
    insert.run("sv1", THREAD, HELPER, T0, T0 + 60_000, T0);
    insert.run("sv2", THREAD, HELPER, T0, T0 + 60_000, T0);
    const done = sync(T0 + 1, [ev("sv1", "finished", T0 + 1, { code: "SAVED" })]).notes[0];
    expect(done?.text).toBe('Your act "save the game": the game saved.');
    const other = sync(T0 + 3, [ev("sv2", "finished", T0 + 3, { code: "SOMETHING_NEW" })]).notes[0];
    expect(other?.text).toBe('Your act "save the game": it finished (SOMETHING_NEW).');
  });
});
