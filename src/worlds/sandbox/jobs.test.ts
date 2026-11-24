import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receipt, WorldEvent } from "../../contracts.js";
import { createJobRunner, JOB_CUT_LINE, JOB_LOG_CAP_BYTES, JOB_TAIL_MAX, type JobRunner } from "./jobs.js";

class FakeChild extends EventEmitter {
  readonly pid = 5150;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

let dir: string;
let runner: JobRunner;
let children: FakeChild[];
let events: WorldEvent[];
let killGroup: ReturnType<typeof vi.fn>;
let clock: number;
let refusal: Receipt | undefined;

function make(): void {
  children = [];
  events = [];
  killGroup = vi.fn();
  clock = 1_000;
  refusal = undefined;
  runner = createJobRunner({
    worldId: "sandbox",
    homeDir: join(dir, "home"),
    maxJobs: 2,
    maxMinutes: 120,
    spawn: (_command: string, _args: string[], _options: SpawnOptions) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    killGroup,
    nowMs: () => clock,
    emit: (event) => events.push(event),
    launch: () => (refusal === undefined ? { program: "/usr/bin/bwrap", args: ["--echo"] } : { refused: refusal }),
    checkCommand: () => undefined,
    cleanText: (text) => text,
    ready: () => true,
  });
}

function start() {
  return runner.startTool;
}
function check() {
  return runner.checkTool;
}
function stop() {
  return runner.stopTool;
}

/** Waits for the log's write stream to reach the disk. */
function flushed(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-jobs-test-"));
  make();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("the job log", () => {
  it("creates the folder and the log file before the receipt names it", async () => {
    const receipt = await start().run({ command: "make", why: "a build" }, {} as never);
    expect(receipt.ok).toBe(true);
    expect(receipt.data).toEqual({ id: "j1", log: "/home/lar/.natalis-jobs/j1.log" });
    expect(existsSync(join(dir, "home", ".natalis-jobs", "j1.log"))).toBe(true);
  });

  it("writes both outputs to the log, and shows the tail on a check", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("out\n"));
    child.stderr.emit("data", Buffer.from("err\n"));
    const receipt = await check().run({ id: "j1" }, {} as never);
    expect(receipt.data?.["tail"]).toBe("out\nerr\n");
    await flushed();
    expect(readFileSync(join(dir, "home", ".natalis-jobs", "j1.log"), "utf8")).toBe("out\nerr\n");
  });

  it("stops writing at 2 MiB, adds the cut line once, and the job keeps running", async () => {
    await start().run({ command: "yes", why: "noise" }, {} as never);
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("a".repeat(JOB_LOG_CAP_BYTES - 1)));
    child.stdout.emit("data", Buffer.from("bcdef"));
    child.stdout.emit("data", Buffer.from("more"));
    await flushed();
    const log = readFileSync(join(dir, "home", ".natalis-jobs", "j1.log"), "utf8");
    expect(log.split(JOB_CUT_LINE)).toHaveLength(2);
    // Still exactly 2 MiB of the job's own output before the cut line, and nothing of the chunks past it.
    expect(log.slice(0, JOB_LOG_CAP_BYTES)).toBe(`${"a".repeat(JOB_LOG_CAP_BYTES - 1)}b`);
    expect(log.endsWith("more")).toBe(false);
    const receipt = await check().run({ id: "j1" }, {} as never);
    expect(receipt.data?.["running"]).toBe(true);
  });

  it("shows the default tail, and never more than 20,000 characters", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("x".repeat(30_000)));
    const byDefault = (await check().run({ id: "j1" }, {} as never)).data?.["tail"] as string;
    expect(byDefault).toHaveLength(2_000);
    const asked = (await check().run({ id: "j1", tail_bytes: 99_000 }, {} as never)).data?.["tail"] as string;
    expect(asked).toHaveLength(JOB_TAIL_MAX);
  });
});

