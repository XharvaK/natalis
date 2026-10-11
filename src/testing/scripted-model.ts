// Scripted ModelPort for tests. It replays one step per call and records every request it was sent.
// It never touches the network. Steps are:
// - a ModelResponse, returned as is;
// - an Error (including ModelError), thrown;
// - a function, called with the request and the signal, whose result (or rejection) is used.
// When the script runs out, the call throws a ModelError of kind "bad_request" so a test cannot pass by accident.

import {
  ModelError,
  type FinishReason,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from "../contracts.js";

export type ScriptStep =
  | ModelResponse
  | Error
  | ((request: ModelRequest, signal?: AbortSignal) => ModelResponse | Promise<ModelResponse>);

export class ScriptedModel implements ModelPort {
  readonly info: ModelInfo;
  /** Every request, copied at the moment it was sent. */
  readonly requests: ModelRequest[] = [];
  private next = 0;

  constructor(
    private readonly steps: ScriptStep[],
    info: Partial<ModelInfo> = {},
  ) {
    this.info = {
      id: info.id ?? "scripted:test-model",
      contextTokens: info.contextTokens ?? 32_000,
      nativeTools: info.nativeTools ?? true,
    };
  }

  /** Steps not yet used. */
  get remaining(): number {
    return this.steps.length - this.next;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    if (signal?.aborted) throw new ModelError("The request was aborted.", "aborted", 0);
    const step = this.steps[this.next];
    this.next += 1;
    if (step === undefined) {
      throw new ModelError("The scripted model has no more replies.", "bad_request", 1);
    }
    if (step instanceof Error) throw step;
    if (typeof step === "function") return await step(request, signal);
    return step;
  }
}

/** A reply. Finish defaults to "tool_calls" when there are calls, otherwise "stop". */
export function reply(
  options: { content?: string | null; toolCalls?: ToolCall[]; finish?: FinishReason } = {},
): ModelResponse {
  const toolCalls = options.toolCalls ?? [];
  return {
    content: options.content ?? null,
    toolCalls,
    finish: options.finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
    latencyMs: 0,
  };
}

let callCounter = 0;

/** A tool call. Object arguments are written as JSON; a string is kept exactly as given (for bad-JSON tests). */
export function call(name: string, args: Record<string, unknown> | string = {}, id?: string): ToolCall {
  callCounter += 1;
  return {
    id: id ?? `call_${callCounter}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

/** A step that never answers until the signal aborts, then fails the way a cancelled request does. */
export function untilAborted(): ScriptStep {
  return (_request, signal) =>
    new Promise<ModelResponse>((_resolve, reject) => {
      const fail = (): void => reject(new ModelError("The request was aborted.", "aborted", 1));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });
}
