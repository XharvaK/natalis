import { describe, expect, it } from "vitest";
import { ModelError, type ModelRequest, type ModelResponse } from "../contracts.js";
import type { CallRow } from "../river/ledger.js";
import { ScriptedModel, reply, type ScriptStep } from "../testing/scripted-model.js";
import { createWitness, withWitness, type CacheWitness } from "./witness.js";

const WHO = "## who\nA Lar.";
const NATURE = "## nature\nA voice.";
const SYSTEM = `${WHO}\n\n${NATURE}`;
const RECENT = "Recent here:\nrow one";
const HOUR = 60 * 60 * 1000;

/** One request: a system text of a fixed part and a notes part, and a user message of a page part and a turn part. */
function requestOf(parts: { who?: string; nature?: string; recent?: string; turn?: string }): ModelRequest {
  const who = parts.who ?? WHO;
  const nature = parts.nature ?? NATURE;
  const system = `${who}\n\n${nature}`;
  const recent = parts.recent ?? RECENT;
  const turn = parts.turn ?? "New:\nrow two";
  const user = `${recent}\n\n${turn}`;
  return {
    messages: [
      {
        role: "system",
        content: system,
        layout: [
          { name: "who", cls: "fixed", end: who.length },
          { name: "nature", cls: "notes", end: system.length },
        ],
      },
      {
        role: "user",
        content: user,
        layout: [
          { name: "recent", cls: "page", end: recent.length },
          { name: "new", cls: "turn", end: user.length },
        ],
      },
    ],
  };
}

const usage = { inputTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40 };

/** A successful reply that reports the usage above. */
const ok = (): ModelResponse => ({ ...reply({ content: "ok" }), usage });

/** A witness with a clock the test moves, a list of the rows it writes, and a list of the log lines it writes. */
function rig(options: { write?: (row: CallRow) => void } = {}) {
  const rows: CallRow[] = [];
  const logs: string[] = [];
  let clock = 1_000;
  const witness: CacheWitness = createWitness({
    write: options.write ?? ((row) => rows.push(row)),
    now: () => clock,
    log: (line) => logs.push(line),
  });
  return {
    witness,
    rows,
    logs,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** A port that replies with usage, on the given witness, for one turn of one thread kind. */
function turnPort(
  steps: ScriptStep[],
  witness: CacheWitness,
  threadKind: "summoner" | "game" | "contact" = "summoner",
  cacheMarks = false,
) {
  const port = new ScriptedModel(steps);
  return { port: withWitness(port, witness, threadKind, { cacheMarks }), model: port };
}

describe("the cache witness: what a row says", () => {
  it("writes a first row with every part and its size, and no earlier call to match", async () => {
    const { witness, rows } = rig();
    const { port } = turnPort([ok()], witness);

    await port.complete(requestOf({}));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      threadKind: "summoner",
      turnCall: 1,
      model: "scripted:test-model",
      promptChars: SYSTEM.length + RECENT.length + "\n\nNew:\nrow two".length,
      stableChars: 0,
      breakPart: "who",
      breakClass: "fixed",
      marks: 0,
    });
    expect(rows[0]?.idleMs).toBeUndefined();
    expect(rows[0]?.partSizes).toEqual({ who: WHO.length, nature: NATURE.length + 2, recent: RECENT.length, new: "\n\nNew:\nrow two".length });
  });

  it("finds the earlier call with the longest run, and counts the characters of the run as stable", async () => {
    const { witness, rows } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    await turnPort([ok()], witness).port.complete(requestOf({ turn: "New:\nrow three" }));

    expect(rows[1]).toMatchObject({ stableChars: SYSTEM.length + RECENT.length, breakPart: "new", breakClass: "turn" });
  });

  it("names a notes part that changed, with its class, and counts only the parts before it as stable", async () => {
    const { witness, rows } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    await turnPort([ok()], witness).port.complete(
      requestOf({ nature: "## nature\nA quieter voice." }),
    );

    expect(rows[1]).toMatchObject({ stableChars: WHO.length, breakPart: "nature", breakClass: "notes" });
  });

  it("gives the idle time since the earlier call it matched", async () => {
    const { witness, rows, tick } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    tick(4_000);
    await turnPort([ok()], witness).port.complete(requestOf({ turn: "New:\nrow three" }));

    expect(rows[1]?.idleMs).toBe(4_000);
  });

  it("reads the provider's counts from the response, and counts the marks only when marks are on", async () => {
    const { witness, rows } = rig();
    await turnPort([ok()], witness, "summoner", false).port.complete(requestOf({}));
    await turnPort([ok()], witness, "summoner", true).port.complete(requestOf({ turn: "New:\nrow three" }));

    expect(rows[0]).toMatchObject({ promptTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40, marks: 0 });
    expect(rows[1]).toMatchObject({ marks: 3 });
  });

  it("holds no words: the rows are counts and names only", async () => {
    const { witness, rows } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    await turnPort([ok()], witness).port.complete(requestOf({ turn: "New:\nrow three" }));

    const text = JSON.stringify(rows);
    expect(text).not.toContain("A Lar");
    expect(text).not.toContain("row one");
    expect(text).not.toContain("row three");
    expect(text).not.toContain("voice");
  });
});

