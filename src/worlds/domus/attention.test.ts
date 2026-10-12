import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import {
  attentionLine, currentAttention, gameAttentionTool, LOOK_MAX, LOOK_MIN, reviewAttention, UNTIL_MAX_MS, wakesFor, workEnded,
} from "./attention.js";
import { admitObservation, lastLookHanded, lookOwed, openDomusDb, readAttention, takeLook, writeAttention, type AttentionRow } from "./store.js";
import type { Percept } from "./wire.js";

const T0 = Date.UTC(2026, 9, 12, 8, 0);
/** A zone with no place name in it: UTC plus three hours. */
const ZONE = "Etc/GMT-3";
const THREAD = "domus:slot3";

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-attention-"));
  db = openDomusDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function percept(kind: string, facts: Record<string, unknown> = {}): Percept {
  return { kind, salience: 0, facts };
}

const PLAIN = [percept("need", { subject: "hunger", band: "ok" })];
const NO_PORTRAIT = undefined;

function view(percepts: Percept[], overrides: { portrait?: unknown; dayRecord?: boolean; firstAfterAttach?: boolean } = {}) {
  return {
    percepts,
    portrait: overrides.portrait ?? NO_PORTRAIT,
    dayRecord: overrides.dayRecord ?? false,
    workEnded: false,
    firstAfterAttach: overrides.firstAfterAttach ?? false,
  };
}

const HELD = { asked: [{ title: "Pick a recipe", whose: "yours", held: true }] };
const NOT_HELD = { asked: [{ title: "Pick a recipe", whose: "the User's", held: false }] };

describe("the work watch is kept per game thread in domus.sqlite (NATALIS2-7, C6 F-3)", () => {
  const job = (atWork: boolean) => ({ self: { jobs: [{ title: "Test Clerk", at_work: atWork }] } });

  it("tells a work end apart from a shift that has not ended, once per game thread", () => {
    expect(workEnded(db, "thread-a", job(true))).toBe(false);
    expect(workEnded(db, "thread-a", job(true))).toBe(false);
    expect(workEnded(db, "thread-a", job(false))).toBe(true);
    expect(workEnded(db, "thread-a", job(false))).toBe(false);
    expect(workEnded(db, "thread-b", job(false))).toBe(false);
    // A view with no job read leaves the thread as it was.
    expect(workEnded(db, "thread-c", job(true))).toBe(false);
    expect(workEnded(db, "thread-c", undefined)).toBe(false);
    expect(workEnded(db, "thread-c", job(false))).toBe(true);
  });

  it("still gives the one work end after a restart: the at-work flag is in the store", () => {
    expect(workEnded(db, THREAD, job(true))).toBe(false);
    db.close();
    db = openDomusDb(dir);
    expect(workEnded(db, THREAD, job(false))).toBe(true);
    expect(workEnded(db, THREAD, job(false))).toBe(false);
  });
});

describe("the game_attention description says what each mode wakes for (NATALIS2-5)", () => {
  it("names what wakes her in every mode, and what each mode adds to it", () => {
    const text = gameAttentionTool(() => null).spec.description;
    expect(text).toContain("Always, in every mode: a question the game holds open for you, a call or a notice on your phone, and a look you asked for.");
    expect(text).toContain("Except in quiet, a need that goes into distress wakes you when you are not at work.");
    expect(text).toContain("When work ends with a need still in distress you wake once, in every mode.");
    expect(text).toContain("at work, a view whose only changes are needs in distress stays quiet");
    expect(text).toContain("when_called: otherwise a change wakes you only when something calls you");
    expect(text).toContain("quiet: otherwise nothing wakes you until until");
  });
});

