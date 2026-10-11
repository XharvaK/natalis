// A scripted model for tests and dry runs. It replies in order from a script, records every request, and fails
// loudly when the script runs out. It never touches the network.

import { ModelError } from "../contracts.js";
import type { ModelInfo, ModelPort, ModelRequest, ModelResponse } from "../contracts.js";

/** One scripted reply, or a function that builds it from the request it answers. */
export type ScriptStep = Partial<ModelResponse> | ((request: ModelRequest) => Partial<ModelResponse>);

export type ScriptedModel = ModelPort & {
  /** Every request the port received, in order, including ones it refused. */
  readonly requests: ModelRequest[];
  /** Replies left in the script. */
  readonly remaining: number;
};

export function createScriptedModel(script: ScriptStep[], info?: Partial<ModelInfo>): ScriptedModel {
  const requests: ModelRequest[] = [];
  let next = 0;
  const modelInfo: ModelInfo = {
    id: "scripted:mock",
    contextTokens: 8192,
    nativeTools: true,
    ...info,
  };
  return {
    info: modelInfo,
    requests,
    get remaining(): number {
      return script.length - next;
    },
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      requests.push(request);
      if (signal?.aborted) throw new ModelError("scripted call aborted by caller", "aborted", 1);
      const step = script[next];
      if (step === undefined) {
        throw new ModelError("scripted model has no reply left in its script", "malformed", 1);
      }
      next += 1;
      const partial = typeof step === "function" ? step(request) : step;
      const toolCalls = partial.toolCalls ?? [];
      const response: ModelResponse = {
        content: partial.content ?? null,
        toolCalls,
        finish: partial.finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        latencyMs: partial.latencyMs ?? 0,
      };
      if (partial.usage) response.usage = partial.usage;
      return response;
    },
  };
}
