// Background jobs: a command that keeps running after the turn. The body starts it in the same sandbox as a run, keeps
// its output in a log under the Lar's home, stops it at its ceiling, and tells the Lar's own thread when it ends. What
// to start and what the output means are the Lar's own judgment.

import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import type { Receipt, Tool, WorldEvent } from "../../contracts.js";
import { SANDBOX_HOME } from "./bwrap.js";
import { capText } from "./output.js";

/** The folder under the Lar's home that holds the job logs. */
export const JOB_LOG_FOLDER = ".natalis-jobs";
/** A job's log stops growing at this many bytes; the job itself keeps running. */
export const JOB_LOG_CAP_BYTES = 2 * 1024 * 1024;
/** Written once into a log that reached the cap. */
export const JOB_CUT_LINE = "(output cut at 2 MiB)";
/** Characters of the log a check shows when the Lar asks for no number. */
export const JOB_TAIL_DEFAULT = 2_000;
/** The most characters of the log a check may show. */
export const JOB_TAIL_MAX = 20_000;
/** Characters of the log the end event carries. */
export const JOB_EVENT_TAIL_CHARS = 1_000;
/** How long the world waits for its jobs to die when it stops. */
export const JOB_STOP_WAIT_MS = 5_000;
/** After SIGTERM, how long a job gets before the whole group is killed. Matches the run tool's grace. */
const KILL_GRACE_MS = 2_000;
/** After the process has exited, how long its output may still arrive before the job is called ended. */
const STDIO_GRACE_MS = 500;
/** Characters allowed in one background command. Matches the run tool's ceiling. */
const MAX_COMMAND_CHARS = 8_000;

export type JobSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type JobLaunch = { program: string; args: string[] };

export type JobRunnerOptions = {
  /** The world's id; places and events carry it. */
  worldId: string;
  /** The Lar's home on the host. The job logs live under it. */
  homeDir: string;
  /** The most jobs that may run at once. */
  maxJobs: number;
  /** The most minutes one job may run. */
  maxMinutes: number;
  spawn: JobSpawnFn;
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  nowMs: () => number;
  /** The world's way in: where its events go. */
  emit: (event: WorldEvent) => void;
  /** The program and arguments of one command in the sandbox, or a refusal when it cannot run. */
  launch: (command: string) => JobLaunch | { refused: Receipt };
  /** The body's privacy check of the command. Undefined when it may leave. */
  checkCommand: (command: string) => Receipt | undefined;
  /** Cleans a log tail before the Lar reads it, the way the run tool's output is cleaned. */
  cleanText: (text: string) => string;
  /** False before the sandbox is ready; then no job starts. */
  ready: () => boolean;
};

export type JobRunner = {
  /** Forgets every job and starts counting from j1 again. Called at each world start. */
  reset(): void;
  readonly startTool: Tool;
  readonly checkTool: Tool;
  readonly stopTool: Tool;
  /** Kills every running job and waits for them to end, at most JOB_STOP_WAIT_MS. */
  stopAll(): Promise<void>;
  /** The now board's line about running jobs, or undefined when none run. */
  nowLine(): string | undefined;
};

type Job = {
  id: string;
  why: string;
  pid: number | undefined;
  startedMs: number;
  maxMinutes: number;
  logPath: string;
  stream: WriteStream;
  decoder: StringDecoder;
  /** Bytes written to the log, not counting the cut line. */
  written: number;
  /** Whether the cut line has been written. */
  cut: boolean;
  /** The last characters written to the log, for a check and for the end event. */
  tail: string;
  timers: ReturnType<typeof setTimeout>[];
  exitCode: number | null;
  exited: boolean;
  terminating: boolean;
  ended: boolean;
  timedOut: boolean;
  stopped: boolean;
  /** Resolves once the job has ended and its event has been emitted. */
  finished: Promise<void>;
  settle: () => void;
};

function refusal(code: string, summary: string, reason: string): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** The last `count` characters of a text, counted as characters rather than UTF-16 units. */
function tailChars(text: string, count: number): string {
  const chars = Array.from(text);
  return chars.length <= count ? text : chars.slice(-count).join("");
}

