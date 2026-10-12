// The turn loop. The mind acts only through tools: each model reply is either tool calls (run in order, each
// with a receipt the model reads) or no tool call (the turn ends). The loop also ends when the model calls
// end_turn, when the ceiling is reached, when the model fails, or when the signal aborts.
// Every step is written to the river, so the turn can be read back later.

import { createHash } from "node:crypto";
import {
  ModelError,
  type Ceiling,
  type ChatMessage,
  type ImagePart,
  type ModelErrorKind,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type Notebook,
  type PromptLayoutEntry,
  type Receipt,
  type River,
  type RiverRowInput,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolSpec,
  type TokenCount,
  type TurnEndReason,
  type TurnResult,
} from "../contracts.js";
import { MalformedToolBlock } from "../model/emulated-tools.js";

export const END_TURN = "end_turn";
/** How much of a receipt's data JSON the river keeps. The SHA-256 of all of it is kept beside the start. */
const RECEIPT_KEPT_BYTES = 2048;

/** The loop's own tool. Always offered; calling it ends the turn once its receipt is ok. */
export const endTurnSpec: ToolSpec = {
  name: END_TURN,
  description:
    "End this turn. Call it when you have nothing more to do now. You may call it in the same reply as your last acts. " +
    "If any of them is refused or held, the turn stays open so you can see why. You may leave a short note for yourself.",
  parameters: {
    type: "object",
    properties: {
      note: { type: "string", description: "Optional. A short note for yourself, kept in your record." },
    },
  },
};

const endTurnTool: Tool = {
  spec: endTurnSpec,
  async run(args): Promise<Receipt> {
    if (args["note"] !== undefined && typeof args["note"] !== "string") {
      return {
        ok: false,
        summary: "The note must be text, so the turn is still open.",
        refused: { code: "bad_arguments", reason: "note must be a string" },
      };
    }
    const data = typeof args["note"] === "string" ? { note: args["note"] } : {};
    return { ok: true, summary: "This turn is ending.", data };
  },
};

/** end_turn's receipt when an earlier call in its reply was refused or held: the turn stays open and the loop goes on. */
function reopenedReceipt(): Receipt {
  return {
    ok: false,
    summary: "The turn stays open.",
    refused: { code: "reopened", reason: "An earlier call in this reply was refused or held: see its receipt." },
  };
}

export type RunTurnInput = {
  model: ModelPort;
  tools: Tool[];
  system: string;
  /** The named parts of `system`, when the caller built it from parts. Read by the witness and the cache marks; the text is unchanged. */
  systemLayout?: PromptLayoutEntry[];
  history: ChatMessage[];
  event: string;
  /** The named parts of `event`, when the caller built it from parts. Read by the witness and the cache marks; the text is unchanged. */
  eventLayout?: PromptLayoutEntry[];
  thread: string;
  river: River;
  notebook: Notebook;
  ceiling: Ceiling;
  nowMs: () => number;
  turnId: string;
  signal?: AbortSignal;
  effort?: ModelRequest["effort"];
};

export type RunTurnOutput = { result: TurnResult; messages: ChatMessage[] };

/** Runs one turn and returns its result. */
export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  return (await runTurnWithMessages(input)).result;
}

