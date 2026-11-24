import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receipt, Tool, ToolContext, World, WorldBody, WorldEvent } from "../../contracts.js";
import { buildBwrapArgs } from "./bwrap.js";
import { PASTA_ARGS, routeScript } from "./wall.js";
import { createSandboxWorld, formatBytes, measureHome, type SpawnFn } from "./sandbox-world.js";
import { JOB_CUT_LINE, JOB_LOG_CAP_BYTES } from "./jobs.js";
import { OUTPUT_CAP_BYTES } from "./output.js";
import { PICTURE_BYTES_MAX } from "../../media/shelf.js";
import { privacyBody } from "../../testing/privacy-body.js";
import { PRIVACY_UNREADABLE_REASON } from "../../entity/privacy.js";

type SandboxConfigOverride = {
  timeoutSeconds: number;
  maxTimeoutSeconds: number;
  bwrapPath?: string;
  body?: boolean;
  network?: "wall" | "host" | "none";
  pastaPath?: string;
  ipPath?: string;
  maxBackgroundJobs?: number;
  maxJobMinutes?: number;
};

// A child process the tests drive by hand: its output and its exit are the test's to decide.
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

type Harness = {
  world: World;
  spawn: ReturnType<typeof vi.fn>;
  killGroup: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  dir: string;
  nowValues: number[];
};

let dir: string;
/** The checkout folder the body bind points at in these tests: a folder of the test's own, under the entity folder. */
let checkout: string;
let harness: Harness;

function makeHarness(
  overrides: Partial<{
    config: SandboxConfigOverride;
    bodyDir: string;
    platform: NodeJS.Platform;
    spawnThrows: boolean;
    locate: (configured: string | undefined) => string | undefined;
    locatePasta: (configured: string | undefined) => string | undefined;
    locateIp: (configured: string | undefined) => string | undefined;
    hostAddresses: string[];
    publicState: "known" | "unknown" | "off";
    nowMs: () => number;
  }> = {},
): Harness {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
    if (overrides.spawnThrows) throw new Error("spawn exploded");
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const killGroup = vi.fn();
  const nowValues = [1_000, 3_500];
  const world = createSandboxWorld({
    dir,
    // The host network unless a test says otherwise: the bwrap argument tests are about bwrap, and the wall has its own tests.
    config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "host", ...(overrides.config ?? {}) },
    // A checkout folder of the test's own, so the body bind never depends on the real repository.
    bodyDir: overrides.bodyDir ?? checkout,
    spawn: spawn as unknown as SpawnFn,
    platform: overrides.platform ?? "linux",
    locateBwrap: overrides.locate ?? (() => "/usr/bin/bwrap"),
    locatePasta: overrides.locatePasta ?? (() => "/usr/bin/pasta"),
    locateIp: overrides.locateIp ?? (() => "/usr/sbin/ip"),
    killGroup,
    hostAddresses: {
      current: () => overrides.hostAddresses ?? [],
      refresh: async () => undefined,
      publicState: () => overrides.publicState ?? "known",
    },
    nowMs: overrides.nowMs ?? (() => (nowValues.length > 1 ? (nowValues.shift() as number) : nowValues[0] as number)),
  });
  return { world, spawn, killGroup, children, dir, nowValues };
}

function context(signal?: AbortSignal): ToolContext {
  return { thread: "test", turnId: "t1", nowMs: 0, signal } as unknown as ToolContext;
}

function runTool(world: World): Tool {
  const tool = world.tools().find((candidate) => candidate.spec.name === "run");
  if (tool === undefined) throw new Error("no run tool");
  return tool;
}

/** Brings a fresh harness up as a started world on a Linux host. */
async function started(overrides: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = makeHarness(overrides);
  await h.world.start(() => undefined, privacyBody(dir));
  return h;
}

type KeptPicture = { bytes: Uint8Array; name: string; from: { world: string; place: string } };

/** A tiny PNG built from its signature and a few bytes. */
function pngBytes(extra = 8): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: extra }, (_, i) => i)]);
}

/** A body that keeps pictures the test can inspect, and checks privacy the way the runtime's body does. */
function pictureBody(kept: KeptPicture[]): WorldBody {
  const base = privacyBody(dir);
  return {
    keepPicture(input) {
      kept.push(input);
      return { id: "m-ABCD2345", mime: "image/png", bytes: input.bytes.length, name: input.name };
    },
    outwardHold: base.outwardHold,
  };
}

function toolNamed(world: World, name: string): Tool {
  const tool = world.tools().find((candidate) => candidate.spec.name === name);
  if (tool === undefined) throw new Error(`no ${name} tool`);
  return tool;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-sandbox-test-"));
  checkout = join(dir, "checkout");
  mkdirSync(checkout);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("start", () => {
  it("refuses a non-Linux host with a plain error and starts nothing", async () => {
    harness = makeHarness({ platform: "win32" });
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/runs on Linux only/);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses when bwrap is not found, naming the configured path when there is one", async () => {
    harness = makeHarness({ locate: () => undefined });
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/bwrap \(Bubblewrap\), and it was not found on PATH/);
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, bwrapPath: "/opt/bwrap" }, locate: () => undefined });
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/not found at \/opt\/bwrap/);
  });

  it("looks for the configured bwrap path", async () => {
    const locate = vi.fn(() => "/opt/bwrap");
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, bwrapPath: "/opt/bwrap" }, locate });
    await harness.world.start(() => undefined, privacyBody(dir));
    expect(locate).toHaveBeenCalledWith("/opt/bwrap");
  });
});

