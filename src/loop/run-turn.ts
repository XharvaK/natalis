// The turn loop. The mind acts only through tools: each model reply is either tool calls (run in order, each
// with a receipt the model reads) or no tool call (the turn ends). The loop also ends when the model calls
// end_turn, when the ceiling is reached, when the model fails, or when the signal aborts.
// Every step is written to the river, so the turn can be read back later.

import {
  ModelError,
  type Ceiling,
  type ChatMessage,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type Notebook,
  type Receipt,
  type River,
  type RiverRowInput,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolSpec,
  type TurnEndReason,
  type TurnResult,
} from "../contracts.js";

export const END_TURN = "end_turn";

/** The loop's own tool. Always offered; calling it ends the turn once its receipt is ok. */
export const endTurnSpec: ToolSpec = {
  name: END_TURN,
  description:
    "End this turn. Call it when you have nothing more to do now. You may leave a short note for yourself.",
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

export type RunTurnInput = {
  model: ModelPort;
  tools: Tool[];
  system: string;
  history: ChatMessage[];
  event: string;
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
  const { model, system, history, event, thread, river, notebook, ceiling, nowMs, turnId, signal, effort } = input;

  const ownTools = new Map<string, Tool>();
  for (const tool of input.tools) {
    const name = tool.spec.name;
    if (name === END_TURN) throw new Error(`"${END_TURN}" belongs to the loop; no tool may use that name.`);
    if (ownTools.has(name)) throw new Error(`Two tools share the name "${name}".`);
    ownTools.set(name, tool);
  }
  const specs: ToolSpec[] = [...input.tools.map((tool) => tool.spec), endTurnSpec];

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: event },
  ];
  const thoughts: string[] = [];
  const receipts: TurnResult["receipts"] = [];
  const skipped: string[] = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let endedBy: TurnEndReason | undefined;
  let error: string | undefined;
  let thrown: { error: unknown } | undefined;

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

  const runCall = async (call: ToolCall): Promise<Receipt> => {
    toolCalls += 1;
    write({ kind: "tool_call", source: "self", text: call.name, data: { args: call.arguments, turnId, callId: call.id } });
    const receipt = await execute(call);
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
        response = await model.complete({ messages: messages.slice(), tools: specs, toolChoice: "auto", effort }, signal);
      } catch (err) {
        if (signal?.aborted || (err instanceof ModelError && err.kind === "aborted")) {
          endedBy = "aborted";
          break;
        }
        endedBy = "model_error";
        error = messageOf(err);
        write({
          kind: "note",
          source: "body",
          text: `The model could not answer: ${error}`,
          data: { turnId, kind: err instanceof ModelError ? err.kind : "error" },
        });
        break;
      }

      const calls = response.toolCalls ?? [];
      const content = response.content;
      if (typeof content === "string" && content.trim() !== "") {
        thoughts.push(content);
        write({ kind: "note", source: "self", text: content, data: { thought: true, turnId } });
      }
      messages.push(calls.length > 0 ? { role: "assistant", content, toolCalls: calls } : { role: "assistant", content });

      if (calls.length === 0) {
        endedBy = "no_tool_call";
        break;
      }

      // Calls run in order. After end_turn, the rest of this reply still runs; the ceiling still applies.
      for (const call of calls) {
        if (signal?.aborted) {
          endedBy ??= "aborted";
          skip(call, "The turn was aborted before this call.");
          continue;
        }
        if (toolCalls >= ceiling.maxToolCalls) {
          endedBy ??= "ceiling";
          skip(call, "The turn reached its tool-call limit before this call.");
          continue;
        }
        const receipt = await runCall(call);
        if (call.name === END_TURN && receipt.ok) endedBy ??= "end_turn";
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
  write({
    kind: "turn",
    source: "body",
    data: { phase: "end", endedBy: finalReason, turnId, modelCalls, toolCalls },
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
    ...(error === undefined ? {} : { error }),
  };
  return { result, messages };
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
