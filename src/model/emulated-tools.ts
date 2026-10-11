// Tool calls for a model with no native tool calling. The model is told in plain words which tools exist and
// how to act: one fenced json block. This wrapper writes that block into the prompt, reads it back out of the
// reply, and keeps the history round-tripping, so the loop above sees the same ToolCall shape either way.

import { randomBytes } from "node:crypto";
import type {
  ChatMessage,
  ModelInfo,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolSpec,
} from "../contracts.js";

/** A fenced json block (any case of the language tag). Group 1 is the block body. */
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/gi;

/**
 * Wraps a port whose service has no native tools. Sends no `tools` field; describes the tools in the system
 * message; reads a tool-call block from the reply. A malformed block is left in the content as plain thinking.
 */
export function withEmulatedTools(port: ModelPort): ModelPort {
  const info: ModelInfo = { ...port.info, nativeTools: false };
  return {
    info,
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const { tools, toolChoice, ...rest } = request;
      const describe = tools && tools.length > 0 && toolChoice !== "none" ? tools : undefined;
      const messages = toEmulatedMessages(request.messages, describe, toolChoice);
      const reply = await port.complete({ ...rest, messages }, signal);
      return readToolBlock(reply);
    },
  };
}

/** The instruction text that tells the model how to call tools in this wrapper's shape. */
export function toolInstructions(tools: ToolSpec[], toolChoice?: ModelRequest["toolChoice"]): string {
  const list = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  Arguments (JSON Schema): ${JSON.stringify(tool.parameters)}`)
    .join("\n");
  return [
    "You act only through tools. Tools available to you:",
    list,
    "",
    "When you want to act, answer with one fenced json block in exactly this shape:",
    "```json",
    '{"tool_calls":[{"name":"<tool name>","arguments":{}}]}',
    "```",
    "Use only the tool names listed above. If you are not acting, answer in plain words with no json block.",
    toolChoice === "required" ? "You must call one of these tools in this reply." : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function toEmulatedMessages(
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  toolChoice: ModelRequest["toolChoice"],
): ChatMessage[] {
  const instructions = tools ? toolInstructions(tools, toolChoice) : null;
  const out: ChatMessage[] = [];
  let described = instructions === null;
  for (const message of messages) {
    if (message.role === "system" && !described && instructions !== null) {
      out.push({ role: "system", content: `${message.content}\n\n${instructions}` });
      described = true;
    } else {
      out.push(convertMessage(message));
    }
  }
  if (!described && instructions !== null) out.unshift({ role: "system", content: instructions });
  return out;
}

function convertMessage(message: ChatMessage): ChatMessage {
  switch (message.role) {
    case "system":
    case "user":
      return message;
    case "assistant":
      return {
        role: "assistant",
        content: assistantText(message.content, message.toolCalls ?? []),
        ...(message.providerState ? { providerState: message.providerState } : {}),
      };
    case "tool":
      return { role: "user", content: `Tool result (${message.toolCallId}): ${message.content}` };
  }
}

function assistantText(content: string | null, calls: ToolCall[]): string {
  const text = (content ?? "").trimEnd();
  if (calls.length === 0) return text;
  const block = [
    "```json",
    JSON.stringify({
      tool_calls: calls.map((call) => ({ name: call.name, arguments: parseArguments(call.arguments) })),
    }),
    "```",
  ].join("\n");
  return text === "" ? block : `${text}\n\n${block}`;
}

/** Arguments go back into the block as JSON values; text that is not JSON stays as the string it was. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readToolBlock(reply: ModelResponse): ModelResponse {
  if (reply.toolCalls.length > 0 || reply.content === null) return reply;
  const blocks = [...reply.content.matchAll(JSON_BLOCK)].filter((match) => (match[1] ?? "").includes("tool_calls"));
  const block = blocks.at(-1);
  if (!block || block.index === undefined) return reply;

  const calls = parseToolCalls(block[1] ?? "");
  if (calls === null) return reply; // malformed: kept as the model's words, the loop sees no action

  const before = reply.content.slice(0, block.index);
  const after = reply.content.slice(block.index + block[0].length);
  const text = [before, after]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n");
  return {
    ...reply,
    content: text === "" ? null : text,
    toolCalls: calls.map((call) => ({ id: newId(), name: call.name, arguments: call.arguments })),
    finish: "tool_calls",
  };
}

function parseToolCalls(body: string): Array<{ name: string; arguments: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) return null;
  const calls: Array<{ name: string; arguments: string }> = [];
  for (const raw of parsed.tool_calls) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") return null;
    calls.push({ name: raw.name.trim(), arguments: argumentsText(raw.arguments) });
  }
  return calls;
}

function argumentsText(raw: unknown): string {
  if (raw === undefined) return "{}";
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

function newId(): string {
  return `emu_${randomBytes(6).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