describe("the privacy list", () => {
  it("refuses a command that carries a listed term, and starts no process", async () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }));
    harness = await started();
    const receipt = await runTool(harness.world).run({ command: "echo 'the Lantern Yard gate'" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("held_privacy");
    expect(receipt.refused?.reason).toContain("(home)");
    expect(JSON.stringify(receipt)).not.toContain("Lantern");
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses every command while the privacy list cannot be read, and starts no process", async () => {
    writeFileSync(join(dir, "privacy.json"), "{ not json");
    harness = await started();
    const receipt = await runTool(harness.world).run({ command: "echo hi" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("privacy_unreadable");
    expect(receipt.refused?.reason).toBe(PRIVACY_UNREADABLE_REASON);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses a command when the world was started without the body's check, so the list is never skipped", async () => {
    harness = makeHarness();
    await harness.world.start(() => undefined);
    const receipt = await runTool(harness.world).run({ command: "echo hi" }, context());
    expect(receipt.refused?.code).toBe("not_started");
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});

describe("run: the command and the sandbox it runs in", () => {
  it("runs bwrap detached with the built argument list, and creates the home folder", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const [bwrap, args, options] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(bwrap).toBe("/usr/bin/bwrap");
    expect(args).toEqual(buildBwrapArgs({ homeDir: resolve(dir, "home"), command: "echo hi", bodyDir: checkout }));
    expect(options).toMatchObject({ detached: true, env: {} });
    expect(existsSync(join(dir, "home"))).toBe(true);
    // The entity folder itself is never an argument; only its home is.
    expect(args).not.toContain(resolve(dir));
    const child = harness.children[0] as FakeChild;
    child.emit("close", 0, null);
    await pending;
  });

  it("refuses to run before the world is started", async () => {
    harness = makeHarness();
    const receipt = await runTool(harness.world).run({ command: "echo hi" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("not_ready");
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses a missing, empty, too long or non-text command, and bad timeouts, without running anything", async () => {
    harness = await started();
    const tool = runTool(harness.world);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "bad_args"],
      [{ command: "   " }, "bad_args"],
      [{ command: "a".repeat(8_001) }, "bad_args"],
      [{ command: "echo\0" }, "bad_args"],
      [{ command: "ls", timeout_s: "soon" }, "bad_args"],
      [{ command: "ls", timeout_s: 0 }, "bad_args"],
      [{ command: "ls", timeout_s: -3 }, "bad_args"],
      [{ command: "ls", why: 5 }, "bad_args"],
    ];
    for (const [args, code] of cases) {
      const receipt = await tool.run(args, context());
      expect(receipt.ok).toBe(false);
      expect(receipt.refused?.code).toBe(code);
    }
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("uses the default timeout and caps a longer request at the maximum", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900 } });
    const tool = runTool(harness.world);
    const first = tool.run({ command: "true" }, context());
    (harness.children[0] as FakeChild).emit("close", 0, null);
    expect((await first).data?.["timeoutSeconds"]).toBe(120);
    const second = tool.run({ command: "true", timeout_s: 5000 }, context());
    (harness.children[1] as FakeChild).emit("close", 0, null);
    expect((await second).data?.["timeoutSeconds"]).toBe(900);
  });
});

describe("run: the receipt", () => {
  it("is ok on exit 0 and carries the output, exit code and duration", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    const child = harness.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("hi\n"));
    child.stderr.emit("data", Buffer.from("warn\n"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const receipt = await pending;
    expect(receipt.ok).toBe(true);
    expect(receipt.summary).toBe("The command finished in 2.5 s with exit code 0.");
    expect(receipt.data).toMatchObject({ exitCode: 0, durationMs: 2_500, timedOut: false, stdout: "hi\n", stderr: "warn\n" });
    expect(receipt.refused).toBeUndefined();
  });

  it("is ok:false with the exit code when the command fails", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "exit 2" }, context());
    const child = harness.children[0] as FakeChild;
    child.emit("exit", 2, null);
    child.emit("close", 2, null);
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.data?.["exitCode"]).toBe(2);
    expect(receipt.summary).toMatch(/exit code 2/);
    expect(receipt.refused).toBeUndefined();
  });

  it("reports a shell that could not start as a refusal", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    (harness.children[0] as FakeChild).emit("error", new Error("spawn bwrap ENOENT"));
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.refused).toEqual({ code: "spawn_failed", reason: "spawn bwrap ENOENT" });
  });

  it("reports a spawn that throws as a refusal", async () => {
    harness = await started({ spawnThrows: true });
    const receipt = await runTool(harness.world).run({ command: "echo hi" }, context());
    expect(receipt.refused?.code).toBe("spawn_failed");
  });

  it("keeps the head and tail of long output, with the count left out in the middle", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "make-noise" }, context());
    const child = harness.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("H".repeat(10_000)));
    child.stdout.emit("data", Buffer.from("T".repeat(10_000)));
    child.emit("close", 0, null);
    const stdout = (await pending).data?.["stdout"] as string;
    expect(stdout).toBe(`${"H".repeat(8_000)}\n…4000 characters left out…\n${"T".repeat(8_000)}`);
  });
});

