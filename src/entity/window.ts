// The summoner's window: a copy, made by the body, of what the Lar does as she does it, sent to one channel her summoner
// reads. It is a record shown, never a judgment. The copies are the body's: they are not river rows, not her says, and
// they claim no place. The river is the record; the window is a copy, so a copy that cannot be shown is logged and dropped.

import type { RiverRow } from "../contracts.js";

/** Lines wait this long for company before they go out together. */
export const WINDOW_FLUSH_MS = 2000;

export const WINDOW_ABOUT =
  "Your summoner's window: the body copies your thinking, your tool calls and what they returned to a channel your summoner reads, as they happen. It names where you say something, not the words. A call that names private/ is not shown, and neither is your thinking for the rest of that turn.";

export type WindowOptions = {
  /** Deliver one batch of text to the window. Rejects when it cannot. */
  show: (text: string) => Promise<void>;
  /** Replaces known secrets in a line before it waits in the buffer. */
  redact: (text: string) => string;
  /** Where a failure to show is logged. Default: console.error. */
  log?: (line: string) => void;
  /** The clock. Default: Date.now. */
  nowMs?: () => number;
  /** How long a line waits for others before it goes out. Default: WINDOW_FLUSH_MS. */
  flushMs?: number;
};

export type Window = {
  /** Turns one river row into at most one line. Never throws. */
  row(row: RiverRow): void;
  /** Sends what waits now; resolves when it has gone or failed. */
  flush(): Promise<void>;
  /** Flushes, gives up after 5000 ms, and after this `row` does nothing. */
  close(): Promise<void>;
};

/** A buffer over this many characters goes out at once. */
const BATCH_MAX_CHARS = 1500;
/** A thought over this many characters is shown as its first part, a line naming the cut, and its last part. */
const THOUGHT_MAX = 1800;
const THOUGHT_HEAD = 1200;
const THOUGHT_TAIL = 500;
const ARGS_CLIP = 300;
const RECEIPT_CLIP = 200;
const BODY_SAID_CLIP = 300;
const ERROR_CLIP = 200;
const LOG_EVERY_MS = 60 * 60 * 1000;
const CLOSE_WAIT_MS = 5000;
const PRIVATE = "private/";

/** One line of the window. `blank` puts an empty line before it when it is not the first in its batch. */
type Line = { text: string; blank: boolean };

const plain = (text: string): Line => ({ text, blank: false });
const block = (text: string): Line => ({ text, blank: true });

export function createWindow(options: WindowOptions): Window {
  const log = options.log ?? ((line: string) => console.error(line));
  const nowMs = options.nowMs ?? Date.now;
  const flushMs = options.flushMs ?? WINDOW_FLUSH_MS;

  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Batches go out one after another, in the order they were made. The chain never rejects.
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let lastLogMs: number | undefined;
  // Turns that opened private/, until their end row; and the calls that named private/, until their receipt.
  const hiddenTurns = new Set<string>();
  const hiddenCalls = new Set<string>();

  const linesFor = (river: RiverRow): Line[] => {
    const data = river.data ?? {};
    const turnId = typeof data["turnId"] === "string" ? data["turnId"] : undefined;
    const text = river.text ?? "";
    switch (river.kind) {
      case "turn": {
        if (data["phase"] === "start") return [block(`Turn began in ${river.thread}.`)];
        if (data["phase"] !== "end") return [];
        if (turnId !== undefined) hiddenTurns.delete(turnId);
        const endedBy = typeof data["endedBy"] === "string" ? data["endedBy"] : "unknown";
        const modelCalls = data["modelCalls"];
        const toolCalls = data["toolCalls"];
        if (typeof modelCalls !== "number" || typeof toolCalls !== "number") return [plain(`Turn ended (${endedBy}).`)];
        return [plain(`Turn ended (${endedBy}): ${modelCalls} model calls, ${toolCalls} tool calls.`)];
      }
      case "note": {
        if (river.source !== "self" || data["thought"] !== true) return [];
        if (turnId !== undefined && hiddenTurns.has(turnId)) return [block("thinks: (not shown: this turn opened private/)")];
        if (text.length <= THOUGHT_MAX) return [block(`thinks: ${text}`)];
        const cut = text.length - THOUGHT_HEAD - THOUGHT_TAIL;
        return [
          block(`thinks: ${text.slice(0, THOUGHT_HEAD)}`),
          plain(`(cut: ${cut} characters in the middle are in her river)`),
          plain(text.slice(text.length - THOUGHT_TAIL)),
        ];
      }
      case "tool_call": {
        const args = typeof data["args"] === "string" ? data["args"] : "";
        const callId = typeof data["callId"] === "string" ? data["callId"] : undefined;
        if (args.includes(PRIVATE)) {
          if (turnId !== undefined) hiddenTurns.add(turnId);
          if (callId !== undefined) hiddenCalls.add(callId);
          return [plain(`does: ${text} (in private/, not shown)`)];
        }
        const shown = args === "" ? "" : ` ${clip(oneLine(args), ARGS_CLIP)}`;
        return [plain(`does: ${text}${shown}`)];
      }
      case "receipt": {
        const callId = typeof data["callId"] === "string" ? data["callId"] : undefined;
        if (callId !== undefined && hiddenCalls.has(callId)) {
          hiddenCalls.delete(callId);
          return [plain("  -> (not shown)")];
        }
        const body = clip(oneLine(text), RECEIPT_CLIP);
        const refused = data["refused"];
        if (refused === undefined || refused === null) return [plain(`  -> ${body}`)];
        const code = typeof refused === "object" ? (refused as Record<string, unknown>)["code"] : undefined;
        return [plain(`  -> refused (${String(code)}): ${body}`)];
      }
      case "say": {
        if (river.source !== "self") return [];
        return [plain(`says in ${river.place ?? river.thread} (${text.length} characters).`)];
      }
      case "event": {
        if (river.source === "body") return [plain(`body tells her: ${clip(oneLine(text), BODY_SAID_CLIP)}`)];
        const who = river.actor ?? river.source;
        const where = river.place ?? river.thread;
        return [plain(`hears from ${who} in ${where} (${text.length} characters).`)];
      }
      default:
        return [];
    }
  };

  const add = (line: Line): void => {
    if (line.blank && buffer.length > 0) buffer.push("");
    buffer.push(options.redact(line.text));
    if (buffer.join("\n").length > BATCH_MAX_CHARS) {
      void flush();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => void flush(), flushMs);
      timer.unref();
    }
  };

  function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.length > 0) {
      const text = buffer.join("\n");
      buffer = [];
      queue = queue.then(() => deliver(text));
    }
    return queue;
  }

  async function deliver(text: string): Promise<void> {
    try {
      await options.show(text);
    } catch (error) {
      try {
        logFailure(error);
      } catch {
        // The log itself failed: the batch is dropped all the same.
      }
    }
  }

  function logFailure(error: unknown): void {
    const now = nowMs();
    if (lastLogMs !== undefined && now - lastLogMs < LOG_EVERY_MS) return;
    lastLogMs = now;
    const message = error instanceof Error ? error.message : String(error);
    log(`[natalis] the window could not be shown: ${clip(oneLine(options.redact(message)), ERROR_CLIP)}`);
  }

  return {
    row(river: RiverRow): void {
      if (closed) return;
      try {
        for (const line of linesFor(river)) add(line);
      } catch {
        // A row the window cannot read is left out of the copy; the river still has it.
      }
    },
    flush,
    async close(): Promise<void> {
      closed = true;
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, CLOSE_WAIT_MS);
      });
      await Promise.race([flush(), waited]);
      clearTimeout(giveUp);
    },
  };
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