/** Minutes a job has run, for the now board. Under a minute still reads as one. */
function minutesSoFar(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const logDir = join(options.homeDir, JOB_LOG_FOLDER);
  const jobs = new Map<string, Job>();
  let counter = 0;

  const liveJobs = (): Job[] => [...jobs.values()].filter((job) => !job.ended);

  const knownIds = (): string => {
    const ids = [...jobs.keys()];
    return ids.length === 0 ? "No background job has run." : `The jobs are ${ids.join(", ")}.`;
  };

  /** Adds what was written to the log to the in-memory tail, keeping only the last JOB_TAIL_MAX characters. */
  function keepTail(job: Job, text: string): void {
    job.tail = tailChars(job.tail + text, JOB_TAIL_MAX);
  }

  /** Writes one chunk of the job's output, stopping at the cap and adding the cut line once. */
  function writeLog(job: Job, chunk: Buffer): void {
    if (job.cut) return;
    const room = JOB_LOG_CAP_BYTES - job.written;
    if (chunk.length <= room) {
      job.written += chunk.length;
      job.stream.write(chunk);
      keepTail(job, job.decoder.write(chunk));
      return;
    }
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      job.written += kept.length;
      job.stream.write(kept);
      keepTail(job, job.decoder.write(kept));
    }
    job.cut = true;
    const line = `\n${JOB_CUT_LINE}\n`;
    job.stream.write(line);
    keepTail(job, line);
  }

  function killQuietly(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return;
    try {
      options.killGroup(pid, signal);
    } catch {
      // The group is already gone. Nothing is left to stop.
    }
  }

  /** One event to the Lar's own thread, with the log's last lines and what the end was. */
  function emitEnd(job: Job): void {
    const seconds = Number(((options.nowMs() - job.startedMs) / 1000).toFixed(1));
    const code = job.exitCode === null ? "none" : String(job.exitCode);
    let text = `Your background job ${job.id} (${job.why}) ended with exit code ${code} after ${seconds.toFixed(1)} s.`;
    if (job.stopped) text += " It was stopped.";
    if (job.timedOut) text += ` It ran out of time (${job.maxMinutes} min).`;
    const tail = capText(options.cleanText(tailChars(job.tail, JOB_EVENT_TAIL_CHARS))).trimEnd();
    text += `\n\nIts last lines:\n${tail}`;
    options.emit({
      world: options.worldId,
      place: `${options.worldId}:jobs`,
      thread: "self",
      source: "body",
      text,
      data: {
        job: job.id,
        exitCode: job.exitCode,
        seconds,
        ...(job.stopped ? { stopped: true } : {}),
        ...(job.timedOut ? { timedOut: true } : {}),
      },
    });
  }

  /**
   * Ends one job: its timers stop, the Lar is told once, and its log closes. The telling reads the tail the runner
   * kept in memory, so it never waits on the log file.
   */
  function finish(job: Job): void {
    if (job.ended) return;
    job.ended = true;
    for (const timer of job.timers) clearTimeout(timer);
    emitEnd(job);
    job.stream.end();
    job.settle();
  }

  /** Kills a job's process group the way the run tool does at its timeout: SIGTERM, then SIGKILL. */
  function requestStop(job: Job, reason: "stop" | "timeout" | "world"): void {
    if (job.terminating || job.exited || job.ended) return;
    job.terminating = true;
    if (reason === "timeout") job.timedOut = true;
    else job.stopped = true;
    killQuietly(job.pid, "SIGTERM");
    job.timers.push(
      setTimeout(() => {
        if (!job.exited) killQuietly(job.pid, "SIGKILL");
      }, KILL_GRACE_MS),
    );
    job.timers.push(setTimeout(() => finish(job), KILL_GRACE_MS + STDIO_GRACE_MS));
  }

  function startJob(args: Record<string, unknown>): Receipt {
    if (!options.ready()) {
      return refusal("not_ready", "The sandbox is not running, so the job did not start.", "The sandbox world is not started on this host.");
    }
    const command = args["command"];
    if (typeof command !== "string" || command.trim() === "") {
      return refusal("bad_arguments", "command must be a non-empty string.", "The command is missing.");
    }
    if (command.length > MAX_COMMAND_CHARS || command.includes("\0")) {
      return refusal("bad_arguments", `command must be at most ${MAX_COMMAND_CHARS} characters of text.`, "The command is too long or is not text.");
    }
    const why = args["why"];
    if (typeof why !== "string" || why.trim() === "") {
      return refusal("bad_arguments", "why must be a few words saying why you run it.", "The why is missing or is not text.");
    }
    const requested = args["max_minutes"];
    if (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)) {
      return refusal("bad_arguments", "max_minutes must be a positive number of minutes.", "The minutes are not a positive number.");
    }
    const checked = options.checkCommand(command);
    if (checked !== undefined) return checked;
    const live = liveJobs();
    if (live.length >= options.maxJobs) {
      const ids = live.map((job) => job.id).join(", ");
      return refusal(
        "too_many_jobs",
        `${ids} already running; at most ${options.maxJobs} run at once. Stop one with stop_job, or wait for it to end.`,
        `running: ${ids}`,
      );
    }
    const minutes = Math.min(requested ?? options.maxMinutes, options.maxMinutes);
    const built = options.launch(command);
    if ("refused" in built) return built.refused;
    try {
      mkdirSync(options.homeDir, { recursive: true, mode: 0o700 });
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return refusal("home_unavailable", "Your home folder could not be made, so the job did not start.", errorText(err));
    }
    const id = `j${counter + 1}`;
    const logPath = join(logDir, `${id}.log`);
    const sandboxLog = `${SANDBOX_HOME}/${JOB_LOG_FOLDER}/${id}.log`;
    // The file is made before the receipt, so the path the Lar is given is there the moment it is given.
    try {
      writeFileSync(logPath, "", { mode: 0o600 });
    } catch (err) {
      return refusal("home_unavailable", "The job's log file could not be made, so the job did not start.", errorText(err));
    }
    const stream: WriteStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
    // A log that cannot be written still ends the job normally: the receipt names the file and the event says what came.
    stream.on("error", () => undefined);
    let child: ChildProcess;
    try {
      child = options.spawn(built.program, built.args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {},
        windowsHide: true,
      });
    } catch (err) {
      stream.end();
      return refusal("spawn_failed", "The sandbox could not start the shell, so the job did not start.", errorText(err));
    }
    counter += 1;
    let settle: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      id,
      why: why.trim(),
      pid: child.pid,
      startedMs: options.nowMs(),
      maxMinutes: minutes,
      logPath,
      stream,
      decoder: new StringDecoder("utf8"),
      written: 0,
      cut: false,
      tail: "",
      timers: [],
      exitCode: null,
      exited: false,
      terminating: false,
      ended: false,
      timedOut: false,
      stopped: false,
      finished,
      settle,
    };
    const endSoon = (): void => {
      job.timers.push(setTimeout(() => finish(job), STDIO_GRACE_MS));
    };
    jobs.set(id, job);
    child.stdout?.on("data", (chunk: Buffer) => writeLog(job, chunk));
    child.stderr?.on("data", (chunk: Buffer) => writeLog(job, chunk));
    child.on("error", (err: Error) => {
      // A start that failed after the receipt is still an end, and it is said plainly in the log the Lar reads.
      const line = `\nThe job could not start: ${err.message}\n`;
      job.stream.write(line);
      keepTail(job, line);
      job.exited = true;
      finish(job);
    });
    child.on("exit", (code: number | null) => {
      job.exited = true;
      job.exitCode = code;
      endSoon();
    });
    child.on("close", (code: number | null) => {
      if (!job.exited) job.exitCode = code;
      job.exited = true;
      finish(job);
    });
    job.timers.push(setTimeout(() => requestStop(job, "timeout"), minutes * 60_000));
    return {
      ok: true,
      summary: `Started job ${id}. Its output goes to ${sandboxLog}.`,
      data: { id, log: sandboxLog },
    };
  }

  function checkJob(args: Record<string, unknown>): Receipt {
    const id = args["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return refusal("bad_arguments", "id must be the id of a job, such as j1.", "The id is missing or is not text.");
    }
    const requested = args["tail_bytes"];
    if (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)) {
      return refusal("bad_arguments", "tail_bytes must be a positive number of characters.", "The tail size is not a positive number.");
    }
    const job = jobs.get(id.trim());
    if (job === undefined) {
      return refusal("not_found", `There is no job ${id.trim()}. ${knownIds()}`, "No job has that id.");
    }
    const count = Math.min(Math.floor(requested ?? JOB_TAIL_DEFAULT), JOB_TAIL_MAX);
    const seconds = Number(((options.nowMs() - job.startedMs) / 1000).toFixed(1));
    const running = !job.ended;
    const code = job.exitCode === null ? "none" : String(job.exitCode);
    const summary = running
      ? `Job ${job.id} is still running, ${seconds.toFixed(1)} s so far.`
      : `Job ${job.id} ended with exit code ${code} after ${seconds.toFixed(1)} s.`;
    return {
      ok: true,
      summary,
      data: { id: job.id, running, exitCode: job.exitCode, seconds, tail: tailChars(job.tail, count) },
    };
  }

  async function stopJob(args: Record<string, unknown>): Promise<Receipt> {
    const id = args["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return refusal("bad_arguments", "id must be the id of a job, such as j1.", "The id is missing or is not text.");
    }
    const why = args["why"];
    if (typeof why !== "string" || why.trim() === "") {
      return refusal("bad_arguments", "why must be a few words saying why you stop it.", "The why is missing or is not text.");
    }
    const job = jobs.get(id.trim());
    if (job === undefined) {
      return refusal("not_found", `There is no job ${id.trim()}. ${knownIds()}`, "No job has that id.");
    }
    if (job.ended) {
      return refusal("not_running", `Job ${job.id} has already ended.`, "The job is not running.");
    }
    requestStop(job, "stop");
    await job.finished;
    return {
      ok: true,
      summary: `Stopped job ${job.id}. Its end is reported like any other.`,
      data: { id: job.id, stopped: true },
    };
  }

  const startTool: Tool = {
    spec: {
      name: "run_background",
      description:
        "Start a shell command that keeps running after this turn, such as a long build or download. " +
        `When it ends, your own thread is told, with its last lines. At most ${options.maxJobs} at once.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run, as you would type it in bash." },
          why: { type: "string", description: "Why you are running it, in a few words." },
          max_minutes: {
            type: "number",
            minimum: 1,
            description: `Minutes before the job is stopped. Defaults to ${options.maxMinutes}; capped at ${options.maxMinutes}.`,
          },
        },
        required: ["command", "why"],
      },
    },
    run(args) {
      return Promise.resolve(startJob(args));
    },
  };

  const checkTool: Tool = {
    spec: {
      name: "check_job",
      description: "See whether a background job is still running, how it ended, and the last lines of its log.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The job's id, such as j1." },
          tail_bytes: {
            type: "number",
            minimum: 1,
            description: `Characters of its log to show. Defaults to ${JOB_TAIL_DEFAULT}; at most ${JOB_TAIL_MAX}.`,
          },
        },
        required: ["id"],
      },
    },
    run(args) {
      return Promise.resolve(checkJob(args));
    },
  };

  const stopTool: Tool = {
    spec: {
      name: "stop_job",
      description: "Stop a background job that is still running, and end its whole process group.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The job's id, such as j1." },
          why: { type: "string", description: "Why you are stopping it, in a few words." },
        },
        required: ["id", "why"],
      },
    },
    run(args) {
      return stopJob(args);
    },
  };

  return {
    reset() {
      jobs.clear();
      counter = 0;
    },

    startTool,
    checkTool,
    stopTool,

    async stopAll() {
      const live = liveJobs();
      for (const job of live) requestStop(job, "world");
      if (live.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, JOB_STOP_WAIT_MS);
      });
      await Promise.race([Promise.all(live.map((job) => job.finished)), waited]);
      if (timer !== undefined) clearTimeout(timer);
    },

    nowLine() {
      const live = liveJobs();
      if (live.length === 0) return undefined;
      const now = options.nowMs();
      const parts = live.map((job) => `${job.id} (${minutesSoFar(now - job.startedMs)} min, ${job.why})`);
      return `Background jobs running: ${parts.join(", ")}.`;
    },
  };
}