describe("run: timeouts and the process group", () => {
  it("on timeout sends SIGTERM to the group, then SIGKILL after the grace, and says it timed out", async () => {
    vi.useFakeTimers();
    harness = await started({ config: { timeoutSeconds: 1, maxTimeoutSeconds: 900 } });
    const pending = runTool(harness.world).run({ command: "sleep 999" }, context());
    const child = harness.children[0] as FakeChild;

    vi.advanceTimersByTime(999);
    expect(harness.killGroup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(harness.killGroup).not.toHaveBeenCalledWith(4242, "SIGKILL");

    vi.advanceTimersByTime(2_000);
    expect(harness.killGroup).toHaveBeenLastCalledWith(4242, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    vi.advanceTimersByTime(500);

    const receipt: Receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.summary).toBe("The command ran past 1 seconds and was stopped.");
    expect(receipt.data).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGKILL" });
  });

  it("writes the receipt even when the group never reports an exit, after the grace has passed", async () => {
    vi.useFakeTimers();
    harness = await started({ config: { timeoutSeconds: 1, maxTimeoutSeconds: 900 } });
    const pending = runTool(harness.world).run({ command: "stuck" }, context());
    vi.advanceTimersByTime(1_000 + 2_000 + 500);
    const receipt = await pending;
    expect(receipt.data?.["timedOut"]).toBe(true);
    expect(harness.killGroup.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not time out a command that has already exited", async () => {
    vi.useFakeTimers();
    harness = await started({ config: { timeoutSeconds: 1, maxTimeoutSeconds: 900 } });
    const pending = runTool(harness.world).run({ command: "quick" }, context());
    const child = harness.children[0] as FakeChild;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const receipt = await pending;
    vi.advanceTimersByTime(10_000);
    expect(receipt.data?.["timedOut"]).toBe(false);
    expect(harness.killGroup).not.toHaveBeenCalled();
  });

  it("stops a command when the turn's signal is aborted", async () => {
    harness = await started();
    const controller = new AbortController();
    const pending = runTool(harness.world).run({ command: "sleep 999" }, context(controller.signal));
    controller.abort();
    expect(harness.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (harness.children[0] as FakeChild).emit("close", null, "SIGTERM");
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.data?.["stoppedBy"]).toBe("turn");
  });

  it("ends every running command when the summoner's stop turns on, and the receipt says the stop ended it", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "sleep 999" }, context());
    await harness.world.onStop?.();
    expect(harness.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (harness.children[0] as FakeChild).emit("close", null, "SIGTERM");
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.summary).toBe("The command was ended by your summoner's emergency stop.");
    expect(receipt.data?.["stoppedBy"]).toBe("stop");
  });

  it("kills running commands when the world stops, so none outlives the sandbox", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "sleep 999" }, context());
    await harness.world.stop();
    expect(harness.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (harness.children[0] as FakeChild).emit("close", null, "SIGTERM");
    const receipt = await pending;
    expect(receipt.data?.["stoppedBy"]).toBe("world");
    const after = await runTool(harness.world).run({ command: "echo" }, context());
    expect(after.refused?.code).toBe("not_ready");
  });
});

describe("run: output cap", () => {
  it("stops a command that prints more than the cap, and says so", async () => {
    harness = await started();
    const pending = runTool(harness.world).run({ command: "yes" }, context());
    const child = harness.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.alloc(OUTPUT_CAP_BYTES));
    expect(harness.killGroup).not.toHaveBeenCalled();
    child.stdout.emit("data", Buffer.alloc(1));
    expect(harness.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.summary).toBe("The command printed more than 2 MB and was stopped.");
    expect(receipt.data?.["stoppedBy"]).toBe("output");
    // The receipt still shows the head and tail of what was collected, capped like any other output.
    expect(receipt.data?.["stdout"] as string).toContain("characters left out");
  });
});