/** Runs one turn and also returns the full message list the model saw and produced. */
export async function runTurnWithMessages(input: RunTurnInput): Promise<RunTurnOutput> {
  const { model, system, systemLayout, history, event, eventLayout, thread, river, notebook, ceiling, nowMs, turnId, signal, effort } =
    input;

  const ownTools = new Map<string, Tool>();
  for (const tool of input.tools) {
    const name = tool.spec.name;
    if (name === END_TURN) throw new Error(`"${END_TURN}" belongs to the loop; no tool may use that name.`);
    if (ownTools.has(name)) throw new Error(`Two tools share the name "${name}".`);
    ownTools.set(name, tool);
  }
  const specs: ToolSpec[] = [...input.tools.map((tool) => tool.spec), endTurnSpec];

  const messages: ChatMessage[] = [
    { role: "system", content: system, ...(systemLayout === undefined ? {} : { layout: systemLayout }) },
    ...history,
    { role: "user", content: event, ...(eventLayout === undefined ? {} : { layout: eventLayout }) },
  ];
  const thoughts: string[] = [];
  /** Pictures a tool handed over for the model to see on its next call. Shown once, then gone. */
  const pictures: ImagePart[] = [];
  const receipts: TurnResult["receipts"] = [];
  const skipped: string[] = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let endedBy: TurnEndReason | undefined;
  let error: string | undefined;
  let errorKind: ModelErrorKind | undefined;
  let thrown: { error: unknown } | undefined;
  // The backup model answers for one turn at most; the river says so once, not once per call.
  let backupNoted = false;
  // Tokens the provider reported, summed over the turn's calls; the backup's share is kept apart for the cost.
  let tokens: TokenCount | undefined;
  let backupTokens: TokenCount | undefined;
  // The cached-prompt counts, kept apart from the meter's token counts and written beside them when reported.
  let cache: { hit?: number; miss?: number } | undefined;

  const write = (row: Omit<RiverRowInput, "thread" | "atMs">): void => {
    river.append({ ...row, thread, atMs: nowMs() });
  };

  const execute = async (call: ToolCall): Promise<Receipt> => {
    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) return parsed.receipt;
    const tool = ownTools.get(call.name) ?? (call.name === END_TURN ? endTurnTool : undefined);
    if (tool === undefined) {
      const names = [...ownTools.keys(), END_TURN].join(", ");
      return {
        ok: false,
        summary: `There is no tool called ${call.name}.`,
        refused: { code: "unknown_tool", reason: `The tools you can call are: ${names}.` },
      };
    }
    const context: ToolContext = { thread, turnId, nowMs: nowMs(), river, notebook, signal };
    try {
      return await tool.run(parsed.value, context);
    } catch (err) {
      const message = messageOf(err);
      return { ok: false, summary: `The tool failed: ${message}`, refused: { code: "tool_error", reason: message } };
    }
  };

  // `held` is a receipt the loop writes without running the call (end_turn reopened by an earlier refusal).
  const runCall = async (call: ToolCall, held?: Receipt): Promise<Receipt> => {
    toolCalls += 1;
    write({ kind: "tool_call", source: "self", text: call.name, data: { args: call.arguments, turnId, callId: call.id } });
    // Pictures never go into the record or the tool message: only the model sees them, on the next call.
    const { images, ...receipt } = held ?? (await execute(call));
    if (images !== undefined) pictures.push(...images);
    write({
      kind: "receipt",
      source: "body",
      text: receipt.summary,
      data: {
        tool: call.name,
        ok: receipt.ok,
        ...(receipt.refused === undefined ? {} : { refused: receipt.refused }),
        turnId,
        callId: call.id,
        ...keptData(receipt.data),
      },
    });
    receipts.push({ tool: call.name, receipt });
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(receipt) });
    return receipt;
  };

  // A call the loop did not run still gets a tool message, so the message list stays valid for the model.
  const skip = (call: ToolCall, reason: string): void => {
    skipped.push(call.name);
    const receipt: Receipt = {
      ok: false,
      summary: "This call was not run.",
      refused: { code: "not_run", reason },
    };
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(receipt) });
  };

  write({ kind: "turn", source: "body", data: { phase: "start", turnId } });

  try {
    while (endedBy === undefined) {
      if (signal?.aborted) {
        endedBy = "aborted";
        break;
      }
      if (modelCalls >= ceiling.maxModelCalls || toolCalls >= ceiling.maxToolCalls) {
        endedBy = "ceiling";
        break;
      }

      modelCalls += 1;
      let response: ModelResponse;
      try {
        const shown: ChatMessage[] = pictures.length === 0 ? messages.slice() : [...messages, pictureMessage(pictures.splice(0))];
        response = await model.complete({ messages: shown, tools: specs, toolChoice: "auto", effort }, signal);
      } catch (err) {
        if (signal?.aborted || (err instanceof ModelError && err.kind === "aborted")) {
          endedBy = "aborted";
          break;
        }
        if (err instanceof MalformedToolBlock) {
          // A tool block the host could not read: the model's words are kept, and the model is told why and may try
          // again. Each try is a model call, so the ceiling still ends a model that keeps failing.
          if (err.reply !== null && err.reply.trim() !== "") {
            thoughts.push(err.reply);
            write({ kind: "note", source: "self", text: err.reply, data: { thought: true, turnId } });
          }
          messages.push({ role: "assistant", content: err.reply });
          write({ kind: "note", source: "body", text: err.note, data: { turnId, kind: "malformed_tool_block" } });
          messages.push({ role: "user", content: err.note });
          continue;
        }
        endedBy = "model_error";
        error = messageOf(err);
        errorKind = err instanceof ModelError ? err.kind : undefined;
        write({
          kind: "note",
          source: "body",
          text: `The model could not answer: ${error}`,
          data: { turnId, kind: err instanceof ModelError ? err.kind : "error" },
        });
        break;
      }

      if (response.usage !== undefined) {
        const counted = countOf(response.usage);
        tokens = addTokens(tokens, counted);
        cache = addCache(cache, response.usage);
        if (response.servedBy !== undefined) backupTokens = addTokens(backupTokens, counted);
      }
      if (response.servedBy !== undefined && !backupNoted) {
        backupNoted = true;
        write({
          kind: "note",
          source: "body",
          text: `Your main model did not answer; your backup model (${response.servedBy}) answered this turn.`,
          data: { turnId, kind: "backup_model", model: response.servedBy },
        });
      }
      const calls = response.toolCalls ?? [];
      const content = response.content;
      // The reasoning summary is part of the Lar's thinking record; it is kept, never shown to anyone as speech.
      if (response.reasoning !== undefined) {
        write({ kind: "note", source: "self", text: response.reasoning, data: { thought: true, reasoning: true, turnId } });
      }
      if (typeof content === "string" && content.trim() !== "") {
        thoughts.push(content);
        write({ kind: "note", source: "self", text: content, data: { thought: true, turnId } });
      }
      messages.push({
        role: "assistant",
        content,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
        ...(response.providerState ? { providerState: response.providerState } : {}),
      });

      if (calls.length === 0) {
        endedBy = "no_tool_call";
        break;
      }

      // Calls run in order, except end_turn: it rides with the last acts, so it runs after every other call of this reply.
      // If any other call was refused, held or not run, the turn stays open and end_turn's receipt says so. The ceiling
      // still applies to every call.
      const others = calls.filter((call) => call.name !== END_TURN);
      const endings = calls.filter((call) => call.name === END_TURN);
      let earlierRefused = false;
      for (const call of [...others, ...endings]) {
        if (signal?.aborted) {
          endedBy ??= "aborted";
          skip(call, "The turn was aborted before this call.");
          earlierRefused = true;
          continue;
        }
        if (toolCalls >= ceiling.maxToolCalls) {
          endedBy ??= "ceiling";
          skip(call, "The turn reached its tool-call limit before this call.");
          earlierRefused = true;
          continue;
        }
        if (call.name !== END_TURN) {
          const receipt = await runCall(call);
          if (!receipt.ok) earlierRefused = true;
          continue;
        }
        if (earlierRefused) {
          await runCall(call, reopenedReceipt());
          continue;
        }
        const receipt = await runCall(call);
        if (receipt.ok) endedBy ??= "end_turn";
      }
    }
  } catch (err) {
    thrown = { error: err };
    endedBy ??= "model_error";
    error ??= messageOf(err);
  }

  const finalReason: TurnEndReason = endedBy ?? "model_error";
  if (finalReason === "ceiling") {
    write({
      kind: "note",
      source: "body",
      text: "Turn stopped at the loop ceiling.",
      data: { turnId, ...(skipped.length > 0 ? { skipped } : {}) },
    });
  }
  // The meter: the model's id, the effort asked for, and the tokens the provider reported. Only what was reported is written.
  const meter = {
    model: model.info.id,
    ...(effort === undefined ? {} : { effort }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(backupTokens === undefined ? {} : { backupTokens }),
    ...(cache?.hit === undefined ? {} : { cacheHitTokens: cache.hit }),
    ...(cache?.miss === undefined ? {} : { cacheMissTokens: cache.miss }),
  };
  write({
    kind: "turn",
    source: "body",
    data: { phase: "end", endedBy: finalReason, turnId, modelCalls, toolCalls, ...meter },
  });
  if (thrown !== undefined) throw thrown.error;

  const result: TurnResult = {
    turnId,
    thread,
    endedBy: finalReason,
    modelCalls,
    toolCalls,
    receipts,
    thoughts,
    ...meter,
    backupUsed: backupNoted,
    ...(error === undefined ? {} : { error }),
    ...(errorKind === undefined ? {} : { errorKind }),
  };
  return { result, messages };
}

