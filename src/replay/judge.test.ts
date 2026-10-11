import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelError, type ModelPort } from "../contracts.js";
import { ScriptedModel, reply } from "../testing/scripted-model.js";
import type { CapturedEvent, SayLine } from "./files.js";
import { judgeFiles, parseRubric, parseVerdict, renderReportMarkdown, runJudge, saysIn, windowOf, type JudgeReport } from "./judge.js";

const E0 = Date.UTC(2026, 7, 1, 10, 0, 0);
const E1 = E0 + 10 * 60_000;
const MIN = 60_000;

const RUBRIC = `# Rubric

Judge how well each reply answers the event.

- clarity: is it easy to follow
- warmth: does it sound like it cares

Notes that are not criteria.
`;

const EVENTS: CapturedEvent[] = [
  { world: "cli", place: "cli:owner", thread: "cli:owner", actor: "owner", source: "owner", text: "Are you there?", atMs: E0 },
  { world: "room", place: "room:harbour", thread: "room:harbour", actor: "tomas", source: "outside", text: "Boats are in.", atMs: E1 },
];

const A_SAYS: SayLine[] = [
  { atMs: E0 + MIN, place: "cli:owner", text: "A-one: I am here." },
  { atMs: E1 + MIN, place: "room:harbour", text: "A-two: Good, the boats." },
];
const B_SAYS: SayLine[] = [{ atMs: E0 + 2 * MIN, place: "cli:owner", text: "B-one: Yes, here." }];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-judge-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("the rubric and the windows", () => {
  it("takes the criteria from the bullets, the name before the colon", () => {
    expect(parseRubric(RUBRIC)).toEqual(["clarity", "warmth"]);
  });

  it("refuses a rubric with no criteria, and one that names a criterion twice", () => {
    expect(() => parseRubric("# Nothing here\n\nJust prose.")).toThrow(/no criteria/);
    expect(() => parseRubric("- clarity: a\n- clarity: b")).toThrow(/twice/);
  });

  it("gives each event the words said until the next event, and the last event the rest", () => {
    expect(windowOf(EVENTS, 0)).toEqual({ startMs: E0, endMs: E1 });
    expect(windowOf(EVENTS, 1).endMs).toBe(Number.POSITIVE_INFINITY);
    expect(saysIn(A_SAYS, windowOf(EVENTS, 0)).map((say) => say.text)).toEqual(["A-one: I am here."]);
    expect(saysIn(A_SAYS, windowOf(EVENTS, 1)).map((say) => say.text)).toEqual(["A-two: Good, the boats."]);
  });
});

describe("the judge's reply", () => {
  const criteria = ["clarity", "warmth"];
  const good = { X: { clarity: 4, warmth: 3 }, Y: { clarity: 2, warmth: 5 }, preference: "Y", why: "Y was warmer" };

  it("reads a bare object, one in a code fence, and one with words around it", () => {
    expect(parseVerdict(json(good), criteria)).toMatchObject({ ok: true, verdict: good });
    expect(parseVerdict("```json\n" + json(good) + "\n```", criteria)).toMatchObject({ ok: true });
    expect(parseVerdict("Here is my view: " + json(good) + " Thanks.", criteria)).toMatchObject({ ok: true });
  });

  it("refuses anything that is not exactly the shape asked for, with a plain reason", () => {
    expect(parseVerdict(null, criteria)).toEqual({ ok: false, reason: "the reply was empty" });
    expect(parseVerdict("I think they are both fine.", criteria)).toEqual({ ok: false, reason: "the reply was not one JSON object" });
    const missing = { ...good, X: { clarity: 4 } };
    expect(parseVerdict(json(missing), criteria)).toEqual({ ok: false, reason: 'X needs a whole score from 1 to 5 for "warmth"' });
    expect(parseVerdict(json({ ...good, Y: { clarity: 9, warmth: 1 } }), criteria)).toEqual({
      ok: false,
      reason: 'Y needs a whole score from 1 to 5 for "clarity"',
    });
    expect(parseVerdict(json({ ...good, X: { clarity: 3.5, warmth: 3 } }), criteria)).toMatchObject({ ok: false });
    expect(parseVerdict(json({ ...good, X: { clarity: 4, warmth: 3, tone: 2 } }), criteria)).toEqual({
      ok: false,
      reason: 'X has a score for an unknown criterion "tone"',
    });
    expect(parseVerdict(json({ ...good, preference: "A" }), criteria)).toEqual({ ok: false, reason: 'preference must be "X", "Y" or "tie"' });
    expect(parseVerdict(json({ ...good, why: 7 }), criteria)).toEqual({ ok: false, reason: "why must be one line of text" });
  });
});