describe("now, about and say", () => {
  it("says the sandbox is not started, then reports the home folder's size", async () => {
    harness = makeHarness();
    expect(harness.world.now()).toBe("Sandbox: not started.");
    await harness.world.start(() => undefined, privacyBody(dir));
    expect(harness.world.now()).toBe("Sandbox: ready. Your home at /home/lar holds 0 bytes, in 0 files.");
    mkdirSync(join(dir, "home", "pkgs"), { recursive: true });
    writeFileSync(join(dir, "home", "pkgs", "a.txt"), "x".repeat(1_536));
    expect(harness.world.now()).toBe("Sandbox: ready. Your home at /home/lar holds 1.5 KB, in 1 file.");
    await harness.world.stop();
    expect(harness.world.now()).toBe("Sandbox: stopped.");
  });

  it("says in plain words what the sandbox is and where installs go", async () => {
    harness = makeHarness();
    const about = harness.world.about?.() ?? "";
    expect(about).toMatch(/Linux shell of your own, with network access/);
    expect(about).toMatch(/\/home\/lar keeps what you make; installs go there/);
  });

  it("offers run with command required, and keep_picture with a path required", async () => {
    harness = makeHarness();
    const tool = runTool(harness.world);
    expect(tool.spec.parameters).toMatchObject({ required: ["command"] });
    expect(tool.spec.safeWhenStopped).toBeUndefined();
    expect(harness.world.tools().map((item) => item.spec.name)).toEqual(["run", "keep_picture", "run_background", "check_job", "stop_job"]);
    expect(toolNamed(harness.world, "keep_picture").spec.parameters).toMatchObject({ required: ["path"] });
    expect(toolNamed(harness.world, "run_background").spec.description).toContain("At most 2 at once.");
  });

  it("refuses to say anything to a place, since the sandbox has none", async () => {
    harness = makeHarness();
    const receipt = await harness.world.say("sandbox:anywhere", "hello");
    expect(receipt).toMatchObject({ ok: false, refused: { code: "no_place" } });
  });
});

