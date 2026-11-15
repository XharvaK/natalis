// The voice organ's Node side: one client over the organ's framed stdin and stdout, and the supervisor that starts the
// organ, restarts it after 1, 5 and then 30 s when it dies, and says it is resting meanwhile. The protocol is in
// organ/PROTOCOL.md. A crash in the organ never reaches the Lar's mind: her text life goes on.

import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams, spawn as spawnFn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { encodeFrame, type Frame, FrameDecoder, FrameError } from "./frame-codec.js";

/** The organ script, from src/voice/ and dist/voice/ alike. */
export const ORGAN_SCRIPT = fileURLToPath(new URL("../../organ/voice_organ.py", import.meta.url));

/** One reply from the organ: its header and its body. */
export type OrganReply = { header: Record<string, unknown>; body: Uint8Array };

/** What the organ's ready frame says. */
export type OrganReady = {
  protocol: number;
  voices: string[];
  sampleRate: number;
  frameMs: number;
  /** The Opus encoder's lookahead in samples at 48 kHz: an Ogg file's pre-skip. */
  lookahead: number;
  phonemizer: string;
  stt: string;
};

/**
 * Why a call to the organ did not get a usable reply. "resting": the organ was not ready, so nothing was sent.
 * "failed": the organ answered with an error, or did not answer in time. "stopped": the organ died or was stopped
 * before it answered. "protocol": the organ broke the protocol.
 */
export type OrganErrorKind = "resting" | "failed" | "stopped" | "protocol";

export class OrganError extends Error {
  constructor(
    message: string,
    readonly kind: OrganErrorKind,
  ) {
    super(message);
    this.name = "OrganError";
  }
}

/** What the rest of the body needs from the organ. */
export interface OrganCaller {
  /** Why the organ cannot take a call now, in plain words; undefined while it is ready. */
  resting(): string | undefined;
  /** The ready frame of the organ now running; undefined while it is not ready. */
  ready(): OrganReady | undefined;
  /**
   * Sends one request (the id is added here) and resolves with its reply. Rejects with an OrganError: "resting" at once
   * when the organ is not ready, "failed" for an error reply or a timeout, "stopped" when it died first.
   */
  call(header: Record<string, unknown>, body?: Uint8Array, options?: { timeoutMs?: number }): Promise<OrganReply>;
}

export type OrganSupervisorOptions = {
  /** The program: the venv's python, or node with a fake organ in tests. */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** The waits before each restart. The last one repeats. Default [1000, 5000, 30000]. */
  restartDelaysMs?: number[];
  /** Once an organ has been ready this long, the next death waits the first delay again. Default 60000. */
  steadyMs?: number;
  /** How long a start may take before ready; then the organ is killed and started again. Default 120000. */
  readyTimeoutMs?: number;
  /** A call's timeout when the call names none. Default 180000. */
  callTimeoutMs?: number;
  /** One line at a time, for the host's log. Default console.error. */
  log?: (line: string) => void;
  /** Injected in tests; node:child_process spawn when absent. */
  spawn?: typeof spawnFn;
};

export interface OrganSupervisor extends OrganCaller {
  /** Starts the organ. Calling it again while it runs does nothing. */
  start(): void;
  /** Stops the organ for good: no restart. Calls in flight reject with "stopped". */
  stop(): Promise<void>;
  /** Resolves with the next ready frame (at once while ready). Rejects once the supervisor is stopped. */
  whenReady(): Promise<OrganReady>;
}

/** The organ's command line for a voice.json: `<python> -I <script> --models <models>`. */
export function organCommand(organ: { python: string; models: string }, script: string = ORGAN_SCRIPT): { command: string; args: string[] } {
  return { command: organ.python, args: ["-I", script, "--models", organ.models] };
}