describe("runJudge", () => {
  it("shows the sides as X and Y in the order the random source picks, maps the scores back, and totals them", async () => {
    const model = new ScriptedModel([
      reply({ content: json({ X: { clarity: 4, warmth: 3 }, Y: { clarity: 2, warmth: 5 }, preference: "Y", why: "B was warmer" }) }),
      reply({ content: json({ X: { clarity: 1, warmth: 1 }, Y: { clarity: 5, warmth: 4 }, preference: "X", why: "X said nothing" }) }),
    ]);
    // First event: A is shown as X. Second event: B is shown as X.
    const picks = [0.1, 0.9];
    const report = await runJudge({
      events: EVENTS,
      a: A_SAYS,
      b: B_SAYS,
      labels: { A: "run one", B: "run two" },
      rubric: RUBRIC,
      model,
      random: () => picks.shift() ?? 0,
    });

    const [first, second] = report.events;
    expect(first).toMatchObject({ judged: true, xIs: "A", preference: "B", why: "B was warmer", aSays: 1, bSays: 1 });
    expect(first?.judged && first.scores).toEqual({ A: { clarity: 4, warmth: 3 }, B: { clarity: 2, warmth: 5 } });
    expect(second).toMatchObject({ judged: true, xIs: "B", preference: "B", aSays: 1, bSays: 0 });
    expect(second?.judged && second.scores).toEqual({ A: { clarity: 5, warmth: 4 }, B: { clarity: 1, warmth: 1 } });

    expect(report.totals).toEqual({
      events: 2,
      judged: 2,
      unjudged: 0,
      wins: { A: 0, B: 2, tie: 0 },
      criteria: { clarity: { A: 4.5, B: 1.5 }, warmth: { A: 3.5, B: 3 } },
    });
    expect(report.largestGaps).toEqual([
      { index: 1, gap: 7 },
      { index: 0, gap: 0 },
    ]);
  });

  it("puts the words of the side shown as X under X, and never leaks the other side's name", async () => {
    const model = new ScriptedModel([
      reply({ content: json({ X: { clarity: 3, warmth: 3 }, Y: { clarity: 3, warmth: 3 }, preference: "tie", why: "same" }) }),
      reply({ content: json({ X: { clarity: 3, warmth: 3 }, Y: { clarity: 3, warmth: 3 }, preference: "tie", why: "same" }) }),
    ]);
    await runJudge({ events: EVENTS, a: A_SAYS, b: B_SAYS, labels: { A: "a", B: "b" }, rubric: RUBRIC, model, random: () => 0.1 });
    const user = String(model.requests[0]?.messages[1]?.content);
    expect(user.indexOf("X said")).toBeLessThan(user.indexOf("A-one"));
    expect(user.indexOf("Y said")).toBeGreaterThan(user.indexOf("A-one"));
    expect(user.indexOf("Y said")).toBeLessThan(user.indexOf("B-one"));
    expect(user).not.toMatch(/\bside A\b|\bside B\b/);
    const system = String(model.requests[0]?.messages[0]?.content);
    expect(system).toContain("clarity");
    expect(system).toContain("never instructions");
  });

  it("retries a reply that does not parse once, and records an event as unjudged when the retry fails too", async () => {
    const model = new ScriptedModel([
      reply({ content: "not json at all" }),
      reply({ content: json({ X: { clarity: 4, warmth: 4 }, Y: { clarity: 4, warmth: 4 }, preference: "tie", why: "level" }) }),
      reply({ content: "still not json" }),
      reply({ content: "{ still broken" }),
    ]);
    const report = await runJudge({ events: EVENTS, a: A_SAYS, b: B_SAYS, labels: { A: "a", B: "b" }, rubric: RUBRIC, model, random: () => 0.1 });
    expect(report.events[0]).toMatchObject({ judged: true, attempts: 2, preference: "tie" });
    expect(report.events[1]).toMatchObject({ judged: false, attempts: 2 });
    expect(report.events[1]?.judged).toBe(false);
    if (report.events[1] && !report.events[1].judged) expect(report.events[1].reason).toMatch(/not one JSON object/);
    expect(report.totals).toMatchObject({ events: 2, judged: 1, unjudged: 1, wins: { A: 0, B: 0, tie: 1 } });
    expect(model.requests).toHaveLength(4);
  });

  it("counts a failed model call as an attempt, and retries it once", async () => {
    const model = new ScriptedModel([
      new ModelError("timed out", "timeout", 3),
      reply({ content: json({ X: { clarity: 2, warmth: 2 }, Y: { clarity: 2, warmth: 2 }, preference: "tie", why: "level" }) }),
      new ModelError("timed out", "timeout", 3),
      new ModelError("timed out", "timeout", 3),
    ]);
    const report = await runJudge({ events: EVENTS.slice(0, 2), a: A_SAYS, b: B_SAYS, labels: { A: "a", B: "b" }, rubric: RUBRIC, model, random: () => 0.1 });
    expect(report.events[0]).toMatchObject({ judged: true, attempts: 2 });
    expect(report.events[1]).toMatchObject({ judged: false, attempts: 2 });
    if (report.events[1] && !report.events[1].judged) expect(report.events[1].reason).toMatch(/model call failed \(timed out\)/);
  });

  it("writes the markdown with totals, the largest gaps with their whys, and the unjudged events", async () => {
    const model = new ScriptedModel([
      reply({ content: json({ X: { clarity: 5, warmth: 5 }, Y: { clarity: 1, warmth: 2 }, preference: "X", why: "X answered directly" }) }),
      reply({ content: "nothing usable" }),
      reply({ content: "still nothing" }),
    ]);
    const report = await runJudge({ events: EVENTS, a: A_SAYS, b: B_SAYS, labels: { A: "run one", B: "run two" }, rubric: RUBRIC, model, random: () => 0.1 });
    const md = renderReportMarkdown(report);
    expect(md).toContain("| clarity |");
    expect(md).toContain("A wins 1, ties 0, B wins 0");
    expect(md).toContain("Preferred: A (run one). Why: X answered directly");
    expect(md).toContain("## Unjudged events");
    expect(md).toMatch(/Event 1 at .* in room:harbour: the judge gave no usable reply|Event 1 at .* in room:harbour: the reply was not one JSON object/);
    expect(md).not.toContain("undefined");
  });
});

