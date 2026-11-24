// The sandbox world: a Linux shell of the Lar's own, run in Bubblewrap, with network. The Lar runs commands with
// `run`. The body builds the sandbox, starts each job, stops it on timeout and reports what came out. What to run
// and what to do with the output are the Lar's own judgment.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { type HostAddresses, sharedHostAddresses } from "../host-addresses.js";
import type { Receipt, Tool, ToolContext, World, WorldBody, WorldEvent } from "../../contracts.js";
import { outwardHoldWords } from "../../entity/privacy.js";
import { PICTURE_BYTES_MAX, sniffPicture } from "../../media/shelf.js";
import { BODY_MOUNT, bodyRefusal, defaultBodyRoot } from "./body.js";
import { buildBwrapArgs, SANDBOX_HOME } from "./bwrap.js";
import { SANDBOX_DEFAULT_MAX_BACKGROUND_JOBS, SANDBOX_DEFAULT_MAX_JOB_MINUTES, SANDBOX_DEFAULT_NETWORK, type SandboxSettings } from "./config.js";
import { createJobRunner, type JobLaunch } from "./jobs.js";
import { OUTPUT_CAP_BYTES, OutputCollector } from "./output.js";
import { WALL_DNS, wallCommand, withoutPastaNotice } from "./wall.js";

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
  /** Finds pasta, which walls the network in "wall" mode. Injected in tests. */
  locatePasta?: (configuredPath: string | undefined) => string | undefined;
  /** Finds ip, used by the route script in "wall" mode. Injected in tests. */
  locateIp?: (configuredPath: string | undefined) => string | undefined;
  /** Signals a whole process group. Injected in tests, so no real process is ever signalled by a test. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * The Natalis checkout bound read-only at /body, unless config.body is false. Defaults to the package root this code
   * runs from. Injected in tests.
   */
  bodyDir?: string;
  /** The host's own addresses, walled in "wall" mode. Injected in tests; the process's shared lookup when absent. */
  hostAddresses?: HostAddresses;
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
export function findProgram(name: string, configuredPath: string | undefined): string | undefined {
  if (configuredPath !== undefined) {
    const candidate = configuredPath.includes("/") || isAbsolute(configuredPath) ? resolve(configuredPath) : undefined;
    if (candidate !== undefined) return existsSync(candidate) ? candidate : undefined;
  }
  const bare = configuredPath ?? name;
  for (const folder of (process.env["PATH"] ?? "").split(delimiter)) {
    if (folder === "") continue;
    const candidate = join(folder, bare);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Finds bwrap: the configured path, or a search of PATH. */
export function findBwrap(configuredPath: string | undefined): string | undefined {
  return findProgram("bwrap", configuredPath);
}

/** Finds pasta: the configured path, or a search of PATH. */
export function findPasta(configuredPath: string | undefined): string | undefined {
  return findProgram("pasta", configuredPath);
}

/** Finds ip: the configured path, else /usr/sbin/ip, else /sbin/ip. The route script names it by this full path. */
export function findIp(configuredPath: string | undefined): string | undefined {
  if (configuredPath !== undefined) return findProgram("ip", configuredPath);
  return ["/usr/sbin/ip", "/sbin/ip"].find((candidate) => existsSync(candidate));
}

/** The folder, inside the entity folder, that holds the resolver file a walled command uses. */
export const WALL_FOLDER = "sandbox-network";

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

/** True when `path` is the home itself or a file inside it, by their real paths. */
function insideHome(path: string, home: string): boolean {
  return path === home || path.startsWith(home + sep);
}

/**
 * A path as the Lar means it, read inside the Lar's home: a leading /home/lar/ is dropped, since that is where the
 * sandbox shows the home. Other absolute paths and any ".." segment are refused, so a command can never ask the body
 * for a file outside its own home. Undefined when the path cannot be read as one inside the home.
 */
export function homeRelativePath(requested: string): string[] | undefined {
  let rest = requested.trim();
  if (rest === SANDBOX_HOME || rest === `${SANDBOX_HOME}/`) return undefined;
  if (rest.startsWith(`${SANDBOX_HOME}/`)) rest = rest.slice(SANDBOX_HOME.length + 1);
  if (rest === "" || isAbsolute(rest)) return undefined;
  const segments = rest.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return segments;
}

export function createSandboxWorld(options: SandboxWorldOptions): World {
  const { config } = options;
  const homeDir = resolve(options.dir, "home");
  const spawnProcess: SpawnFn = options.spawn ?? defaultSpawn;
  const platform = options.platform ?? process.platform;
  const nowMs = options.nowMs ?? (() => Date.now());
  const locate = options.locateBwrap ?? findBwrap;
  const locatePasta = options.locatePasta ?? findPasta;
  const locateIp = options.locateIp ?? findIp;
  const hostAddresses = options.hostAddresses ?? sharedHostAddresses();
  const killGroup = options.killGroup ?? defaultKillGroup;
  const bodyRoot = options.bodyDir ?? defaultBodyRoot();
  const network = config.network ?? SANDBOX_DEFAULT_NETWORK;
  // The default root is looked up once here; the refusal is checked at start, when the bind is decided.

  let status: Status = "idle";
  /** The body the runtime gives the world at start. Its privacy check is the only way a command is checked. */
  let outward: WorldBody | undefined;
  /** The world's way in, kept from start: a background job's end is told to the Lar's own thread through it. */
  let emitEvent: ((event: WorldEvent) => void) | undefined;
  let bwrapPath: string | undefined;
  /** The resolver file a walled command uses, written at start. Only set in "wall" mode. */
  let resolvPath: string | undefined;
  /** The checkout bound at /body for this run of the world, when it is bound. */
  let bodyPath: string | undefined;
  /** Commands in flight, each with the function that ends it. */
  const running = new Map<ChildProcess, (stoppedBy: StoppedBy) => void>();

  /**
   * Runs one program with its argument list (bwrap, or pasta around bwrap in "wall" mode) and resolves with the receipt
   * when the job has ended.
   */
  function execute(program: string, argv: string[], timeoutSeconds: number, signal: AbortSignal | undefined): Promise<Receipt> {
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
        const errText = network === "wall" ? withoutPastaNotice(stderr.text()) : stderr.text();
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
        // Detached, so the leader is a process group of its own: pasta in "wall" mode, bwrap otherwise. The group kill
        // (SIGTERM, then SIGKILL) reaches the leader and whatever stays in its group. If bwrap's --new-session moves bwrap
        // into a session of its own, the group kill misses it, and --die-with-parent is what covers that: in "wall" mode
        // bwrap's parent is pasta (the shell became bwrap with exec), so the SIGKILL to pasta makes the kernel kill bwrap,
        // and bwrap's own --die-with-parent takes the command down with it. In host and none modes bwrap's parent is this
        // process, so the group kill is the only path, as it was before the wall. Not checked on a Linux host yet.
        child = spawnProcess(program, argv, {
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
    // The command's words leave the Lar's body with the run, so the privacy list is checked before anything starts.
    if (outward === undefined) {
      return refusal("not_started", "The sandbox has not started yet, so the command did not run.", "The sandbox world is not started, so nothing was run.");
    }
    const hold = outward.outwardHold([command]);
    if (hold !== undefined) {
      const words = outwardHoldWords(hold, "the command");
      return refusal(words.code, words.summary, words.reason);
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
    const built = launchFor(command);
    if ("refused" in built) return built.refused;
    return execute(built.program, built.args, timeoutSeconds, context.signal);
  }

  /**
   * The program and arguments that run one command in this sandbox, walled when the network is "wall". Both `run` and
   * `run_background` come through here, so a job runs in exactly the sandbox a command does.
   */
  function launchFor(command: string): JobLaunch | { refused: Receipt } {
    if (bwrapPath === undefined) {
      return { refused: refusal("not_ready", "The sandbox is not running, so the command did not run.", "The sandbox world is not started on this host.") };
    }
    try {
      mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return { refused: refusal("home_unavailable", "Your home folder could not be made, so the command did not run.", errorText(err)) };
    }
    const bwrapArgs = buildBwrapArgs({
      homeDir,
      command,
      network,
      ...(bodyPath === undefined ? {} : { bodyDir: bodyPath }),
      ...(resolvPath === undefined ? {} : { resolvPath }),
    });
    if (network !== "wall") return { program: bwrapPath, args: bwrapArgs };
    // The wall is never skipped: when pasta or ip is missing the command does not run, and the receipt says so.
    const pastaPath = locatePasta(config.pastaPath);
    const ipPath = locateIp(config.ipPath);
    const missing = [
      ...(pastaPath === undefined ? ["pasta (the passt package)"] : []),
      ...(ipPath === undefined ? ["ip (iproute2)"] : []),
    ];
    if (pastaPath === undefined || ipPath === undefined) {
      return {
        refused: refusal(
          "network_not_walled",
          `The command did not run, because the network wall needs ${missing.join(" and ")}, and it is not installed here. ` +
            'Your summoner can install the passt package, or set "network": "host" in sandbox.json to share the host\'s network without the wall.',
          `not found: ${missing.join(", ")}`,
        ),
      };
    }
    let own: string[];
    try {
      own = hostAddresses.current();
      // AU NB-1: without the router's WAN address the wall has a hole (a NAT hairpin back in), so it does not run.
      if (hostAddresses.publicState() === "unknown") {
        void hostAddresses.refresh();
        console.error("[sandbox] a wall-mode command was refused: the host's public IPv4 address is not known yet.");
        return {
          refused: refusal(
            "network_not_walled",
            "The command did not run, because the network wall needs this host's public address and it is not known yet. Try again in a minute.",
            "the host's public IPv4 address is not known (the lookup has not answered), so the wall cannot block it",
          ),
        };
      }
    } catch (err) {
      return {
        refused: refusal("network_not_walled", "The command did not run, because this host's own addresses could not be read for the wall.", errorText(err)),
      };
    }
    const walled = wallCommand({ pastaPath, ipPath, bwrapPath, bwrapArgs, hostAddresses: own });
    return { program: walled.command, args: walled.args };
  }

  const jobs = createJobRunner({
    worldId: SANDBOX_WORLD_ID,
    homeDir,
    maxJobs: config.maxBackgroundJobs ?? SANDBOX_DEFAULT_MAX_BACKGROUND_JOBS,
    maxMinutes: config.maxJobMinutes ?? SANDBOX_DEFAULT_MAX_JOB_MINUTES,
    spawn: spawnProcess,
    killGroup,
    nowMs,
    emit: (event) => emitEvent?.(event),
    launch: launchFor,
    checkCommand: (command) => {
      if (outward === undefined) {
        return refusal("not_started", "The sandbox has not started yet, so the job did not start.", "The sandbox world is not started, so nothing was run.");
      }
      const hold = outward.outwardHold([command]);
      if (hold === undefined) return undefined;
      const words = outwardHoldWords(hold, "the command");
      return refusal(words.code, words.summary, words.reason);
    },
    // The same cleaning the run tool gives its error output: pasta's start-up notice is the body's noise, not the job's.
    cleanText: (text) => (network === "wall" ? withoutPastaNotice(text) : text),
    ready: () => status === "ready" && bwrapPath !== undefined,
  });

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

  async function keepPicture(args: Record<string, unknown>): Promise<Receipt> {
    if (outward === undefined) {
      return refusal("not_started", "The sandbox has not started yet, so the picture was not kept.", "The sandbox world is not started.");
    }
    const requested = args["path"];
    if (typeof requested !== "string" || requested.trim() === "" || requested.includes("\0")) {
      return refusal("bad_arguments", "path must be the path to a picture in your home folder.", "The path is missing or is not text.");
    }
    const rawName = args["name"];
    if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim() === "")) {
      return refusal("bad_arguments", "name must be text, when you give one.", "The name is not text.");
    }
    const display = requested.trim();
    const segments = homeRelativePath(display);
    if (segments === undefined) {
      return refusal(
        "bad_arguments",
        `${display} is not a path in your home folder. Give a path such as plots/week.png or ${SANDBOX_HOME}/plots/week.png.`,
        "The path is outside the home folder, or it climbs out of it with ..",
      );
    }
    const target = join(homeDir, ...segments);
    let found: ReturnType<typeof lstatSync>;
    try {
      found = lstatSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
        return refusal("not_found", `${display} is not there.`, "No file is at that path.");
      }
      return refusal("not_found", `${display} could not be read.`, errorText(err));
    }
    if (!found.isFile()) {
      return refusal("not_a_file", `${display} is not a regular file.`, found.isSymbolicLink() ? "It is a link." : "It is not a regular file.");
    }
    let real: string;
    let homeReal: string;
    try {
      homeReal = realpathSync(homeDir);
      real = realpathSync(target);
    } catch (err) {
      return refusal("not_found", `${display} could not be read.`, errorText(err));
    }
    if (!insideHome(real, homeReal)) {
      return refusal("not_a_file", `${display} is not inside your home folder.`, "Its real path lies outside the home folder.");
    }
    if (found.size > PICTURE_BYTES_MAX) {
      return refusal("too_big", `${display} is ${formatBytes(found.size)}; a picture can be at most 8 MiB.`, "The file is larger than 8 MiB.");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch (err) {
      return refusal("not_found", `${display} could not be read.`, errorText(err));
    }
    if (bytes.length > PICTURE_BYTES_MAX) {
      return refusal("too_big", `${display} is ${formatBytes(bytes.length)}; a picture can be at most 8 MiB.`, "The file is larger than 8 MiB.");
    }
    if (sniffPicture(bytes) === undefined) {
      return refusal("not_a_picture", `${display} is not a PNG, JPEG, GIF or WebP picture.`, "Its bytes are not one of the four picture types.");
    }
    const name = typeof rawName === "string" ? rawName.trim() : basename(real);
    const ref = outward.keepPicture({ bytes, name, from: { world: SANDBOX_WORLD_ID, place: `${SANDBOX_WORLD_ID}:home` } });
    return {
      ok: true,
      summary: `Kept ${ref.name} on your shelf as ${ref.id}. look shows it; say's attach sends it.`,
      data: { id: ref.id, name: ref.name, bytes: ref.bytes },
    };
  }

  const keepPictureSpec: Tool = {
    spec: {
      name: "keep_picture",
      description:
        "Put a picture from your home folder on your shelf, so you can look at it or send it with say. Give its path, such as plots/week.png or /home/lar/plots/week.png.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The picture's path in your home folder." },
          name: {
            type: "string",
            description: "The name it is kept under. Defaults to the file's base name.",
          },
        },
        required: ["path"],
      },
    },
    run(args) {
      return keepPicture(args);
    },
  };

  return {
    id: SANDBOX_WORLD_ID,

    async start(emit, body): Promise<void> {
      outward = body;
      emitEvent = emit;
      jobs.reset();
      if (network === "wall") await hostAddresses.refresh();
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
      if (network === "wall") {
        // The resolver the walled command is told to use. Written once per start; the host's own resolver is never bound.
        const folder = join(options.dir, WALL_FOLDER);
        const file = join(folder, "resolv.conf");
        try {
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          writeFileSync(file, `nameserver ${WALL_DNS}\n`, "utf8");
        } catch (err) {
          throw new Error(`The sandbox could not write its resolver file in ${folder}: ${errorText(err)}`);
        }
        resolvPath = file;
      }
      bwrapPath = found;
      status = "ready";
    },

    async stop(): Promise<void> {
      status = "stopped";
      for (const end of [...running.values()]) end("world");
      await jobs.stopAll();
    },

    /** The summoner's emergency stop turned on: every command and background job still running is ended now. */
    async onStop(): Promise<void> {
      for (const end of [...running.values()]) end("stop");
      await jobs.stopAll();
    },

    async say(place: string): Promise<Receipt> {
      return refusal("no_place", "The sandbox has no places to say things in.", `${place} is not a sandbox place.`);
    },

    tools() {
      return [runTool, keepPictureSpec, jobs.startTool, jobs.checkTool, jobs.stopTool];
    },

    about() {
      const body = bodyPath === undefined ? "" : ` Your own source is at ${BODY_MOUNT}, read-only.`;
      const shell = network === "none" ? "with no network" : "with network access";
      const reach =
        network === "wall"
          ? " Your network reaches the internet, but not this host's own services or the machines on its local network."
          : "";
      return `A Linux shell of your own, ${shell}, run with the run tool. Your home folder at ${SANDBOX_HOME} keeps what you make; installs go there.${reach}${body}`;
    },

    now() {
      if (status === "idle") return "Sandbox: not started.";
      if (status === "stopped") return "Sandbox: stopped.";
      const size = measureHome(homeDir);
      const approx = size.complete ? "" : "about ";
      const files = `${approx}${size.files} ${size.files === 1 ? "file" : "files"}`;
      const head = `Sandbox: ready. Your home at ${SANDBOX_HOME} holds ${approx}${formatBytes(size.bytes)}, in ${files}.`;
      const jobLine = jobs.nowLine();
      return jobLine === undefined ? head : `${head} ${jobLine}`;
    },
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