describe("which views wake her, by her mode", () => {
  it("wakes her on every view in every change mode", () => {
    expect(wakesFor("every_change", view(PLAIN))).toBe(true);
    expect(wakesFor("every_change", view([percept("presence", { bucket: "left" })]))).toBe(true);
  });

  it("when called, a phone change that is neither a notice nor a call does not wake her (NATALIS2-12)", () => {
    expect(wakesFor("when_called", view([percept("phone", { what: "message" })]))).toBe(false);
    expect(wakesFor("when_called", view([percept("phone", { what: "notice" })]))).toBe(true);
  });

  it("when called, wakes her for a call and not for an ordinary change", () => {
    expect(wakesFor("when_called", view(PLAIN))).toBe(false);
    expect(wakesFor("when_called", view([percept("social", { bucket: "addressed" })]))).toBe(true);
    expect(wakesFor("when_called", view([percept("presence", { bucket: "arrived" })]))).toBe(true);
    expect(wakesFor("when_called", view([percept("presence", { bucket: "on_lot" })]))).toBe(true);
    expect(wakesFor("when_called", view([percept("presence", { bucket: "left" })]))).toBe(false);
    expect(wakesFor("when_called", view([percept("sleep_onset", {})]))).toBe(true);
    expect(wakesFor("when_called", view(PLAIN, { dayRecord: true }))).toBe(true);
    expect(wakesFor("when_called", view(PLAIN, { firstAfterAttach: true }))).toBe(true);
  });

  it("in every mode, a question put to her and a look she asked for always wake her", () => {
    for (const mode of ["every_change", "when_called", "quiet"] as const) {
      expect(wakesFor(mode, view([percept("env", { bucket: "asked" })]))).toBe(true);
      expect(wakesFor(mode, view([percept("look", { bucket: "asked" })]))).toBe(true);
      expect(wakesFor(mode, view(PLAIN, { portrait: HELD }))).toBe(true);
    }
  });

  it("a need that has just gone into distress wakes her in every mode but quiet, and a need that has not does not (D1, Q-1)", () => {
    const distress = percept("need", { subject: "social", band: "distress" });
    for (const mode of ["every_change", "when_called"] as const) {
      expect(wakesFor(mode, view([distress]))).toBe(true);
    }
    // Quiet means quiet: a need in distress does not wake her in quiet, and a question, a call or a look still does.
    expect(wakesFor("quiet", view([distress]))).toBe(false);
    expect(wakesFor("quiet", view([percept("phone", { what: "call", from: "Test Friend" })]))).toBe(true);
    expect(wakesFor("when_called", view([percept("need", { subject: "hunger", band: "low" })]))).toBe(false);
    expect(wakesFor("quiet", view([percept("need", { subject: "fun", band: "ok" })]))).toBe(false);
  });

  it("when quiet, nothing else wakes her, not even a call", () => {
    expect(wakesFor("quiet", view(PLAIN))).toBe(false);
    expect(wakesFor("quiet", view([percept("social", { bucket: "addressed" })]))).toBe(false);
    expect(wakesFor("quiet", view([percept("presence", { bucket: "arrived" })]))).toBe(false);
    expect(wakesFor("quiet", view(PLAIN, { dayRecord: true, firstAfterAttach: true }))).toBe(false);
    expect(wakesFor("quiet", view(PLAIN, { portrait: NOT_HELD }))).toBe(false);
  });
});

describe("the attention line the body block starts with", () => {
  const row = (overrides: Partial<AttentionRow>): AttentionRow => ({ ...readAttention(db, THREAD), ...overrides });

  it("says every change, when called, or quiet until the time, in the Lar's zone", () => {
    expect(attentionLine(row({}), T0, ZONE)).toBe("Your attention: every change.");
    expect(attentionLine(row({ mode: "when_called", resumeMode: "when_called" }), T0, ZONE))
      .toBe("Your attention: when something calls you.");
    expect(attentionLine(row({ mode: "quiet", resumeMode: "every_change", quietUntilMs: Date.UTC(2026, 9, 12, 11, 30) }), T0, ZONE))
      .toBe("Your attention: quiet until 14:30.");
  });

  it("adds the look when there is one", () => {
    expect(attentionLine(row({ mode: "when_called", resumeMode: "when_called", lookEveryMinutes: 30 }), T0, ZONE))
      .toBe("Your attention: when something calls you, and a look every 30 minutes.");
  });

  it("names the day of a quiet that ends on another day", () => {
    expect(attentionLine(row({ mode: "quiet", resumeMode: "every_change", quietUntilMs: Date.UTC(2026, 9, 13, 6, 0) }), T0, ZONE))
      .toBe("Your attention: quiet until 2026-10-13 09:00.");
  });
});

