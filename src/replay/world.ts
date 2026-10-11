// The replay's worlds. A ReplayWorld takes events the harness feeds it, and it records what the entity says
// instead of delivering it. Its wake tools record wakes instead of arming them, so no timer fires during a replay.
// Nothing here judges; it only writes the transcript.

import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Receipt, SayFile, Tool, ToolContext, ToolSpec, World, WorldEvent } from "../contracts.js";

/** One line of transcript.jsonl: a say, a wake the entity scheduled, or a wake it cancelled. */
export type TranscriptRow =
  | { atMs: number; place: string; text: string; replyTo?: string }
  | { wake: { id: string; atMs: number; why: string; scheduledIn: string } }
  | { wake_cancelled: { id: string } };

const WAKE_LIMIT_MINUTES = 60 * 24 * 365 * 10;

/** Shared by every replay world: the clock, the transcript file, and the wakes recorded so far. */
export class ReplayRecorder {
  private clockMs: number;
  private readonly open = new Map<string, { atMs: number; why: string; scheduledIn: string }>();
  private sayCount = 0;
  private wakeCount = 0;

  constructor(
    readonly path: string,
    startMs: number,
  ) {
    this.clockMs = startMs;
    writeFileSync(path, "", "utf8");
  }

  now(): number {
    return this.clockMs;
  }

  /** Moves the clock to an event's time. The clock only moves forward. */
  advanceTo(atMs: number): void {
    if (atMs > this.clockMs) this.clockMs = atMs;
  }

  record(row: TranscriptRow): void {
    if ("text" in row) this.sayCount += 1;
    if ("wake" in row) this.wakeCount += 1;
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, "utf8");
  }

  /** How many says and wakes were written so far. */
  counts(): { says: number; wakes: number } {
    return { says: this.sayCount, wakes: this.wakeCount };
  }

  /** Wakes that were scheduled and not cancelled, by id. */
  openWakes(): ReadonlyMap<string, { atMs: number; why: string; scheduledIn: string }> {
    return this.open;
  }

  scheduleWake(wake: { id: string; atMs: number; why: string; scheduledIn: string }): void {
    this.open.set(wake.id, { atMs: wake.atMs, why: wake.why, scheduledIn: wake.scheduledIn });
    this.record({ wake: { ...wake } });
  }

  cancelWake(id: string): boolean {
    if (!this.open.delete(id)) return false;
    this.record({ wake_cancelled: { id } });
    return true;
  }
}

export class ReplayWorld implements World {
  private emit: ((event: WorldEvent) => void) | undefined;

  /**
   * `offersWakeTools` is true for one world only: two worlds offering the same tool name would be refused by the
   * entity at start.
   */
  constructor(
    readonly id: string,
    private readonly recorder: ReplayRecorder,
    private readonly offersWakeTools = false,
  ) {}

  async start(emit: (event: WorldEvent) => void): Promise<void> {
    this.emit = emit;
  }

  async stop(): Promise<void> {
    this.emit = undefined;
  }

  /** The harness feeds one event at a time through here. */
  feed(event: WorldEvent): void {
    if (this.emit === undefined) throw new Error(`The replay world ${this.id} was not started.`);
    this.emit(event);
  }

  async say(place: string, text: string, options?: { replyTo?: string; files?: SayFile[] }): Promise<Receipt> {
    if (options?.files !== undefined && options.files.length > 0) {
      return { ok: false, summary: "This place cannot carry pictures, so nothing was sent.", refused: { code: "no_pictures", reason: "this place cannot carry pictures" } };
    }
    const atMs = this.recorder.now();
    const row: TranscriptRow =
      options?.replyTo === undefined ? { atMs, place, text } : { atMs, place, text, replyTo: options.replyTo };
    this.recorder.record(row);
    return { ok: true, summary: `Said to ${place}.`, data: { place, chars: text.length } };
  }

  tools(): Tool[] {
    if (!this.offersWakeTools) return [];
    return [replayWakeTool(this.recorder), replayCancelWakeTool(this.recorder)];
  }

  now(): string {
    return "replay";
  }
}

// ---------------------------------------------------------------------------------------------------
// Wake tools. The model's schedule_wake and cancel_wake calls are renamed to these by the replay model wrapper,
// so the entity's own wake timers are never armed. The receipts read like the real ones.

export const REPLAY_WAKE = "replay_wake";
export const REPLAY_CANCEL_WAKE = "replay_cancel_wake";

const WAKE_PARAMETERS = {
  type: "object",
  properties: {
    in_minutes: { type: "number", minimum: 0, description: "Minutes from now." },
    at_iso: { type: "string", description: "A date and time, such as 2026-10-12T09:00:00+03:00." },
    why: { type: "string", description: "Why you are waking, in your own words." },
  },
  required: ["why"],
};

function replayWakeTool(recorder: ReplayRecorder): Tool {
  const spec: ToolSpec = {
    name: REPLAY_WAKE,
    description:
      "Wake yourself later, in a thread of your own, with a reason you will read then. Give in_minutes (from now) or at_iso (a date and time with its zone).",
    parameters: WAKE_PARAMETERS,
  };
  return {
    spec,
    async run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt> {
      const why = typeof args["why"] === "string" ? args["why"].trim() : "";
      if (why === "") return refused("The reason is missing.", "bad_arguments");
      const hasMinutes = args["in_minutes"] !== undefined;
      const hasAt = args["at_iso"] !== undefined;
      if (hasMinutes === hasAt) return refused("Give either in_minutes or at_iso, not both.", "bad_arguments");
      let atMs: number;
      if (hasMinutes) {
        const minutes = args["in_minutes"];
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > WAKE_LIMIT_MINUTES) {
          return refused("in_minutes must be a number of minutes from 0 up to ten years.", "bad_arguments");
        }
        atMs = Math.round(recorder.now() + minutes * 60_000);
      } else {
        const parsed = typeof args["at_iso"] === "string" ? Date.parse(args["at_iso"]) : Number.NaN;
        if (Number.isNaN(parsed)) return refused("at_iso must be a date and time with its zone.", "bad_arguments");
        atMs = parsed;
      }
      const id = randomUUID().slice(0, 8);
      recorder.scheduleWake({ id, atMs, why, scheduledIn: context.thread });
      const when = new Date(atMs).toISOString();
      return { ok: true, summary: `Wake ${id} set for ${when}.`, data: { id, atMs } };
    },
  };
}

function replayCancelWakeTool(recorder: ReplayRecorder): Tool {
  const spec: ToolSpec = {
    name: REPLAY_CANCEL_WAKE,
    description: "Cancel a wake you scheduled, by its id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The wake's id." } },
      required: ["id"],
    },
  };
  return {
    spec,
    async run(args: Record<string, unknown>): Promise<Receipt> {
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      if (id === "") return refused("The wake id is missing.", "bad_arguments");
      const wake = recorder.openWakes().get(id);
      if (wake === undefined) return refused("There is no wake with that id.", "not_found");
      recorder.cancelWake(id);
      return { ok: true, summary: `Cancelled wake ${id}: ${wake.why}`, data: { id } };
    },
  };
}

function refused(summary: string, code: string): Receipt {
  return { ok: false, summary, refused: { code, reason: summary } };
}