/**
 * A receipt's data as the river keeps it: the start of its JSON (up to RECEIPT_KEPT_BYTES), the JSON's whole length, and
 * its SHA-256. The record says what the tool returned without holding all of it, and the hash shows whether a copy matches.
 */
function keptData(data: Receipt["data"]): Record<string, unknown> {
  if (data === undefined) return {};
  const json = JSON.stringify(data);
  return {
    dataJson: clipBytes(json, RECEIPT_KEPT_BYTES),
    dataBytes: Buffer.byteLength(json),
    dataSha256: createHash("sha256").update(json).digest("hex"),
  };
}

/** The longest start of a text that fits in max bytes, cut between characters so no character is split. */
function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let kept = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max) break;
    kept += char;
    bytes += size;
  }
  return kept;
}

/** A call's reported counts, under the names a turn's meter uses. */
export function countOf(usage: NonNullable<ModelResponse["usage"]>): TokenCount {
  return {
    ...(usage.inputTokens === undefined ? {} : { prompt: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { completion: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { total: usage.totalTokens }),
  };
}

/** Adds one call's cached-prompt counts to a turn's. A count nobody reported stays absent. */
function addCache(
  sum: { hit?: number; miss?: number } | undefined,
  usage: NonNullable<ModelResponse["usage"]>,
): { hit?: number; miss?: number } | undefined {
  if (usage.cacheHitTokens === undefined && usage.cacheMissTokens === undefined) return sum;
  const next: { hit?: number; miss?: number } = { ...sum };
  if (usage.cacheHitTokens !== undefined) next.hit = (next.hit ?? 0) + usage.cacheHitTokens;
  if (usage.cacheMissTokens !== undefined) next.miss = (next.miss ?? 0) + usage.cacheMissTokens;
  return next;
}

/**
 * Adds one call's counts to a turn's. A count that nobody reported stays absent, and is not counted as zero: a call that
 * reported nothing leaves the sum as it was, even when the sum is still absent.
 */
export function addTokens(sum: TokenCount | undefined, counted: TokenCount): TokenCount | undefined {
  if (counted.prompt === undefined && counted.completion === undefined && counted.total === undefined) return sum;
  const next: TokenCount = { ...sum };
  if (counted.prompt !== undefined) next.prompt = (next.prompt ?? 0) + counted.prompt;
  if (counted.completion !== undefined) next.completion = (next.completion ?? 0) + counted.completion;
  if (counted.total !== undefined) next.total = (next.total ?? 0) + counted.total;
  return next;
}

/** The one call that carries pictures the tools handed over: they are not added to the messages kept for the turn. */
function pictureMessage(images: ImagePart[]): ChatMessage {
  return {
    role: "user",
    content: `Here ${images.length === 1 ? "is the picture" : "are the pictures"} you asked to look at. You see ${images.length === 1 ? "it" : "them"} on this call only.`,
    images,
  };
}

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; receipt: Receipt };

function parseArguments(raw: string): Parsed {
  // Some models send nothing at all for a tool with no arguments; that is read as an empty object.
  const text = raw.trim() === "" ? "{}" : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      receipt: {
        ok: false,
        summary: "Your arguments were not valid JSON.",
        refused: { code: "bad_arguments", reason: messageOf(err) },
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      receipt: {
        ok: false,
        summary: "Your arguments must be a JSON object.",
        refused: { code: "bad_arguments", reason: "The arguments were not a JSON object." },
      },
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
