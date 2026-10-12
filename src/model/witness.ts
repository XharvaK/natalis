// The cache witness: one count row per model call, so the summoner can see whether the provider's cache broke on our side
// (a part of the prompt changed that should not have) or on the provider's (an idle gap or an eviction). It reads a
// request's parts (name, class, length and a SHA-256 of the text), keeps the parts of the last MEMORY requests in memory,
// shared by every thread of one runtime since the provider's cache is shared too, and writes one row after each call that
// returns. The text is never kept. A failure in the witness never fails a call, and a call that throws writes no row.

import { createHash } from "node:crypto";
import { partsOfMessage, type MessagePart } from "../context/layout.js";
import type { ChatMessage, ModelPort, ModelRequest, ModelResponse, PromptPartClass } from "../contracts.js";
import type { CallRow, ThreadKind } from "../river/ledger.js";
import { markCount } from "./cache-marks.js";

/** How many earlier requests the witness remembers, in memory. */
const MEMORY = 16;
/** A part that breaks the first call of a turn is named in the service log at most this often, per part. */
const LOG_EVERY_MS = 60 * 60 * 1000;

type PartKey = { name: string; cls: PromptPartClass; chars: number; hash: string };
type Remembered = { atMs: number; parts: PartKey[] };

/** What the witness saw of one request before the call: its parts, and the earlier request it matched. */
export type Observation = {
  atMs: number;
  parts: PartKey[];
  /** How many leading parts the earlier request shares with this one. */
  run: number;
  stableChars: number;
  matched: Remembered | undefined;
};

export type WitnessOptions = {
  /** Writes one row (counts only). A row that fails to write is dropped: the call is not failed. */
  write: (row: CallRow) => void;
  now?: () => number;
  /** The service log. Defaults to the console's error stream, which is where the entity logs. */
  log?: (line: string) => void;
};

export class CacheWitness {
  private readonly remembered: Remembered[] = [];
  private readonly lastLogged = new Map<string, number>();
  private readonly write: (row: CallRow) => void;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: WitnessOptions) {
    this.write = options.write;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line: string) => console.error(`[natalis] ${line}`));
  }

  /** Reads a request's parts and finds the earlier request with the longest run of the same parts. Writes nothing. */
  observe(messages: readonly ChatMessage[]): Observation | undefined {
    try {
      const atMs = this.now();
      const parts = messages.flatMap(partsOfMessage).map(keyOf);
      // With no shared part at all, the newest earlier request is the one compared with: its break is at the first part.
      let run = 0;
      let matched: Remembered | undefined = this.remembered.at(-1);
      // Newest first, so an earlier request of the same length wins the tie.
      for (let i = this.remembered.length - 1; i >= 0; i -= 1) {
        const earlier = this.remembered[i];
        if (earlier === undefined) continue;
        const common = commonRun(parts, earlier.parts);
        if (common > run) {
          run = common;
          matched = earlier;
        }
      }
      return { atMs, parts, run, stableChars: parts.slice(0, run).reduce((sum, part) => sum + part.chars, 0), matched };
    } catch {
      return undefined;
    }
  }

  /** Writes the row for a call that returned, remembers its parts, and logs a break in the slow parts. Never throws. */
  settle(
    observed: Observation,
    response: ModelResponse,
    context: { threadKind: ThreadKind; turnCall: number; model: string; marks: number },
  ): void {
    try {
      this.remember(observed);
    } catch {
      // Remembering is only for the next call's comparison; a failure costs that comparison, nothing else.
    }
    try {
      const row = rowOf(observed, response, context);
      this.write(row);
      this.logBreak(row, context.turnCall, observed.matched !== undefined);
    } catch {
      // The row is evidence, not a condition of the call: a failed write is dropped.
    }
  }

  private remember(observed: Observation): void {
    this.remembered.push({ atMs: observed.atMs, parts: observed.parts });
    if (this.remembered.length > MEMORY) this.remembered.splice(0, this.remembered.length - MEMORY);
  }

  /** The first call of a turn that breaks a fixed or notes part is named in the service log, at most once an hour per part. */
  private logBreak(row: CallRow, turnCall: number, matched: boolean): void {
    if (turnCall !== 1 || !matched || row.breakPart === undefined) return;
    if (row.breakClass !== "fixed" && row.breakClass !== "notes") return;
    const last = this.lastLogged.get(row.breakPart);
    if (last !== undefined && row.atMs - last < LOG_EVERY_MS) return;
    this.lastLogged.set(row.breakPart, row.atMs);
    this.log(
      `The prompt's ${row.breakClass} part "${row.breakPart}" changed on the first call of a turn, so the provider's cached start broke there.`,
    );
  }
}

export function createWitness(options: WitnessOptions): CacheWitness {
  return new CacheWitness(options);
}

/**
 * The port the turns run on, watched: each call is observed before it is sent and settled after it returns. The witness
 * is shared (one per runtime); `threadKind` says where the turn is. `cacheMarks` says whether the adapter sends marks,
 * so the row counts them. A call that throws is passed on unchanged and writes nothing.
 */
export function withWitness(
  port: ModelPort,
  witness: CacheWitness,
  threadKind: ThreadKind,
  options: { cacheMarks?: boolean } = {},
): ModelPort {
  let turnCall = 0;
  const routing = port.routing;
  return {
    info: port.info,
    ...(routing === undefined ? {} : { routing: () => routing.call(port) }),
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      turnCall += 1;
      const observed = witness.observe(request.messages);
      const response = await port.complete(request, signal);
      if (observed !== undefined) {
        const marks = options.cacheMarks === true ? markCount(request.messages) : 0;
        witness.settle(observed, response, { threadKind, turnCall, model: port.info.id, marks });
      }
      return response;
    },
  };
}

function keyOf(part: MessagePart): PartKey {
  return { name: part.name, cls: part.cls, chars: part.text.length, hash: sha256(part.text) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** How many leading parts two requests share: the same name, class, length and text hash. */
function commonRun(a: readonly PartKey[], b: readonly PartKey[]): number {
  const limit = Math.min(a.length, b.length);
  let run = 0;
  while (run < limit) {
    const x = a[run];
    const y = b[run];
    if (x === undefined || y === undefined) break;
    if (x.name !== y.name || x.cls !== y.cls || x.chars !== y.chars || x.hash !== y.hash) break;
    run += 1;
  }
  return run;
}

function rowOf(
  observed: Observation,
  response: ModelResponse,
  context: { threadKind: ThreadKind; turnCall: number; model: string; marks: number },
): CallRow {
  const { parts, run, matched } = observed;
  const promptChars = parts.reduce((sum, part) => sum + part.chars, 0);
  const next = parts[run];
  const partSizes: Record<string, number> = {};
  for (const part of parts) partSizes[part.name] = (partSizes[part.name] ?? 0) + part.chars;
  const row: CallRow = {
    atMs: observed.atMs,
    threadKind: context.threadKind,
    turnCall: context.turnCall,
    model: context.model,
    promptChars,
    stableChars: observed.stableChars,
    marks: context.marks,
    partSizes,
  };
  if (next !== undefined) {
    row.breakPart = next.name;
    row.breakClass = next.cls;
  }
  if (matched !== undefined) row.idleMs = Math.max(0, observed.atMs - matched.atMs);
  const usage = response.usage;
  if (usage?.inputTokens !== undefined) row.promptTokens = usage.inputTokens;
  if (usage?.cacheHitTokens !== undefined) row.cacheHitTokens = usage.cacheHitTokens;
  if (usage?.cacheMissTokens !== undefined) row.cacheMissTokens = usage.cacheMissTokens;
  return row;
}