describe("background jobs", () => {
  /** Starts a world that records its events, with the job ceilings the test asks for. */
  async function jobWorld(
    overrides: { nowMs?: () => number } & Partial<SandboxConfigOverride> = {},
  ): Promise<{ world: World; spawn: ReturnType<typeof vi.fn>; killGroup: ReturnType<typeof vi.fn>; children: FakeChild[]; events: WorldEvent[] }> {
    const { nowMs, ...config } = overrides;
    const h = makeHarness({
      config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "host", ...config },
      ...(nowMs === undefined ? {} : { nowMs }),
    });
    const events: WorldEvent[] = [];
    await h.world.start((event) => events.push(event), privacyBody(dir));
    return { world: h.world, spawn: h.spawn, killGroup: h.killGroup, children: h.children, events };
  }

  function tool(world: World, name: string): Tool {
    return toolNamed(world, name);
  }

  it("starts a job in the sandbox and names the log it writes", async () => {
    const j = await jobWorld();
    const receipt = await tool(j.world, "run_background").run({ command: "sleep 60", why: "a slow build" }, context());
    expect(receipt.ok).toBe(true);
    expect(receipt.summary).toBe("Started job j1. Its output goes to /home/lar/.natalis-jobs/j1.log.");
    expect(receipt.data).toEqual({ id: "j1", log: "/home/lar/.natalis-jobs/j1.log" });
    const [program, args, options] = j.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(program).toBe("/usr/bin/bwrap");
    expect(args).toEqual(buildBwrapArgs({ homeDir: resolve(dir, "home"), command: "sleep 60", bodyDir: checkout }));
    expect(options).toMatchObject({ detached: true, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    expect(existsSync(join(dir, "home", ".natalis-jobs", "j1.log"))).toBe(true);
  });

  it("tells the Lar's own thread once when the job ends, with its exit code and last lines", async () => {
    const j = await jobWorld();
    await tool(j.world, "run_background").run({ command: "make", why: "a slow build" }, context());
    const child = j.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("first line\n"));
    child.stderr.emit("data", Buffer.from("last line\n"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await vi.waitFor(() => expect(j.events).toHaveLength(1));
    const event = j.events[0]!;
    expect(event).toMatchObject({ world: "sandbox", place: "sandbox:jobs", thread: "self", source: "body" });
    expect(event.text).toContain("Your background job j1 (a slow build) ended with exit code 0 after 2.5 s.");
    expect(event.text).toContain("Its last lines:");
    expect(event.text).toContain("first line");
    expect(event.text).toContain("last line");
    expect(event.data).toEqual({ job: "j1", exitCode: 0, seconds: 2.5 });
  });

  it("checks a job while it runs and after it ends", async () => {
    const j = await jobWorld();
    const check = tool(j.world, "check_job");
    await tool(j.world, "run_background").run({ command: "sleep 60", why: "a crawl" }, context());
    const child = j.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("working\n"));
    const running = await check.run({ id: "j1" }, context());
    expect(running.ok).toBe(true);
    expect(running.data).toMatchObject({ id: "j1", running: true, exitCode: null, tail: "working\n" });
    expect(running.summary).toContain("still running");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const ended = await check.run({ id: "j1" }, context());
    expect(ended.data).toMatchObject({ running: false, exitCode: 0 });
    expect(ended.summary).toContain("ended with exit code 0");
  });

  it("answers an unknown job with not_found, naming the jobs that exist", async () => {
    const j = await jobWorld();
    const receipt = await tool(j.world, "check_job").run({ id: "j9" }, context());
    expect(receipt.refused?.code).toBe("not_found");
    expect(receipt.summary).toContain("No background job has run.");
    await tool(j.world, "run_background").run({ command: "sleep 60", why: "a crawl" }, context());
    expect((await tool(j.world, "check_job").run({ id: "j9" }, context())).summary).toContain("The jobs are j1.");
  });

  it("stops a job's process group, and its end says it was stopped", async () => {
    const j = await jobWorld();
    await tool(j.world, "run_background").run({ command: "sleep 999", why: "a crawl" }, context());
    const stopped = tool(j.world, "stop_job").run({ id: "j1", why: "no longer needed" }, context());
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (j.children[0] as FakeChild).emit("close", null, "SIGTERM");
    const receipt = await stopped;
    expect(receipt.ok).toBe(true);
    await vi.waitFor(() => expect(j.events).toHaveLength(1));
    expect(j.events[0]?.text).toContain("It was stopped.");
    expect(j.events[0]?.data).toMatchObject({ job: "j1", stopped: true });
  });

  it("kills a job that runs past its ceiling and says how long it got", async () => {
    vi.useFakeTimers();
    const j = await jobWorld({ maxJobMinutes: 1 });
    await tool(j.world, "run_background").run({ command: "sleep 999", why: "a crawl" }, context());
    vi.advanceTimersByTime(59_000);
    expect(j.killGroup).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (j.children[0] as FakeChild).emit("exit", null, "SIGTERM");
    (j.children[0] as FakeChild).emit("close", null, "SIGTERM");
    expect(j.events).toHaveLength(1);
    expect(j.events[0]?.text).toContain("It ran out of time (1 min).");
    expect(j.events[0]?.data).toMatchObject({ job: "j1", timedOut: true });
  });

  it("caps max_minutes at the world's ceiling, and takes a shorter one as given", async () => {
    vi.useFakeTimers();
    const j = await jobWorld({ maxJobMinutes: 2 });
    const start = tool(j.world, "run_background");
    await start.run({ command: "a", why: "one", max_minutes: 5000 }, context());
    vi.advanceTimersByTime(2 * 60_000);
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (j.children[0] as FakeChild).emit("close", null, "SIGTERM");
    expect(j.events[0]?.data).toMatchObject({ timedOut: true });
    expect(j.events[0]?.text).toContain("It ran out of time (2 min).");
    j.killGroup.mockClear();
    await start.run({ command: "b", why: "two", max_minutes: 1 }, context());
    vi.advanceTimersByTime(60_000);
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("refuses a third job when two are running, and names the two", async () => {
    const j = await jobWorld({ maxBackgroundJobs: 2 });
    const start = tool(j.world, "run_background");
    expect((await start.run({ command: "a", why: "one" }, context())).ok).toBe(true);
    expect((await start.run({ command: "b", why: "two" }, context())).ok).toBe(true);
    const third = await start.run({ command: "c", why: "three" }, context());
    expect(third.refused?.code).toBe("too_many_jobs");
    expect(third.summary).toContain("j1, j2");
    (j.children[0] as FakeChild).emit("close", 0, null);
    const again = await start.run({ command: "c", why: "three" }, context());
    expect(again.ok).toBe(true);
    expect(again.data?.["id"]).toBe("j3");
  });

  it("cuts the log at 2 MiB once and keeps the job running", async () => {
    const j = await jobWorld();
    await tool(j.world, "run_background").run({ command: "make", why: "a slow build" }, context());
    const child = j.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.alloc(JOB_LOG_CAP_BYTES));
    child.stdout.emit("data", Buffer.from("more\n"));
    child.stdout.emit("data", Buffer.from("still more\n"));
    const check = await tool(j.world, "check_job").run({ id: "j1" }, context());
    expect(check.data?.["running"]).toBe(true);
    expect((check.data?.["tail"] as string).split(JOB_CUT_LINE)).toHaveLength(2);
    expect(check.data?.["tail"] as string).toContain(JOB_CUT_LINE);
  });

  it("kills running jobs when the world stops, and reports each end", async () => {
    const j = await jobWorld();
    await tool(j.world, "run_background").run({ command: "sleep 999", why: "a crawl" }, context());
    const stopping = j.world.stop();
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    (j.children[0] as FakeChild).emit("close", null, "SIGTERM");
    await stopping;
    expect(j.events).toHaveLength(1);
  });

  it("kills running jobs at the summoner's stop, and waits at most five seconds for them", async () => {
    vi.useFakeTimers();
    const j = await jobWorld();
    await tool(j.world, "run_background").run({ command: "sleep 999", why: "a crawl" }, context());
    const stopping = j.world.onStop?.() ?? Promise.resolve();
    expect(j.killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
    // The group never reports an exit: the world still returns once its wait is up.
    vi.advanceTimersByTime(5_000);
    await stopping;
    expect(j.events).toHaveLength(1);
    expect(j.events[0]?.text).toContain("It was stopped.");
  });

  it("names a running job on the now board", async () => {
    let clock = 0;
    const j = await jobWorld({ nowMs: () => clock });
    await tool(j.world, "run_background").run({ command: "sleep 999", why: "a long crawl" }, context());
    clock = 12 * 60_000;
    expect(j.world.now()).toContain("Background jobs running: j1 (12 min, a long crawl).");
    (j.children[0] as FakeChild).emit("close", 0, null);
    expect(j.events).toHaveLength(1);
    expect(j.world.now()).not.toContain("Background jobs running");
  });

  it("refuses to start a job before the world is started, and on bad arguments", async () => {
    const world = makeHarness().world;
    expect((await tool(world, "run_background").run({ command: "a", why: "b" }, context())).refused?.code).toBe("not_ready");
    const j = await jobWorld();
    const start = tool(j.world, "run_background");
    for (const args of [{ why: "b" }, { command: "a" }, { command: "a", why: "" }, { command: "a", why: "b", max_minutes: 0 }]) {
      expect((await start.run(args, context())).refused?.code).toBe("bad_arguments");
    }
    expect(j.spawn).not.toHaveBeenCalled();
  });

  it("refuses a job whose command carries a listed term, and starts nothing", async () => {
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "Lantern Yard", category: "home" }] }));
    const j = await jobWorld();
    const receipt = await tool(j.world, "run_background").run({ command: "echo 'the Lantern Yard gate'", why: "a test" }, context());
    expect(receipt.refused?.code).toBe("held_privacy");
    expect(j.spawn).not.toHaveBeenCalled();
  });
});