describe("the setting, kept and reverted", () => {
  it("is every change with no look until she sets it", () => {
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "every_change", resumeMode: "every_change", lookEveryMinutes: 0 });
  });

  it("is kept across a restart of the world's database", () => {
    writeAttention(db, { ...readAttention(db, THREAD), mode: "when_called", resumeMode: "when_called", lookEveryMinutes: 30, setAtMs: T0 });
    db.close();
    db = openDomusDb(dir);
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "when_called", lookEveryMinutes: 30, setAtMs: T0 });
  });

  it("reverts a quiet to the mode it had before, once its time has passed, and keeps the revert", () => {
    writeAttention(db, { ...readAttention(db, THREAD), mode: "quiet", resumeMode: "when_called", quietUntilMs: T0 + 3_600_000 });
    expect(currentAttention(db, THREAD, T0 + 3_599_999).mode).toBe("quiet");
    expect(currentAttention(db, THREAD, T0 + 3_600_000)).toMatchObject({ mode: "when_called", quietUntilMs: undefined });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "when_called", quietUntilMs: undefined });
  });
});

describe("the game_attention tool", () => {
  let ask: (args: Record<string, unknown>, thread?: string) => Promise<Receipt>;
  let clock: number;

  /** One view of the game on its thread, from the attached helper session, so the game's thread is known. */
  function seedView(): void {
    admitObservation(db, {
      observationId: "helper-1.1", digest: "digest-1", thread: THREAD, world: "slot3", branch: "branch-1", session: "telemetry-1",
      attachment: "helper-1", body: "sim-9", snapshot: "7", seq: 1, sourceTimeMs: T0 - 1000, expiresAtMs: T0 + 30_000,
      receiptTimeMs: T0, lineageClass: "LIVE", payloadJson: "{}",
    });
  }

  beforeEach(() => {
    clock = T0;
    seedView();
    const tool: Tool = gameAttentionTool(() => ({ db, nowMs: () => clock, timeZone: ZONE, attachedSession: () => "helper-1" }));
    ask = (args, thread = THREAD) => tool.run(args, { thread, turnId: "t-attention", nowMs: clock } as ToolContext);
  });

  it("sets the game's thread's attention when it is asked from another thread", async () => {
    expect(await ask({ mode: "when_called" }, "discord:dm:owner")).toMatchObject({ ok: true });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "when_called" });
    expect(readAttention(db, "discord:dm:owner").mode).toBe("every_change");
  });

  it("says no view when the game has shown none, since there is no game thread to set", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "domus-attention-empty-"));
    const empty = openDomusDb(emptyDir);
    try {
      const tool: Tool = gameAttentionTool(() => ({ db: empty, nowMs: () => clock, timeZone: ZONE, attachedSession: () => undefined }));
      expect(await tool.run({ mode: "when_called" }, { thread: "discord:dm:owner", turnId: "t-none", nowMs: clock } as ToolContext))
        .toMatchObject({ ok: false, refused: { code: "no_view" } });
    } finally {
      empty.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("sets each mode and says what is now set", async () => {
    expect(await ask({ mode: "when_called" })).toMatchObject({ ok: true, summary: "Your attention is now: when something calls you." });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "when_called", resumeMode: "when_called" });
    expect(await ask({ mode: "every_change", look_every_minutes: 30 })).toMatchObject({
      ok: true, summary: "Your attention is now: every change, and a look every 30 minutes.",
    });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "every_change", lookEveryMinutes: 30 });
  });

  it("keeps the look when a later call leaves it out, and sets it to off with 0", async () => {
    await ask({ mode: "when_called", look_every_minutes: 45 });
    await ask({ mode: "every_change" });
    expect(readAttention(db, THREAD).lookEveryMinutes).toBe(45);
    await ask({ look_every_minutes: 0 });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "every_change", lookEveryMinutes: 0 });
  });

  it("sets quiet until a time in the Lar's zone, and remembers the mode to return to", async () => {
    await ask({ mode: "when_called" });
    const receipt = await ask({ mode: "quiet", until: "2026-10-12T14:30" });
    expect(receipt).toMatchObject({ ok: true, summary: "Your attention is now: quiet until 14:30." });
    expect(readAttention(db, THREAD)).toMatchObject({ mode: "quiet", resumeMode: "when_called", quietUntilMs: Date.UTC(2026, 9, 12, 11, 30) });
  });

  it("refuses quiet with no until, until with another mode, and a time that is past or more than 24 hours ahead", async () => {
    expect(await ask({ mode: "quiet" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ mode: "when_called", until: "2026-10-12T14:30" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ mode: "quiet", until: "2026-10-12T07:00" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ mode: "quiet", until: "soon" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    const tooLate = new Date(clock + UNTIL_MAX_MS + 60_000).toISOString();
    expect(await ask({ mode: "quiet", until: tooLate })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(readAttention(db, THREAD).mode).toBe("every_change");
  });

  it("accepts a look from 5 to 240 minutes, or 0, and refuses any other", async () => {
    expect(LOOK_MIN).toBe(5);
    expect(LOOK_MAX).toBe(240);
    expect(await ask({ look_every_minutes: 240 })).toMatchObject({ ok: true });
    expect(await ask({ look_every_minutes: 4 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ look_every_minutes: 241 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({ look_every_minutes: 7.5 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
  });

  it("refuses an unknown field and no mode and no look", async () => {
    expect(await ask({ mode: "when_called", loud: true })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await ask({})).toMatchObject({ ok: false, refused: { code: "bad_args" } });
  });
});

describe("the timed pass: a quiet ends, and a look is owed after the gap", () => {
  it("owes a look once the gap has passed while attached, and not again until it passes again", () => {
    writeAttention(db, { ...readAttention(db, THREAD), mode: "when_called", resumeMode: "when_called", lookEveryMinutes: 5, setAtMs: T0 });
    reviewAttention(db, T0 + 4 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(false);
    reviewAttention(db, T0 + 5 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(true);
    expect(takeLook(db, "helper-1", T0 + 5 * 60_000)).toBe(true);
    expect(lookOwed(db, "helper-1")).toBe(false);
    reviewAttention(db, T0 + 6 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(false);
    reviewAttention(db, T0 + 10 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(true);
  });

  it("owes no look while the game is not attached", () => {
    writeAttention(db, { ...readAttention(db, THREAD), lookEveryMinutes: 5, setAtMs: T0 });
    reviewAttention(db, T0 + 60 * 60_000, undefined);
    expect(lookOwed(db, "helper-1")).toBe(false);
  });

  it("counts the gap from the last waking view when there has been one", () => {
    writeAttention(db, { ...readAttention(db, THREAD), lookEveryMinutes: 5, setAtMs: T0, lastWakeMs: T0 + 20 * 60_000 });
    reviewAttention(db, T0 + 24 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(false);
    reviewAttention(db, T0 + 25 * 60_000, "helper-1");
    expect(lookOwed(db, "helper-1")).toBe(true);
  });

  it("hands a look over once, and records when", () => {
    writeAttention(db, { ...readAttention(db, THREAD), lookEveryMinutes: 5, setAtMs: T0 });
    reviewAttention(db, T0 + 5 * 60_000, "helper-1");
    expect(takeLook(db, "helper-1", T0 + 5 * 60_000)).toBe(true);
    expect(takeLook(db, "helper-1", T0 + 5 * 60_000)).toBe(false);
    expect(lastLookHanded(db, "helper-1")).toBe(T0 + 5 * 60_000);
  });
});