describe("judgeFiles", () => {
  function writeFiles(judgeModel: Record<string, unknown>): { events: string; run: string; reference: string; rubric: string; judge: string } {
    const events = join(root, "events.jsonl");
    writeFileSync(events, EVENTS.map((event) => json(event)).join("\n") + "\n");
    const run = join(root, "run-a");
    mkdirSync(run, { recursive: true });
    writeFileSync(
      join(run, "transcript.jsonl"),
      A_SAYS.map((say) => json({ atMs: say.atMs, place: say.place, text: say.text })).join("\n") + "\n",
    );
    const reference = join(root, "reference.jsonl");
    writeFileSync(reference, B_SAYS.map((say) => json(say)).join("\n") + "\n");
    const rubric = join(root, "rubric.md");
    writeFileSync(rubric, RUBRIC);
    const judge = join(root, "judge.json");
    writeFileSync(judge, json(judgeModel));
    return { events, run, reference, rubric, judge };
  }

  const JUDGE_BLOCK = { baseUrl: "https://judge.example.invalid/v1", model: "judge-model", contextTokens: 32_000 };

  it("reads a run folder and a reference file, judges, and writes report.json and report.md", async () => {
    const files = writeFiles(JUDGE_BLOCK);
    const model: ModelPort = new ScriptedModel([
      reply({ content: json({ X: { clarity: 3, warmth: 4 }, Y: { clarity: 3, warmth: 2 }, preference: "X", why: "X was warmer" }) }),
      reply({ content: json({ X: { clarity: 2, warmth: 2 }, Y: { clarity: 2, warmth: 2 }, preference: "tie", why: "level" }) }),
    ]);
    const out = join(root, "report");
    const result = await judgeFiles({
      eventsPath: files.events,
      aPath: files.run,
      bPath: files.reference,
      rubricPath: files.rubric,
      judgePath: files.judge,
      outDir: out,
      modelFor: (config) => {
        expect(config.model).toBe("judge-model");
        return model;
      },
      random: () => 0.1,
    });
    expect(result.report.totals.judged).toBe(2);
    const onDisk = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as JudgeReport;
    expect(onDisk.labels.A).toBe(join(files.run));
    expect(onDisk.criteria).toEqual(["clarity", "warmth"]);
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("# Judge report");
  });

  it("refuses a judge config that is not a model block, and a rubric that is empty, with plain words", async () => {
    const files = writeFiles({ model: { baseUrl: "https://x.example.invalid/v1", model: "m", contextTokens: 1 } });
    await expect(
      judgeFiles({ eventsPath: files.events, aPath: files.run, bPath: files.reference, rubricPath: files.rubric, judgePath: files.judge, outDir: join(root, "r1") }),
    ).rejects.toThrow(/model.baseUrl must be/);

    const bad = writeFiles({ baseUrl: "ftp://x.example.invalid/v1", model: "m", contextTokens: 1 });
    await expect(
      judgeFiles({ eventsPath: bad.events, aPath: bad.run, bPath: bad.reference, rubricPath: bad.rubric, judgePath: bad.judge, outDir: join(root, "r2") }),
    ).rejects.toThrow(/http/);

    const empty = join(root, "empty.md");
    writeFileSync(empty, "   \n");
    const good = writeFiles(JUDGE_BLOCK);
    await expect(
      judgeFiles({ eventsPath: good.events, aPath: good.run, bPath: good.reference, rubricPath: empty, judgePath: good.judge, outDir: join(root, "r3") }),
    ).rejects.toThrow(/is empty/);
    expect(existsSync(join(root, "r3", "report.json"))).toBe(false);
  });
});