describe("keep_picture", () => {
  /** Starts a world whose body records what it keeps, and returns the tool with the kept list. */
  async function pictureWorld(): Promise<{ tool: Tool; kept: KeptPicture[] }> {
    const kept: KeptPicture[] = [];
    const world = makeHarness().world;
    await world.start(() => undefined, pictureBody(kept));
    return { tool: toolNamed(world, "keep_picture"), kept };
  }

  function homeFile(name: string, bytes: Uint8Array | string): string {
    const folder = join(dir, "home", "plots");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, bytes);
    return path;
  }

  it("keeps a PNG from the home folder and names the id it was kept under", async () => {
    const { tool, kept } = await pictureWorld();
    homeFile("week.png", pngBytes());
    const receipt = await tool.run({ path: "plots/week.png" }, context());
    expect(receipt.ok).toBe(true);
    expect(receipt.summary).toBe("Kept week.png on your shelf as m-ABCD2345. look shows it; say's attach sends it.");
    expect(receipt.data).toMatchObject({ id: "m-ABCD2345", name: "week.png", bytes: 16 });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.from).toEqual({ world: "sandbox", place: "sandbox:home" });
    expect(kept[0]?.name).toBe("week.png");
    expect(Array.from(kept[0]?.bytes ?? [])).toEqual(Array.from(pngBytes()));
  });

  it("resolves a path given with the sandbox home at its front the same way", async () => {
    const { tool, kept } = await pictureWorld();
    homeFile("x.png", pngBytes());
    const receipt = await tool.run({ path: "/home/lar/plots/x.png" }, context());
    expect(receipt.ok).toBe(true);
    expect(kept[0]?.name).toBe("x.png");
  });

  it("keeps a picture under the name it is given", async () => {
    const { tool, kept } = await pictureWorld();
    homeFile("x.png", pngBytes());
    const receipt = await tool.run({ path: "plots/x.png", name: "last week" }, context());
    expect(receipt.summary).toContain("Kept last week on your shelf");
    expect(kept[0]?.name).toBe("last week");
  });

  it("refuses a text file as not a picture", async () => {
    const { tool, kept } = await pictureWorld();
    homeFile("notes.txt", "these are words\n");
    const receipt = await tool.run({ path: "plots/notes.txt" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("not_a_picture");
    expect(receipt.summary).toBe("plots/notes.txt is not a PNG, JPEG, GIF or WebP picture.");
    expect(kept).toEqual([]);
  });

  it("refuses a path that climbs out of the home, and any other absolute path", async () => {
    const { tool, kept } = await pictureWorld();
    homeFile("x.png", pngBytes());
    for (const path of ["../x.png", "plots/../../x.png", "/etc/x.png", "/home/lar/../x.png", "/home/lar"]) {
      const receipt = await tool.run({ path }, context());
      expect(receipt.ok).toBe(false);
      expect(receipt.refused?.code).toBe("bad_arguments");
    }
    expect(kept).toEqual([]);
  });

  it("refuses a missing file and a folder", async () => {
    const { tool } = await pictureWorld();
    const missing = await tool.run({ path: "plots/gone.png" }, context());
    expect(missing.refused?.code).toBe("not_found");
    mkdirSync(join(dir, "home", "plots", "folder.png"), { recursive: true });
    const folder = await tool.run({ path: "plots/folder.png" }, context());
    expect(folder.refused?.code).toBe("not_a_file");
  });

  it("refuses a file over 8 MiB", async () => {
    const { tool, kept } = await pictureWorld();
    const big = Buffer.alloc(PICTURE_BYTES_MAX + 1);
    pngBytes().forEach((byte, index) => (big[index] = byte));
    homeFile("huge.png", big);
    const receipt = await tool.run({ path: "plots/huge.png" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("too_big");
    expect(kept).toEqual([]);
  });

  it("refuses before the world is started", async () => {
    const tool = toolNamed(makeHarness().world, "keep_picture");
    const receipt = await tool.run({ path: "plots/x.png" }, context());
    expect(receipt.refused?.code).toBe("not_started");
  });

  it.skipIf(process.platform === "win32")("refuses a symlink that points outside the home", async () => {
    const { tool, kept } = await pictureWorld();
    mkdirSync(join(dir, "home"), { recursive: true });
    const outside = join(dir, "outside.png");
    writeFileSync(outside, pngBytes());
    symlinkSync(outside, join(dir, "home", "link.png"));
    const receipt = await tool.run({ path: "link.png" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("not_a_file");
    expect(kept).toEqual([]);
  });
});

describe("measureHome and formatBytes", () => {
  it("counts files and bytes under a folder, and says nothing is there when it is missing", () => {
    expect(measureHome(join(dir, "missing"))).toEqual({ bytes: 0, files: 0, complete: true });
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "one.txt"), "12345");
    writeFileSync(join(dir, "a", "b", "two.txt"), "123");
    expect(measureHome(dir)).toEqual({ bytes: 8, files: 2, complete: true });
  });

  it("stops the walk after its entry limit and says the count is approximate", () => {
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 2_050; i += 1) writeFileSync(join(dir, "many", `f${i}`), "");
    const size = measureHome(dir);
    expect(size.complete).toBe(false);
    expect(size.files).toBeLessThanOrEqual(2_000);
  });

  it("formats sizes in plain units", () => {
    expect(formatBytes(12)).toBe("12 bytes");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("the body: the allow-listed parts of the checkout bound read-only at /body", () => {
  it("binds only the allow-listed names read-only at /body, and never the checkout writable", async () => {
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "not-listed.txt"), "not for the sandbox\n");
    harness = await started();
    const pending = runTool(harness.world).run({ command: "ls /body" }, context());
    const [, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    const at = args.indexOf(`${checkout}/src`);
    expect(args.slice(at - 1, at + 2)).toEqual(["--ro-bind-try", `${checkout}/src`, "/body/src"]);
    expect(args).not.toContain(`${checkout}/not-listed.txt`);
    expect(args).not.toContain(checkout);
    expect(args.some((arg, index) => arg === "--bind" && String(args[index + 1]).startsWith(checkout))).toBe(false);
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("leaves /body out of the sandbox when sandbox.json says body false", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, body: false } });
    const pending = runTool(harness.world).run({ command: "true" }, context());
    const [, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).not.toContain("/body");
    expect(args).not.toContain(checkout);
    expect(harness.world.about()).not.toContain("/body");
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("says in about() where the source is, and that it is read-only, when it is bound", async () => {
    harness = await started();
    expect(harness.world.about()).toContain("Your own source is at /body, read-only.");
  });

  it("refuses to start, and names the folder and file, when an allow-listed folder holds an env file", async () => {
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "prod.env"), "placeholder\n");
    harness = makeHarness();
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/src holds prod\.env/);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses to start when an allow-listed folder holds a vault folder", async () => {
    mkdirSync(join(checkout, "docs", "vault"), { recursive: true });
    harness = makeHarness();
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/vault folder/);
  });

  it("refuses to start when the Lar's folder lies inside the checkout", async () => {
    harness = makeHarness({ bodyDir: dir });
    await expect(harness.world.start(() => undefined, privacyBody(dir))).rejects.toThrow(/inside/);
  });

  it("starts when an allow-listed folder holds an env file but the body is off", async () => {
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", ".env"), "placeholder\n");
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, body: false } });
    await expect(harness.world.start(() => undefined, privacyBody(dir))).resolves.toBeUndefined();
  });
});

