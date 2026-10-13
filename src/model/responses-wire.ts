// The Responses protocol (POST /responses), for services that serve a model only there. Same Natalis messages and
// tools as chat/completions, other shapes on the wire. Requests are stateless (store: false); the model's reasoning
// comes back encrypted and rides on the assistant message to the next call of the same turn, as the protocol asks.

import { ModelError } from "../contracts.js";
import type { ChatMessage, FinishReason, ModelRequest, ModelResponse, ToolCall, ToolSpec } from "../contracts.js";

/** The providerState key that carries a reply's reasoning items back to the next call. */
export const REASONING_ITEMS = "responsesReasoning";

export function buildResponsesBody(
  options: { model: string; nativeTools: boolean; effort: string | undefined },
  request: ModelRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    input: request.messages.flatMap(toInputItems),
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (options.nativeTools && request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toWireTool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (options.effort !== undefined) body.reasoning = { effort: options.effort };
  return body;
}

/** One Natalis message as input items: messages stay in order, tool calls and their results become their own items. */
function toInputItems(message: ChatMessage): Array<Record<string, unknown>> {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: message.content }];
    case "user": {
      if (!message.images || message.images.length === 0) return [{ role: "user", content: message.content }];
      return [{
        role: "user",
        content: [
          ...(message.content === "" ? [] : [{ type: "input_text", text: message.content }]),
          ...message.images.map((picture) => ({
            type: "input_image",
            image_url: `data:${picture.mime};base64,${picture.dataBase64}`,
          })),
        ],
      }];
    }
    case "assistant": {
      const reasoning = message.providerState?.[REASONING_ITEMS];
      const items: Array<Record<string, unknown>> = Array.isArray(reasoning) ? [...reasoning] : [];
      if (message.content !== null && message.content !== "") items.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      return items;
    }
    case "tool":
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters };
}

export function parseResponsesReply(
  text: string,
  latencyMs: number,
  attempt: number,
  newId: () => string,
): ModelResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelError("model service reply was not JSON", "malformed", attempt);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.output)) {
    throw new ModelError("model service reply had no output", "malformed", attempt);
  }
  if (parsed.status === "failed") {
    const detail = isRecord(parsed.error) && typeof parsed.error.message === "string" ? `: ${parsed.error.message}` : "";
    throw new ModelError(`model service could not finish the reply${detail.slice(0, 300)}`, "unavailable", attempt);
  }

  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoningItems: Array<Record<string, unknown>> = [];
  const summaries: string[] = [];
  for (const item of parsed.output) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      }
    } else if (item.type === "function_call") {
      if (typeof item.name !== "string" || item.name === "") {
        throw new ModelError("model service reply had a tool call with no function name", "malformed", attempt);
      }
      const id = typeof item.call_id === "string" && item.call_id !== "" ? item.call_id : newId();
      toolCalls.push({ id, name: item.name, arguments: argumentsText(item.arguments) });
    } else if (item.type === "reasoning") {
      reasoningItems.push(item);
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (isRecord(part) && typeof part.text === "string" && part.text.trim() !== "") summaries.push(part.text);
        }
      }
    }
  }

  const response: ModelResponse = {
    content: texts.length > 0 ? texts.join("") : null,
    toolCalls,
    finish: finishOf(parsed, toolCalls.length > 0),
    latencyMs,
  };
  if (summaries.length > 0) response.reasoning = summaries.join("\n\n");
  if (reasoningItems.length > 0) response.providerState = { [REASONING_ITEMS]: reasoningItems };
  if (isRecord(parsed.usage)) {
    const usage: NonNullable<ModelResponse["usage"]> = {};
    if (typeof parsed.usage.input_tokens === "number") usage.inputTokens = parsed.usage.input_tokens;
    if (typeof parsed.usage.output_tokens === "number") usage.outputTokens = parsed.usage.output_tokens;
    if (typeof parsed.usage.total_tokens === "number") usage.totalTokens = parsed.usage.total_tokens;
    const details = isRecord(parsed.usage.input_tokens_details) ? parsed.usage.input_tokens_details : undefined;
    if (typeof details?.cached_tokens === "number") usage.cacheHitTokens = details.cached_tokens;
    if (Object.keys(usage).length > 0) response.usage = usage;
  }
  return response;
}

/** A finished reply with tool calls asks for them; an incomplete one says why it stopped. */
function finishOf(parsed: Record<string, unknown>, hasCalls: boolean): FinishReason {
  if (parsed.status === "incomplete") {
    const reason = isRecord(parsed.incomplete_details) ? parsed.incomplete_details.reason : undefined;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
  }
  return hasCalls ? "tool_calls" : "stop";
}

function argumentsText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined) return "{}";
  return JSON.stringify(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
