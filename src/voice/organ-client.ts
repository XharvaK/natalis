// The voice organ's Node side: one client over the organ's framed stdin and stdout, and the supervisor that starts the
// organ, restarts it after 1, 5 and then 30 s when it dies, and says it is resting meanwhile. The protocol is in
// organ/PROTOCOL.md. A crash in the organ never reaches the Lar's mind: her text life goes on.

import type { spawn as spawnFn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

export function createOrganSupervisor(_options: OrganSupervisorOptions): OrganSupervisor {
  throw new Error("createOrganSupervisor is not built yet (N10 phase 1, pack voice-node).");
}
