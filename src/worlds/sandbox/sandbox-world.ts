// The sandbox world: a Linux shell of the Lar's own, run in Bubblewrap, with network. The Lar runs commands with
// `run`. The body builds the sandbox, starts each job, stops it on timeout and reports what came out. What to run
// and what to do with the output are the Lar's own judgment.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Receipt, Tool, ToolContext, World } from "../../contracts.js";
import { BODY_MOUNT, bodyRefusal, defaultBodyRoot } from "./body.js";
import { buildBwrapArgs, SANDBOX_HOME } from "./bwrap.js";
import type { SandboxSettings } from "./config.js";
import { OUTPUT_CAP_BYTES, OutputCollector } from "./output.js";

export const SANDBOX_WORLD_ID = "sandbox";

/** Characters allowed in one command. */
const MAX_COMMAND_CHARS = 8_000;
/** After SIGTERM, how long a job gets before the whole group is killed. */
const KILL_GRACE_MS = 2_000;
/** After the process has exited, how long its output may still arrive before the receipt is written. */
const STDIO_GRACE_MS = 500;
/** The home walk stops after this many entries, so the now board never blocks for long. */
const HOME_WALK_ENTRIES = 2_000;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type SandboxWorldOptions = {
  /** The entity folder. Its `home` subfolder becomes the Lar's home inside the sandbox. */
  dir: string;
  config: SandboxSettings;
  /** Runs bwrap. Injected in tests; node's spawn is used when absent. */
  spawn?: SpawnFn;
  /** The host platform. Defaults to this one. The sandbox runs on Linux only. */
  platform?: NodeJS.Platform;
  nowMs?: () => number;
  /** Finds bwrap: the configured path, or a search of PATH. Injected in tests. */
  locateBwrap?: (configuredPath: string | undefined) => string | undefined;
  /** Signals a whole process group. Injected in tests, so no real process is ever signalled by a test. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * The Natalis checkout bound read-only at /body, unless config.body is false. Defaults to the package root this code
   * runs from. Injected in tests.
   */
  bodyDir?: string;
};

type Status = "idle" | "ready" | "stopped";

/** Why a command was stopped by the body, if it was. */
type StoppedBy = "timeout" | "output" | "turn" | "world" | "stop";

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone. Nothing is left to stop.
  }
}

