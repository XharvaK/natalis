import { describe, expect, it } from "vitest";
import {
  BODY_LIMIT, canonicalJson, gameThreadOf, isActPhase, MAX_SKEW_MS, MAX_WINDOW_MS, MIN_TOKEN_BYTES, observationDigest,
  MEMORY_BODY_LIMIT, parseActSync, parseFeed, parseHeartbeat, parseMemory, parseObservation, parseSnapshot, parseUndo, tokenProblem, WireError,
} from "./wire.js";

const NOW = 1_800_000_000_000;

/** An invented view, as the helper would send it. */
function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    observation_id: "helper-1.1",
    world: "slot3",
    branch: "branch-1",
    session: "telemetry-1",
    attachment: "helper-1",
    body: "sim-9",
    snapshot: "7",
    seq: 1,
    source_time_ms: NOW - 1000,
    expires_at_ms: NOW + 30_000,
    lineage_class: "LIVE",
    percepts: [{ kind: "sim_arrives", salience: 0.5, facts: { subject: "Pim Dorrow", bucket: "social" } }],
    ...overrides,
  };
}

/** Throws the WireError the listener would answer with, and returns its status and code. */
function refusal(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof WireError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("observations (v1)", () => {
  it("admits a view that answers a look: its percept of kind look is kept as sent", () => {
    const parsed = parseObservation(view({ percepts: [{ kind: "look", salience: 0, facts: { bucket: "asked" } }] }), NOW);
    expect(parsed.percepts).toEqual([{ kind: "look", salience: 0, facts: { bucket: "asked" } }]);
  });

  it("admits a well-formed view and keeps its fields", () => {
    const parsed = parseObservation(view(), NOW);
    expect(parsed.observationId).toBe("helper-1.1");
    expect(parsed.fields).toMatchObject({ world: "slot3", attachment: "helper-1", seq: 1, lineageClass: "LIVE" });
    expect(parsed.percepts[0]).toMatchObject({ kind: "sim_arrives", salience: 0.5 });
    expect(parsed.options).toBeUndefined();
  });

  it("refuses an unknown top-level key, a bad id, and a wrong version as invalid_body", () => {
    expect(refusal(() => parseObservation(view({ extra: 1 }), NOW))).toEqual({ status: 400, code: "invalid_body" });
    expect(refusal(() => parseObservation(view({ observation_id: "has space" }), NOW))).toEqual({ status: 400, code: "invalid_body" });
    expect(refusal(() => parseObservation(view({ v: 2 }), NOW))).toEqual({ status: 400, code: "invalid_body" });
    expect(refusal(() => parseObservation([], NOW))).toEqual({ status: 400, code: "invalid_body" });
  });

  it("refuses unknown percept keys, salience outside 0..1, and facts over 2048 bytes", () => {
    const badKey = [{ kind: "sim_arrives", salience: 0.5, facts: {}, extra: true }];
    expect(refusal(() => parseObservation(view({ percepts: badKey }), NOW)).code).toBe("invalid_body");
    const high = [{ kind: "sim_arrives", salience: 1.5, facts: {} }];
    expect(refusal(() => parseObservation(view({ percepts: high }), NOW)).code).toBe("invalid_body");
    const big = [{ kind: "sim_arrives", salience: 0.5, facts: { text: "x".repeat(2100) } }];
    expect(refusal(() => parseObservation(view({ percepts: big }), NOW)).code).toBe("invalid_body");
    const many = Array.from({ length: 33 }, () => ({ kind: "sim_arrives", salience: 0.5, facts: {} }));
    expect(refusal(() => parseObservation(view({ percepts: many }), NOW)).code).toBe("invalid_body");
  });

  it("refuses a window over 600000 ms or one that does not run forward", () => {
    const long = view({ expires_at_ms: NOW - 1000 + MAX_WINDOW_MS + 1 });
    expect(refusal(() => parseObservation(long, NOW)).code).toBe("invalid_body");
    const backwards = view({ expires_at_ms: NOW - 1000 });
    expect(refusal(() => parseObservation(backwards, NOW)).code).toBe("invalid_body");
  });

  it("refuses a source time more than 120 s ahead as clock_skew, and an expired view as 410 expired", () => {
    const ahead = view({ source_time_ms: NOW + MAX_SKEW_MS + 1, expires_at_ms: NOW + MAX_SKEW_MS + 20_000 });
    expect(refusal(() => parseObservation(ahead, NOW))).toEqual({ status: 400, code: "clock_skew" });
    const late = view({ source_time_ms: NOW - 40_000, expires_at_ms: NOW - 10_000 });
    expect(refusal(() => parseObservation(late, NOW))).toEqual({ status: 410, code: "expired" });
  });

  it("accepts a day digest and a portrait, and refuses a day over 16384 bytes", () => {
    const parsed = parseObservation(view({ day: { note: "an invented day" }, portrait: { mood: "calm" } }), NOW);
    expect(parsed.normalized).toMatchObject({ day: { note: "an invented day" }, portrait: { mood: "calm" } });
    expect(refusal(() => parseObservation(view({ day: { big: "x".repeat(17000) } }), NOW)).code).toBe("invalid_body");
  });

  it("keeps the option table up to 160 objects and 32 KiB, and refuses more", () => {
    const options = [{ object: "Test kettle", object_id: "obj-1", acts: [{ ref: "a1", guid64: "123", text: "Boil water" }] }];
    const parsed = parseObservation(view({ options }), NOW);
    expect(parsed.options).toEqual(options);
    expect(refusal(() => parseObservation(view({ options: ["not an object"] }), NOW)).code).toBe("invalid_body");
    const many = Array.from({ length: 161 }, (_, index) => ({ object: `Test object ${index}`, object_id: `obj-${index}`, acts: [] }));
    expect(refusal(() => parseObservation(view({ options: many }), NOW)).code).toBe("invalid_body");
    expect(parseObservation(view({ options: many.slice(0, 160) }), NOW).options).toHaveLength(160);
    const heavy = [{ object: "x", object_id: "y", acts: [], note: "z".repeat(33_000) }];
    expect(refusal(() => parseObservation(view({ options: heavy }), NOW)).code).toBe("invalid_body");
  });

  it("reads a room and a near flag on an option object, and refuses one of the wrong kind", () => {
    const options = [{ object: "Test mailbox", object_id: "obj-2", room: "Test hall", near: false, acts: [{ ref: "a2", guid64: "124", text: "Check the mail" }] }];
    expect(parseObservation(view({ options }), NOW).options).toEqual(options);
    expect(refusal(() => parseObservation(view({ options: [{ object: "x", object_id: "y", acts: [], room: "r".repeat(65) }] }), NOW)).code).toBe("invalid_body");
    expect(refusal(() => parseObservation(view({ options: [{ object: "x", object_id: "y", acts: [], near: "yes" }] }), NOW)).code).toBe("invalid_body");
  });

  it("keeps options_cut as the count and the rooms left out, and refuses a malformed one", () => {
    expect(parseObservation(view(), NOW).optionsCut).toBeUndefined();
    const parsed = parseObservation(view({ options_cut: { objects: 12, rooms: ["Test attic", "Test garden"] } }), NOW);
    expect(parsed.optionsCut).toEqual({ objects: 12, rooms: ["Test attic", "Test garden"] });
    expect(parsed.normalized.options_cut).toEqual({ objects: 12, rooms: ["Test attic", "Test garden"] });
    expect(refusal(() => parseObservation(view({ options_cut: { objects: -1, rooms: [] } }), NOW)).code).toBe("invalid_body");
    expect(refusal(() => parseObservation(view({ options_cut: { objects: 1, rooms: [3] } }), NOW)).code).toBe("invalid_body");
    expect(refusal(() => parseObservation(view({ options_cut: { objects: 1, rooms: [], extra: true } }), NOW)).code).toBe("invalid_body");
  });

  it("digests the same content the same way whatever order its keys came in", () => {
    const first = parseObservation(view(), NOW);
    const reordered = parseObservation(Object.fromEntries(Object.entries(view()).reverse()), NOW);
    expect(observationDigest(first.normalized)).toBe(observationDigest(reordered.normalized));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}');
    const changed = parseObservation(view({ seq: 2 }), NOW);
    expect(observationDigest(changed.normalized)).not.toBe(observationDigest(first.normalized));
  });

  it("keeps the body limit at 64 KiB for every route but the snapshot", () => {
    expect(BODY_LIMIT).toBe(64 * 1024);
  });
});