describe("the job ids and refusals", () => {
  it("counts j1, j2 per start, and starts again from j1 after a reset", async () => {
    expect((await start().run({ command: "a", why: "one" }, {} as never)).data?.["id"]).toBe("j1");
    expect((await start().run({ command: "b", why: "two" }, {} as never)).data?.["id"]).toBe("j2");
    runner.reset();
    expect((await start().run({ command: "c", why: "three" }, {} as never)).data?.["id"]).toBe("j1");
  });

  it("refuses a third job while two run, naming them", async () => {
    await start().run({ command: "a", why: "one" }, {} as never);
    await start().run({ command: "b", why: "two" }, {} as never);
    const receipt = await start().run({ command: "c", why: "three" }, {} as never);
    expect(receipt.refused?.code).toBe("too_many_jobs");
    expect(receipt.refused?.reason).toBe("running: j1, j2");
  });

  it("answers an unknown id with not_found and names the known ones", async () => {
    const none = await check().run({ id: "j7" }, {} as never);
    expect(none.refused?.code).toBe("not_found");
    expect(none.summary).toContain("No background job has run.");
    await start().run({ command: "a", why: "one" }, {} as never);
    expect((await stop().run({ id: "j7", why: "gone" }, {} as never)).summary).toContain("The jobs are j1.");
  });

  it("passes a refused launch back as the receipt, and starts nothing", async () => {
    refusal = { ok: false, summary: "The command did not run.", refused: { code: "network_not_walled", reason: "no pasta" } };
    const receipt = await start().run({ command: "a", why: "one" }, {} as never);
    expect(receipt.refused?.code).toBe("network_not_walled");
    expect(children).toHaveLength(0);
  });

  it("caps max_minutes at the runner's ceiling", async () => {
    vi.useFakeTimers();
    await start().run({ command: "a", why: "one", max_minutes: 5_000 }, {} as never);
    vi.advanceTimersByTime(119 * 60_000);
    expect(killGroup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(killGroup).toHaveBeenCalledWith(5150, "SIGTERM");
    (children[0] as FakeChild).emit("close", null, "SIGTERM");
    expect(events[0]?.text).toContain("It ran out of time (120 min).");
  });
});

describe("the end event", () => {
  it("goes to the Lar's own thread once, with the exit code, the seconds and the last lines", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    clock = 1_000 + 4_500;
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("building\n"));
    child.emit("exit", 2, null);
    child.emit("close", 2, null);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      world: "sandbox",
      place: "sandbox:jobs",
      thread: "self",
      source: "body",
      text: "Your background job j1 (a build) ended with exit code 2 after 4.5 s.\n\nIts last lines:\nbuilding",
      data: { job: "j1", exitCode: 2, seconds: 4.5 },
    });
  });

  it("carries only the last 1,000 characters of the log", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from(`${"H".repeat(3_000)}TAIL-MARK`));
    child.emit("close", 0, null);
    const text = events[0]?.text ?? "";
    expect(text).toContain("TAIL-MARK");
    expect(text.length).toBeLessThan(1_200);
  });

  it("is told once, whichever of exit and close comes first", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    const child = children[0] as FakeChild;
    child.emit("close", 0, null);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(events).toHaveLength(1);
  });

  it("says a start that failed after the receipt ended the job, and keeps the failure in the log", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    (children[0] as FakeChild).emit("error", new Error("spawn bwrap ENOENT"));
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("ended with exit code none");
    await flushed();
    expect(readFileSync(join(dir, "home", ".natalis-jobs", "j1.log"), "utf8")).toContain("The job could not start: spawn bwrap ENOENT");
  });

  it("cleans the tail with the world's cleaner before the Lar sees it", async () => {
    make();
    const cleaned = createJobRunner({
      worldId: "sandbox",
      homeDir: join(dir, "home"),
      maxJobs: 1,
      maxMinutes: 1,
      spawn: (_command: string, _args: string[], _options: SpawnOptions) => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
      killGroup,
      nowMs: () => clock,
      emit: (event) => events.push(event),
      launch: () => ({ program: "/usr/bin/bwrap", args: [] }),
      checkCommand: () => undefined,
      cleanText: (text) => text.replace("NOISE\n", ""),
      ready: () => true,
    });
    await cleaned.startTool.run({ command: "make", why: "a build" }, {} as never);
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("NOISE\nreal line\n"));
    child.emit("close", 0, null);
    expect(events[0]?.text).toContain("Its last lines:\nreal line");
    expect(events[0]?.text).not.toContain("NOISE");
  });
});

describe("stopping", () => {
  it("stops one job with SIGTERM, then SIGKILL after the grace, and the end says it was stopped", async () => {
    vi.useFakeTimers();
    await start().run({ command: "sleep 999", why: "a crawl" }, {} as never);
    const pending = stop().run({ id: "j1", why: "not needed" }, {} as never);
    expect(killGroup).toHaveBeenCalledWith(5150, "SIGTERM");
    vi.advanceTimersByTime(2_000);
    expect(killGroup).toHaveBeenLastCalledWith(5150, "SIGKILL");
    vi.advanceTimersByTime(500);
    const receipt = await pending;
    expect(receipt.ok).toBe(true);
    expect(events[0]?.data).toMatchObject({ job: "j1", stopped: true });
    expect(events[0]?.text).toContain("It was stopped.");
  });

  it("refuses to stop a job that has already ended", async () => {
    await start().run({ command: "make", why: "a build" }, {} as never);
    (children[0] as FakeChild).emit("close", 0, null);
    const receipt = await stop().run({ id: "j1", why: "late" }, {} as never);
    expect(receipt.refused?.code).toBe("not_running");
  });

  it("stops every running job at once, and waits at most five seconds", async () => {
    vi.useFakeTimers();
    await start().run({ command: "a", why: "one" }, {} as never);
    await start().run({ command: "b", why: "two" }, {} as never);
    const stopping = runner.stopAll();
    expect(killGroup.mock.calls.map((call) => call[0])).toEqual([5150, 5150]);
    vi.advanceTimersByTime(5_000);
    await stopping;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.data?.["stopped"])).toEqual([true, true]);
  });
});

describe("the now line", () => {
  it("is absent with no jobs, and names each running job with its minutes and why", async () => {
    expect(runner.nowLine()).toBeUndefined();
    await start().run({ command: "a", why: "a crawl" }, {} as never);
    clock = 1_000 + 12 * 60_000;
    expect(runner.nowLine()).toBe("Background jobs running: j1 (12 min, a crawl).");
    (children[0] as FakeChild).emit("close", 0, null);
    expect(runner.nowLine()).toBeUndefined();
  });
});

describe("the home folder", () => {
  it("is made when a job starts, so a first job never fails on a missing home", async () => {
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "home"), { recursive: true, force: true });
    expect((await start().run({ command: "a", why: "one" }, {} as never)).ok).toBe(true);
    expect(existsSync(join(dir, "home", ".natalis-jobs"))).toBe(true);
  });
});