/** How long a wait reads: milliseconds under a second, else seconds (`1 s`, `1.5 s`, `30 s`). */
function delayText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(3))} s`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOrganSupervisor(options: OrganSupervisorOptions): OrganSupervisor {
  const restartDelays = options.restartDelaysMs ?? [1000, 5000, 30000];
  const steadyMs = options.steadyMs ?? 60_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const callTimeoutMs = options.callTimeoutMs ?? 180_000;
  const log = options.log ?? ((line: string) => console.error(line));
  const spawnChild = options.spawn ?? spawnProcess;

  let started = false;
  let stopped = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let decoder = new FrameDecoder();
  let readyInfo: OrganReady | undefined;
  let restingText = "your voice organ is starting";
  let nextId = 1;
  let restartIndex = 0;
  let readyAt: number | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let readyTimer: NodeJS.Timeout | undefined;
  const waiting = new Map<
    number,
    { resolve: (reply: OrganReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; op: string }
  >();
  let readyWaiters: { resolve: (ready: OrganReady) => void; reject: (error: Error) => void }[] = [];

  function resting(): string | undefined {
    if (stopped) return "your voice organ is stopped";
    return readyInfo === undefined ? restingText : undefined;
  }

  function ready(): OrganReady | undefined {
    return readyInfo;
  }

  function whenReady(): Promise<OrganReady> {
    if (stopped) return Promise.reject(new OrganError("your voice organ is stopped", "stopped"));
    if (readyInfo !== undefined) return Promise.resolve(readyInfo);
    return new Promise((resolve, reject) => {
      readyWaiters.push({ resolve, reject });
    });
  }

  function restartDelay(): number {
    if (restartDelays.length === 0) return 1000;
    return restartDelays[Math.min(restartIndex, restartDelays.length - 1)] ?? 1000;
  }

  function killCurrent(): void {
    const proc = child;
    if (proc === undefined) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // It was already gone; its exit or error event is on its way.
    }
  }

  function protocolFault(reason: string): void {
    if (stopped) return;
    log(`[voice organ] broke the protocol (${reason}); stopping it`);
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new OrganError(`the voice organ broke the protocol (${reason})`, "protocol"));
      waiting.delete(id);
    }
    killCurrent();
  }

  function handleFrame(frame: Frame, fault: (reason: string) => void): void {
    const { header, body } = frame;

    if (header.op === "ready") {
      if (readyInfo !== undefined) {
        fault("a second ready frame");
        return;
      }
      if (header.protocol !== 1) {
        fault(`the organ speaks protocol ${String(header.protocol)}, not 1`);
        return;
      }
      if (!Array.isArray(header.voices) || typeof header.stt !== "string") {
        fault("its ready frame has no voices or stt");
        return;
      }
      const info: OrganReady = {
        protocol: header.protocol as number,
        voices: header.voices as string[],
        sampleRate: header.sample_rate as number,
        frameMs: header.frame_ms as number,
        lookahead: header.lookahead as number,
        phonemizer: header.phonemizer as string,
        stt: header.stt,
      };
      readyInfo = info;
      readyAt = Date.now();
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
        readyTimer = undefined;
      }
      log(`[voice organ] ready: voices ${info.voices.join(", ")}; ${info.stt}`);
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const waiter of waiters) waiter.resolve(info);
      return;
    }

    if (readyInfo === undefined) {
      fault(`a ${String(header.op)} frame before ready`);
      return;
    }

    const id = header.id;
    if (header.op === "error" && (id === null || id === undefined)) {
      fault("an error reply with no id");
      return;
    }
    if (typeof id !== "number") {
      fault(`a ${String(header.op)} reply with no usable id`);
      return;
    }
    const entry = waiting.get(id);
    if (entry === undefined) {
      fault(`a ${String(header.op)} reply with id ${id} that no call waits for`);
      return;
    }
    waiting.delete(id);
    clearTimeout(entry.timer);
    if (header.op === "error") {
      entry.reject(new OrganError(typeof header.error === "string" ? header.error : "the voice organ failed", "failed"));
      return;
    }
    entry.resolve({ header, body });
  }

  function processDied(how: string, proc: ChildProcessWithoutNullStreams | undefined): void {
    if (stopped) return;
    if (proc !== undefined && proc !== child) return;
    if (proc === undefined && child !== undefined) return;
    if (restartTimer !== undefined) return;

    child = undefined;
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    const wasSteady = readyAt !== undefined && Date.now() - readyAt >= steadyMs;
    readyAt = undefined;
    readyInfo = undefined;
    if (wasSteady) restartIndex = 0;

    const delay = restartDelay();
    restartIndex += 1;

    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new OrganError(`the voice organ stopped (${how}) before it answered`, "stopped"));
      waiting.delete(id);
    }

    restingText = `your voice organ stopped (${how}) and starts again in ${delayText(delay)}`;
    log(`[voice organ] stopped (${how}); starting again in ${delayText(delay)}`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopped) spawnOrgan();
    }, delay);
  }

  function spawnOrgan(): void {
    if (stopped) return;
    restingText = "your voice organ is starting";
    readyInfo = undefined;
    readyAt = undefined;
    decoder = new FrameDecoder();
    log("[voice organ] starting");

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawnChild(options.command, options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: options.env,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      processDied(`could not start: ${messageOf(error)}`, undefined);
      return;
    }
    child = proc;

    let faulted = false;
    const fault = (reason: string): void => {
      if (faulted || stopped || proc !== child) return;
      faulted = true;
      protocolFault(reason);
    };

    proc.stdout.on("data", (data: Buffer) => {
      if (faulted || stopped || proc !== child) return;
      let frames: Frame[];
      try {
        frames = decoder.push(data);
      } catch (error) {
        if (error instanceof FrameError) {
          fault(error.message);
          return;
        }
        throw error;
      }
      for (const frame of frames) {
        if (faulted || stopped || proc !== child) return;
        handleFrame(frame, fault);
      }
    });

    let stderrLeft = "";
    const stderrDecoder = new StringDecoder("utf8");
    proc.stderr.on("data", (data: Buffer) => {
      stderrLeft += stderrDecoder.write(data);
      for (;;) {
        const newline = stderrLeft.indexOf("\n");
        if (newline < 0) break;
        let line = stderrLeft.slice(0, newline);
        stderrLeft = stderrLeft.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        log(`[voice organ] ${line}`);
      }
    });
    proc.stderr.on("end", () => {
      stderrLeft += stderrDecoder.end();
      const line = stderrLeft.replace(/\r$/, "");
      stderrLeft = "";
      if (line.length > 0) log(`[voice organ] ${line}`);
    });

    // A dead child can make a write fail; the exit or error event reports the death itself.
    proc.stdin.on("error", () => undefined);
    proc.stdout.on("error", () => undefined);
    proc.stderr.on("error", () => undefined);

    proc.on("error", (error) => {
      if (proc !== child) return;
      child = undefined;
      processDied(`could not start: ${messageOf(error)}`, undefined);
    });

    proc.on("exit", (code, signal) => {
      if (proc !== child) return;
      child = undefined;
      processDied(code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`, undefined);
    });

    readyTimer = setTimeout(() => {
      readyTimer = undefined;
      if (stopped || proc !== child || readyInfo !== undefined) return;
      log(`[voice organ] not ready after ${delayText(readyTimeoutMs)}; stopping it`);
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone; the exit event still follows.
      }
    }, readyTimeoutMs);
  }

  function call(
    header: Record<string, unknown>,
    body?: Uint8Array,
    callOptions?: { timeoutMs?: number },
  ): Promise<OrganReply> {
    if (stopped) return Promise.reject(new OrganError("your voice organ is stopped", "resting"));
    if (readyInfo === undefined) return Promise.reject(new OrganError(restingText, "resting"));

    const id = nextId;
    nextId += 1;
    const op = typeof header.op === "string" ? header.op : String(header.op ?? "");
    const timeoutMs = callOptions?.timeoutMs ?? callTimeoutMs;
    let bytes: Buffer;
    try {
      bytes = encodeFrame({ ...header, id }, body);
    } catch (error) {
      return Promise.reject(error);
    }

    const proc = child;
    return new Promise<OrganReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = waiting.get(id);
        if (entry === undefined) return;
        waiting.delete(id);
        clearTimeout(entry.timer);
        log(`[voice organ] did not answer ${op} in ${delayText(timeoutMs)}; stopping it`);
        entry.reject(new OrganError(`the voice organ did not answer ${op} in ${delayText(timeoutMs)}`, "failed"));
        killCurrent();
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer, op });
      if (proc === undefined) {
        waiting.delete(id);
        clearTimeout(timer);
        reject(new OrganError("the voice organ is not running (it stopped) before it answered", "stopped"));
        return;
      }
      proc.stdin.write(bytes);
    });
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    spawnOrgan();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    readyInfo = undefined;
    readyAt = undefined;
    restingText = "your voice organ is stopped";

    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new OrganError("the voice organ stopped (it was stopped) before it answered", "stopped"));
      waiting.delete(id);
    }
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.reject(new OrganError("your voice organ is stopped", "stopped"));

    const proc = child;
    if (proc === undefined) return;
    child = undefined;
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        finish();
      }, 3000);
      proc.once("exit", finish);
      try {
        proc.stdin.end();
      } catch {
        finish();
      }
    });
  }

  return { resting, ready, call, start, stop, whenReady };
}
