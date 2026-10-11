// The model as the replay sees it. Two things change, and only two: the model is not offered the replay's own
// wake tools, and its schedule_wake and cancel_wake calls are sent to the replay's recording versions instead.
// Everything else passes through unchanged. It also counts failed calls, so a replay with a broken model stops.

import type { ModelPort, ModelRequest, ModelResponse } from "../contracts.js";
import { REPLAY_CANCEL_WAKE, REPLAY_WAKE } from "./world.js";

const RENAMED: Readonly<Record<string, string>> = {
  schedule_wake: REPLAY_WAKE,
  cancel_wake: REPLAY_CANCEL_WAKE,
};
const REPLAY_NAMES: ReadonlySet<string> = new Set(Object.values(RENAMED));

export function replayModel(inner: ModelPort, onFailure: (message: string) => void): ModelPort {
  return {
    info: inner.info,
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const offered = request.tools?.filter((tool) => !REPLAY_NAMES.has(tool.name));
      let response: ModelResponse;
      try {
        response = await inner.complete({ ...request, tools: offered }, signal);
      } catch (err) {
        onFailure(err instanceof Error ? err.message : String(err));
        throw err;
      }
      return {
        ...response,
        toolCalls: response.toolCalls.map((call) => ({ ...call, name: RENAMED[call.name] ?? call.name })),
      };
    },
  };
}