describe("the cache witness: what it does and does not do", () => {
  it("writes no row for a call that throws, and passes the error on unchanged", async () => {
    const { witness, rows } = rig();
    const failure = new ModelError("the service said no", "unavailable", 1);
    const { port } = turnPort([failure], witness);

    await expect(port.complete(requestOf({}))).rejects.toBe(failure);
    expect(rows).toHaveLength(0);
  });

  it("never fails a call when its row cannot be written", async () => {
    const { witness } = rig({
      write: () => {
        throw new Error("the disk is full");
      },
    });
    const { port } = turnPort([ok()], witness);

    await expect(port.complete(requestOf({}))).resolves.toMatchObject({ content: "ok" });
  });

  it("shares its memory across threads: a call on one thread matches an earlier call on another", async () => {
    const { witness, rows } = rig();
    await turnPort([ok()], witness, "summoner").port.complete(requestOf({}));
    await turnPort([ok()], witness, "game").port.complete(requestOf({ turn: "New:\nrow game" }));

    expect(rows[1]).toMatchObject({ threadKind: "game", stableChars: SYSTEM.length + RECENT.length });
  });

  it("remembers only the last sixteen requests", async () => {
    const { witness, rows } = rig();
    for (let i = 0; i < 17; i += 1) {
      await turnPort([ok()], witness).port.complete(requestOf({ who: `## who\nA Lar ${i}.` }));
    }
    await turnPort([ok()], witness).port.complete(requestOf({ who: "## who\nA Lar 0." }));

    expect(rows[17]).toMatchObject({ stableChars: 0, breakPart: "who" });
  });

  it("logs a fixed or notes part that breaks the first call of a turn, at most once an hour per part", async () => {
    const { witness, logs, tick } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    expect(logs).toHaveLength(0);

    // The first call of a turn breaks a fixed part: it is named once.
    const first = turnPort([ok(), ok()], witness).port;
    await first.complete(requestOf({ who: "## who\nChanged." }));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"who"');

    // The same turn's second call breaks it again: not logged, since it is not the first call of the turn.
    await first.complete(requestOf({ who: "## who\nChanged again." }));
    expect(logs).toHaveLength(1);

    // Another turn within the hour: the same part is not named again.
    tick(10 * 60 * 1000);
    await turnPort([ok()], witness).port.complete(requestOf({ who: "## who\nAgain." }));
    expect(logs).toHaveLength(1);

    // After an hour the part is named again.
    tick(HOUR);
    await turnPort([ok()], witness).port.complete(requestOf({ who: "## who\nAnd again." }));
    expect(logs).toHaveLength(2);
  });

  it("does not log a turn-class break on the first call of a turn", async () => {
    const { witness, logs } = rig();
    await turnPort([ok()], witness).port.complete(requestOf({}));
    await turnPort([ok()], witness).port.complete(requestOf({ turn: "New:\nrow three" }));

    expect(logs).toHaveLength(0);
  });
});
