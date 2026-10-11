import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receipt, Tool, ToolContext, World } from "../../contracts.js";
import { buildBwrapArgs } from "./bwrap.js";
import { PASTA_ARGS, routeScript } from "./wall.js";
import { createSandboxWorld, formatBytes, measureHome, type SpawnFn } from "./sandbox-world.js";
import { OUTPUT_CAP_BYTES } from "./output.js";

type SandboxConfigOverride = {
  timeoutSeconds: number;
  maxTimeoutSeconds: number;
  bwrapPath?: string;
  body?: boolean;
  network?: "wall" | "host" | "none";
  pastaPath?: string;
  ipPath?: string;
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
    nowMs: () => (nowValues.length > 1 ? (nowValues.shift() as number) : nowValues[0] as number),
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
  await h.world.start(() => undefined);
  return h;
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
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/runs on Linux only/);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses when bwrap is not found, naming the configured path when there is one", async () => {
    harness = makeHarness({ locate: () => undefined });
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/bwrap \(Bubblewrap\), and it was not found on PATH/);
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, bwrapPath: "/opt/bwrap" }, locate: () => undefined });
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/not found at \/opt\/bwrap/);
  });

  it("looks for the configured bwrap path", async () => {
    const locate = vi.fn(() => "/opt/bwrap");
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, bwrapPath: "/opt/bwrap" }, locate });
    await harness.world.start(() => undefined);
    expect(locate).toHaveBeenCalledWith("/opt/bwrap");
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
    await harness.world.start(() => undefined);
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

  it("offers one tool, run, with command required", async () => {
    harness = makeHarness();
    const tool = runTool(harness.world);
    expect(tool.spec.parameters).toMatchObject({ required: ["command"] });
    expect(tool.spec.safeWhenStopped).toBeUndefined();
  });

  it("refuses to say anything to a place, since the sandbox has none", async () => {
    harness = makeHarness();
    const receipt = await harness.world.say("sandbox:anywhere", "hello");
    expect(receipt).toMatchObject({ ok: false, refused: { code: "no_place" } });
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
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/src holds prod\.env/);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("refuses to start when an allow-listed folder holds a vault folder", async () => {
    mkdirSync(join(checkout, "docs", "vault"), { recursive: true });
    harness = makeHarness();
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/vault folder/);
  });

  it("refuses to start when the Lar's folder lies inside the checkout", async () => {
    harness = makeHarness({ bodyDir: dir });
    await expect(harness.world.start(() => undefined)).rejects.toThrow(/inside/);
  });

  it("starts when an allow-listed folder holds an env file but the body is off", async () => {
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", ".env"), "placeholder\n");
    harness = makeHarness({ config: { timeoutSeconds: 120, maxTimeoutSeconds: 900, body: false } });
    await expect(harness.world.start(() => undefined)).resolves.toBeUndefined();
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