describe("the network: wall (the default), host, or none", () => {
  const resolvFile = (): string => join(dir, "sandbox-network", "resolv.conf");

  it("runs pasta around bwrap in wall mode, and bwrap keeps the network pasta made", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" } });
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const [program, args, options] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(program).toBe("/usr/bin/pasta");
    const bwrapArgs = buildBwrapArgs({
      homeDir: resolve(dir, "home"),
      command: "echo hi",
      bodyDir: checkout,
      network: "wall",
      resolvPath: resolvFile(),
    });
    expect(args).toEqual([
      ...PASTA_ARGS,
      "--",
      "/bin/sh",
      "-c",
      `${routeScript("/usr/sbin/ip")}; exec "$@"`,
      "sh",
      "/usr/bin/bwrap",
      ...bwrapArgs,
    ]);
    expect(bwrapArgs).toContain("--share-net");
    expect(options).toMatchObject({ detached: true, env: {} });
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("looks the public address up at start when the network is left to its default, the wall (AU NOTE-2)", async () => {
    let refreshes = 0;
    const world = createSandboxWorld({
      dir,
      config: { timeoutSeconds: 120, maxTimeoutSeconds: 900 },
      bodyDir: checkout,
      spawn: vi.fn() as unknown as SpawnFn,
      platform: "linux",
      locateBwrap: () => "/usr/bin/bwrap",
      locatePasta: () => "/usr/bin/pasta",
      locateIp: () => "/usr/sbin/ip",
      killGroup: vi.fn(),
      hostAddresses: { current: () => [], refresh: async () => void (refreshes += 1), publicState: () => "known" },
    });
    await world.start(() => undefined, privacyBody(dir));
    expect(refreshes).toBe(1);
  });

  it("refuses a wall-mode command while the host's public address is unknown (AU NB-1)", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" }, publicState: "unknown" });
    const receipt = await runTool(harness.world).run({ command: "echo hi" }, context());
    expect(receipt.refused?.code).toBe("network_not_walled");
    expect(receipt.refused?.reason).toContain("public");
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("still runs a host-network command while the public address is unknown", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "host" }, publicState: "unknown" });
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("walls the host's own addresses, looked up when the command runs (OPENVULN wall highs)", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" }, hostAddresses: ["203.0.113.7", "203.0.113.1"] });
    const pending = runTool(harness.world).run({ command: "echo hi" }, context());
    const [, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toContain(`${routeScript("/usr/sbin/ip", ["203.0.113.7", "203.0.113.1"])}; exec "$@"`);
    expect(args.join(" ")).toContain("route add unreachable 203.0.113.7/32");
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("writes the resolver file once at start, naming the wall's DNS address, and binds it in place of the host's", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" } });
    expect(readFileSync(resolvFile(), "utf8")).toBe("nameserver 192.0.2.3\n");
    const pending = runTool(harness.world).run({ command: "true" }, context());
    const [, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    const at = args.indexOf("/etc/resolv.conf");
    expect(args.slice(at - 2, at + 1)).toEqual(["--ro-bind", resolvFile(), "/etc/resolv.conf"]);
    expect(args.join(" ")).not.toContain("--ro-bind-try /etc/resolv.conf /etc/resolv.conf");
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("refuses the command, plainly and without running it, when pasta is not installed", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" }, locatePasta: () => undefined });
    const receipt = await runTool(harness.world).run({ command: "curl example.invalid" }, context());
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("network_not_walled");
    expect(receipt.summary).toContain("pasta (the passt package)");
    expect(receipt.summary).toContain("passt package");
    expect(receipt.summary).toContain('"network": "host"');
    expect(receipt.refused?.reason).toBe("not found: pasta (the passt package)");
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses the command when ip is not installed, and names ip", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" }, locateIp: () => undefined });
    const receipt = await runTool(harness.world).run({ command: "true" }, context());
    expect(receipt.refused?.code).toBe("network_not_walled");
    expect(receipt.refused?.reason).toBe("not found: ip (iproute2)");
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("looks for the configured pasta and ip paths", async () => {
    const locatePasta = vi.fn(() => "/opt/pasta");
    const locateIp = vi.fn(() => "/opt/ip");
    harness = await started({
      config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall", pastaPath: "/opt/pasta", ipPath: "/opt/ip" },
      locatePasta,
      locateIp,
    });
    const pending = runTool(harness.world).run({ command: "true" }, context());
    expect(locatePasta).toHaveBeenCalledWith("/opt/pasta");
    expect(locateIp).toHaveBeenCalledWith("/opt/ip");
    const [program, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(program).toBe("/opt/pasta");
    expect(args).toContain(`${routeScript("/opt/ip")}; exec "$@"`);
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("runs bwrap directly in host mode, as before the wall, with the host's network", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "host" } });
    const pending = runTool(harness.world).run({ command: "true" }, context());
    const [program, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(program).toBe("/usr/bin/bwrap");
    expect(args).toContain("--share-net");
    expect(args).toEqual(buildBwrapArgs({ homeDir: resolve(dir, "home"), command: "true", bodyDir: checkout }));
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("runs bwrap directly in none mode, with loopback only: no pasta and no --share-net", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "none" }, locatePasta: () => undefined });
    const pending = runTool(harness.world).run({ command: "true" }, context());
    const [program, args] = harness.spawn.mock.calls[0] as [string, string[], SpawnOptions];
    expect(program).toBe("/usr/bin/bwrap");
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
    expect(args).toEqual(buildBwrapArgs({ homeDir: resolve(dir, "home"), command: "true", bodyDir: checkout, network: "none" }));
    (harness.children[0] as FakeChild).emit("close", 0, null);
    await pending;
  });

  it("says in about() what the network reaches, in each mode", async () => {
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "wall" } });
    expect(harness.world.about()).toContain("reaches the internet, but not this host's own services");
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "none" } });
    expect(harness.world.about()).toContain("with no network");
    harness = await started({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, network: "host" } });
    expect(harness.world.about()).toContain("with network access");
    expect(harness.world.about()).not.toContain("reaches the internet");
  });
});