describe("heartbeats, undo, feed (v1)", () => {
  it("accepts a heartbeat and keeps only the wire's fields", () => {
    const heartbeat = parseHeartbeat({ v: 1, helper_session: "h1", sent_at_ms: NOW, attached: true, probe_version: "2.30.0", inputs: "game_only" });
    expect(heartbeat).toEqual({ helperSession: "h1", sentAtMs: NOW, attached: true, probeVersion: "2.30.0", inputs: "game_only" });
    expect(refusal(() => parseHeartbeat({ v: 1, helper_session: "h1", sent_at_ms: NOW, attached: "yes" })).code).toBe("invalid_body");
    expect(refusal(() => parseHeartbeat({ v: 1, helper_session: "h1", sent_at_ms: NOW, attached: true, inputs: "both" })).code).toBe("invalid_body");
    expect(refusal(() => parseHeartbeat({ v: 1, helper_session: "h1", sent_at_ms: NOW, attached: true, stray: 1 })).code).toBe("invalid_body");
  });

  it("parses an undo, and refuses an unknown key, a lowercase reason and a negative time", () => {
    const undo = { v: 1, world: "slot3", branch: "b", session: "s", after_source_time_ms: NOW, reason: "HELPER_UNDO" };
    expect(parseUndo(undo)).toEqual({ world: "slot3", branch: "b", session: "s", afterSourceTimeMs: NOW, reason: "HELPER_UNDO" });
    expect(refusal(() => parseUndo({ ...undo, extra: 1 })).code).toBe("invalid_body");
    expect(refusal(() => parseUndo({ ...undo, reason: "lower" })).code).toBe("invalid_body");
    expect(refusal(() => parseUndo({ ...undo, after_source_time_ms: -1 })).code).toBe("invalid_body");
  });

  it("parses a feed request", () => {
    expect(parseFeed({ v: 1, helper_session: "h1" })).toEqual({ helperSession: "h1" });
    expect(refusal(() => parseFeed({ v: 1, helper_session: "h1", more: true })).code).toBe("invalid_body");
  });
});