/** The configured path if it exists (a bare name is searched on PATH), else the first match on PATH. */
export function findBwrap(configuredPath: string | undefined): string | undefined {
  if (configuredPath !== undefined) {
    const candidate = configuredPath.includes("/") || isAbsolute(configuredPath) ? resolve(configuredPath) : undefined;
    if (candidate !== undefined) return existsSync(candidate) ? candidate : undefined;
  }
  const name = configuredPath ?? "bwrap";
  for (const folder of (process.env["PATH"] ?? "").split(delimiter)) {
    if (folder === "") continue;
    const candidate = join(folder, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The entries of a folder. A missing or unreadable folder has none. */
function listFolder(folder: string) {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Counts the files and bytes under the home folder, without following links, and stops after a few thousand entries. */
export function measureHome(root: string): { bytes: number; files: number; complete: boolean } {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const pending = [root];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of listFolder(folder)) {
      if (seen >= HOME_WALK_ENTRIES) return { bytes, files, complete: false };
      seen += 1;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += lstatSync(path).size;
        } catch {
          // Gone between the listing and the size: skip it.
        }
      }
    }
  }
  return { bytes, files, complete: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function refusal(code: string, summary: string, reason: string): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

export function createSandboxWorld(options: SandboxWorldOptions): World {
  const { config } = options;
  const homeDir = resolve(options.dir, "home");
  const spawnProcess: SpawnFn = options.spawn ?? defaultSpawn;
  const platform = options.platform ?? process.platform;
  const nowMs = options.nowMs ?? (() => Date.now());
  const locate = options.locateBwrap ?? findBwrap;
  const killGroup = options.killGroup ?? defaultKillGroup;
  const bodyRoot = options.bodyDir ?? defaultBodyRoot();
  // The default root is looked up once here; the refusal is checked at start, when the bind is decided.

  let status: Status = "idle";
  let bwrapPath: string | undefined;
  /** The checkout bound at /body for this run of the world, when it is bound. */
  let bodyPath: string | undefined;
  /** Commands in flight, each with the function that ends it. */
  const running = new Map<ChildProcess, (stoppedBy: StoppedBy) => void>();

  /** Runs one argument list in bwrap and resolves with the receipt when the job has ended. */
  function execute(bwrap: string, argv: string[], timeoutSeconds: number, signal: AbortSignal | undefined): Promise<Receipt> {
    const started = nowMs();
    return new Promise<Receipt>((resolveReceipt) => {
      const stdout = new OutputCollector();
      const stderr = new OutputCollector();
      const timers: ReturnType<typeof setTimeout>[] = [];
      let child: ChildProcess;
      let exited = false;
      let exitCode: number | null = null;
      let signalName: NodeJS.Signals | null = null;
      let spawnError: string | undefined;
      let stoppedBy: StoppedBy | undefined;
      let terminating = false;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        running.delete(child);
        resolveReceipt(receiptFor());
      };

      // Stop the job: SIGTERM to the whole group, then SIGKILL to the group after a short grace. The receipt is
      // written once the process has exited, or at the latest after both steps have had time to run.
      const terminate = (reason: StoppedBy): void => {
        if (terminating || exited) return;
        terminating = true;
        stoppedBy = reason;
        if (child.pid !== undefined) killGroup(child.pid, "SIGTERM");
        timers.push(
          setTimeout(() => {
            if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
          }, KILL_GRACE_MS),
        );
        timers.push(setTimeout(finish, KILL_GRACE_MS + STDIO_GRACE_MS));
      };

      const onAbort = (): void => terminate("turn");

      const receiptFor = (): Receipt => {
        const durationMs = nowMs() - started;
        if (spawnError !== undefined) {
          return refusal("spawn_failed", "The sandbox could not start the shell, so the command did not run.", spawnError);
        }
        const outText = stdout.text();
        const errText = stderr.text();
        const seconds = (durationMs / 1000).toFixed(1);
        const ok = stoppedBy === undefined && exitCode === 0;
        let summary: string;
        if (stoppedBy === "timeout") summary = `The command ran past ${timeoutSeconds} seconds and was stopped.`;
        else if (stoppedBy === "output") summary = `The command printed more than ${OUTPUT_CAP_BYTES / (1024 * 1024)} MB and was stopped.`;
        else if (stoppedBy === "turn") summary = "The command was stopped because the turn ended.";
        else if (stoppedBy === "world") summary = "The command was stopped because the sandbox closed.";
        else if (stoppedBy === "stop") summary = "The command was ended by your summoner's emergency stop.";
        else if (exitCode === 0) summary = `The command finished in ${seconds} s with exit code 0.`;
        else {
          const by = signalName === null ? "" : ` (ended by ${signalName})`;
          summary = `The command finished in ${seconds} s with exit code ${exitCode ?? "none"}${by}.`;
        }
        return {
          ok,
          summary,
          data: {
            exitCode,
            signal: signalName,
            durationMs,
            timedOut: stoppedBy === "timeout",
            timeoutSeconds,
            ...(stoppedBy !== undefined ? { stoppedBy } : {}),
            stdout: outText,
            stderr: errText,
          },
        };
      };

      try {
        child = spawnProcess(bwrap, argv, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {},
          windowsHide: true,
        });
      } catch (err) {
        resolveReceipt(refusal("spawn_failed", "The sandbox could not start the shell, so the command did not run.", errorText(err)));
        return;
      }
      running.set(child, terminate);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!stdout.push(chunk)) terminate("output");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!stderr.push(chunk)) terminate("output");
      });
      child.on("error", (err: Error) => {
        spawnError = err.message;
        finish();
      });
      child.on("exit", (code: number | null, sig: NodeJS.Signals | null) => {
        exited = true;
        exitCode = code;
        signalName = sig;
        timers.push(setTimeout(finish, STDIO_GRACE_MS));
      });
      child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
        if (!exited) {
          exitCode = code;
          signalName = sig;
        }
        finish();
      });
      timers.push(
        setTimeout(() => {
          if (!exited) terminate("timeout");
        }, timeoutSeconds * 1000),
      );
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async function runCommand(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
    if (status !== "ready" || bwrapPath === undefined) {
      return refusal("not_ready", "The sandbox is not running, so the command did not run.", "The sandbox world is not started on this host.");
    }
    const command = args["command"];
    if (typeof command !== "string" || command.trim() === "") {
      return refusal("bad_args", "command must be a non-empty string.", "The command is missing.");
    }
    if (command.length > MAX_COMMAND_CHARS || command.includes("\0")) {
      return refusal("bad_args", `command must be at most ${MAX_COMMAND_CHARS} characters of text.`, "The command is too long or is not text.");
    }
    const requested = args["timeout_s"];
    if (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)) {
      return refusal("bad_args", "timeout_s must be a positive number of seconds.", "The timeout is not a number of seconds.");
    }
    const why = args["why"];
    if (why !== undefined && typeof why !== "string") {
      return refusal("bad_args", "why must be text.", "The why is not text.");
    }
    const timeoutSeconds = Math.min(requested ?? config.timeoutSeconds, config.maxTimeoutSeconds);
    if (context.signal?.aborted) {
      return refusal("stopped", "The turn ended before the command started.", "The turn was stopped first.");
    }
    try {
      mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return refusal("home_unavailable", "Your home folder could not be made, so the command did not run.", errorText(err));
    }
    const argv = buildBwrapArgs({ homeDir, command, ...(bodyPath === undefined ? {} : { bodyDir: bodyPath }) });
    return execute(bwrapPath, argv, timeoutSeconds, context.signal);
  }

  const runTool: Tool = {
    spec: {
      name: "run",
      description:
        `Run a command in your own Linux shell (bash), with network access. Your home folder ${SANDBOX_HOME} keeps what you make; ` +
        `installs go there. A command runs at most ${config.maxTimeoutSeconds} seconds; the default is ${config.timeoutSeconds}. ` +
        "Long output is cut to its head and tail.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run, as you would type it in bash." },
          timeout_s: {
            type: "number",
            minimum: 1,
            description: `Seconds before the command is stopped. Defaults to ${config.timeoutSeconds}; capped at ${config.maxTimeoutSeconds}.`,
          },
          why: { type: "string", description: "Why you are running it, in a few words." },
        },
        required: ["command"],
      },
    },
    run(args, context) {
      return runCommand(args, context);
    },
  };

  return {
    id: SANDBOX_WORLD_ID,

    async start(): Promise<void> {
      if (platform !== "linux") {
        throw new Error(
          `The sandbox runs on Linux only (Bubblewrap); this host is ${platform}. Remove sandbox.json, or run the Lar on a Linux host.`,
        );
      }
      const found = locate(config.bwrapPath);
      if (found === undefined) {
        const where = config.bwrapPath === undefined ? "on PATH" : `at ${config.bwrapPath}`;
        throw new Error(
          `The sandbox needs bwrap (Bubblewrap), and it was not found ${where}. Install it (on Debian or Ubuntu: sudo apt install bubblewrap) or set bwrapPath in sandbox.json.`,
        );
      }
      if (config.body !== false) {
        // The body is bound only when its folder holds nothing secret; otherwise the world refuses to start, plainly.
        const refusal = bodyRefusal(bodyRoot, options.dir);
        if (refusal !== undefined) throw new Error(refusal);
        bodyPath = bodyRoot;
      }
      bwrapPath = found;
      status = "ready";
    },

    async stop(): Promise<void> {
      status = "stopped";
      for (const end of [...running.values()]) end("world");
    },

    /** The summoner's emergency stop turned on: every command still running is ended now. */
    onStop(): void {
      for (const end of [...running.values()]) end("stop");
    },

    async say(place: string): Promise<Receipt> {
      return refusal("no_place", "The sandbox has no places to say things in.", `${place} is not a sandbox place.`);
    },

    tools() {
      return [runTool];
    },

    about() {
      const body = bodyPath === undefined ? "" : ` Your own source is at ${BODY_MOUNT}, read-only.`;
      return `A Linux shell of your own, with network access, run with the run tool. Your home folder at ${SANDBOX_HOME} keeps what you make; installs go there.${body}`;
    },

    now() {
      if (status === "idle") return "Sandbox: not started.";
      if (status === "stopped") return "Sandbox: stopped.";
      const size = measureHome(homeDir);
      const approx = size.complete ? "" : "about ";
      const files = `${approx}${size.files} ${size.files === 1 ? "file" : "files"}`;
      return `Sandbox: ready. Your home at ${SANDBOX_HOME} holds ${approx}${formatBytes(size.bytes)}, in ${files}.`;
    },
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