describe("acts sync and snapshot (v1)", () => {
  it("parses events with a phase, an id, a time and an optional small detail", () => {
    const parsed = parseActSync({
      v: 1,
      helper_session: "h1",
      events: [{ act_id: "abc123", phase: "finished", at_ms: NOW, detail: { finishing_type: "NATURAL" } }, { act_id: "abc123", phase: "received", at_ms: NOW }],
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toEqual({ actId: "abc123", phase: "finished", atMs: NOW, detail: { finishing_type: "NATURAL" } });
    expect(refusal(() => parseActSync({ v: 1, helper_session: "h1", events: [{ act_id: "a-b", phase: "received", at_ms: NOW }] })).code).toBe("invalid_body");
    expect(refusal(() => parseActSync({ v: 1, helper_session: "h1", events: [{ act_id: "a1", phase: "requested", at_ms: NOW }] })).code).toBe("invalid_body");
    expect(refusal(() => parseActSync({ v: 1, helper_session: "h1", events: [] , stray: 1 })).code).toBe("invalid_body");
    const big = { v: 1, helper_session: "h1", events: [{ act_id: "a1", phase: "received", at_ms: NOW, detail: { x: "y".repeat(1100) } }] };
    expect(refusal(() => parseActSync(big)).code).toBe("invalid_body");
    const many = { v: 1, helper_session: "h1", events: Array.from({ length: 65 }, () => ({ act_id: "a1", phase: "received", at_ms: NOW })) };
    expect(refusal(() => parseActSync(many)).code).toBe("invalid_body");
  });

  it("knows the seven phases and no others", () => {
    for (const phase of ["received", "accepted", "rejected", "pushed", "finished", "unknown", "expired"]) expect(isActPhase(phase)).toBe(true);
    expect(isActPhase("requested")).toBe(false);
    expect(isActPhase(undefined)).toBe(false);
  });

  it("accepts exactly one of a picture or a failure, and checks the failure's word", () => {
    expect(parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap-1", failed: "no_game_window" })).toEqual({
      helperSession: "h1", snapshotId: "snap-1", failed: "no_game_window",
    });
    expect(refusal(() => parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap-1" })).code).toBe("invalid_body");
    expect(parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap-1", failed: "minimized" })).toMatchObject({ failed: "minimized" });
    expect(parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap-1", failed: "not_front" })).toMatchObject({ failed: "not_front" });
    expect(refusal(() => parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap-1", failed: "x", png_base64: "AA==" })).code).toBe("invalid_body");
    expect(refusal(() => parseSnapshot({ v: 1, helper_session: "h1", snapshot_id: "snap 1", failed: "capture_failed" })).code).toBe("invalid_body");
  });
});

describe("tokens and game threads", () => {
  const token = ["helper", "token", "test", "value", "x".repeat(MIN_TOKEN_BYTES)].join("-");

  it("refuses a missing, short, or other-token-equal token", () => {
    expect(tokenProblem("   ", [])).toBe("missing");
    expect(tokenProblem("short", [])).toBe("too_short");
    expect(tokenProblem(token, [token])).toBe("matches_other");
    expect(tokenProblem(token, [["other", "value", "y".repeat(40)].join("-")])).toBeNull();
  });

  it("names a game thread domus:<world>, with unusual characters made plain", () => {
    expect(gameThreadOf("slot3")).toBe("domus:slot3");
    expect(gameThreadOf("My Town/1")).toBe("domus:My_Town_1");
    expect(gameThreadOf("")).toBe("domus:unknown");
  });
});

describe("the memory answer (v1)", () => {
  const ACT = { act_id: "a-1", at: "14:20:00.000 day:3 week:0", minutes: 45, what: "Brew Glimmer", by: "user_intent", needs: { Gloop: 30 }, moodlets: ["Zingy"], reactions: ["Flurbed"], people: [{ who: "Mara Quill", role: "target" }], day: 3, at_ms: NOW - 1000 };
  const body = (facts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ v: 1, helper_session: "h1", ask_id: "ask-1", facts, ...extra });

  it("accepts the answer as the helper sends it, with the act lines and the people as they are", () => {
    expect(parseMemory(body({ matched: 2, acts: [ACT], people: [{ who: "Mara Quill", acts: 12, last_at_ms: NOW - 1000 }] }))).toEqual({
      helperSession: "h1", askId: "ask-1", facts: { matched: 2, acts: [ACT], people: [{ who: "Mara Quill", acts: 12, last_at_ms: NOW - 1000 }] },
    });
    expect(parseMemory(body({ matched: 0, acts: [], people: [] })).facts).toEqual({ matched: 0, acts: [], people: [] });
  });

  it("refuses an unknown key, a wrong version, a bad ask id, a bad count, and a fact it does not know", () => {
    expect(refusal(() => parseMemory({ ...body({ matched: 0, acts: [], people: [] }), extra: 1 })).code).toBe("invalid_body");
    expect(refusal(() => parseMemory({ ...body({ matched: 0, acts: [], people: [] }), v: 2 })).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [], people: [] }, { ask_id: "a b" }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: -1, acts: [], people: [] }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [], people: [], score: 9 }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [{ ...ACT, verdict: "good" }], people: [] }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [], people: [{ who: "Mara", acts: "many" }] }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [], people: [] }, { facts: undefined, helper_session: "" }))).code).toBe("invalid_body");
  });

  it("holds at most twelve act lines and six people", () => {
    expect(parseMemory(body({ matched: 12, acts: Array.from({ length: 12 }, () => ACT), people: [] })).facts.acts).toHaveLength(12);
    expect(refusal(() => parseMemory(body({ matched: 13, acts: Array.from({ length: 13 }, () => ACT), people: [] }))).code).toBe("invalid_body");
    expect(refusal(() => parseMemory(body({ matched: 0, acts: [], people: Array.from({ length: 7 }, () => ({ who: "Mara" })) }))).code).toBe("invalid_body");
  });

  it("reads at most sixteen kilobytes of body, in the route's own limit", () => {
    expect(MEMORY_BODY_LIMIT).toBe(16 * 1024);
  });
});
