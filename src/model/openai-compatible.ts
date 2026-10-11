// One adapter for any OpenAI-compatible chat/completions service or local server. The model is the mind; this
// file is only the wire: it maps Natalis messages and tools onto the protocol and back, retries the transient
// failures a provider throws, and turns every failure into a ModelError that never shows the key.

import { randomBytes } from "node:crypto";
import { ModelError } from "../contracts.js";
import type {
  ChatMessage,
  FinishReason,
  ModelInfo,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolSpec,
} from "../contracts.js";

export type OpenAICompatibleOptions = {
  /** Base URL up to but not including /chat/completions, e.g. "https://host/v1". */
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token only when set. Never written into an error or a log. */
  apiKey?: string;
  /** Declared context window in tokens, reported through info. */
  contextTokens: number;
  /** When false the port sends no tools and reports nativeTools false (use withEmulatedTools on top). */
  nativeTools?: boolean;
  /** Name of the request field that carries effort. null (default) ignores effort entirely. */
  effortParam?: "reasoning_effort" | null;
  /** Per-attempt limit: the request, and reading its body, must finish within this. Default 180000. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Prefix for tool-call ids the service did not send. Default "call". */
  idPrefix?: string;
};

type ModelErrorKind = ConstructorParameters<typeof ModelError>[1];

/** Statuses retried with backoff. Anything else is final. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 524]);
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ATTEMPTS = 4;
const DETAIL_CHARS = 300;

/** Outcome of one HTTP attempt, before any retry decision. */
type Sent =
  | { type: "reply"; status: number; retryAfterMs: number | undefined; text: string }
  | { type: "timeout" }
  | { type: "aborted" }
  | { type: "network"; detail: string };

export function createOpenAICompatiblePort(options: OpenAICompatibleOptions): ModelPort {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const apiKey = options.apiKey || undefined;
  const nativeTools = options.nativeTools ?? true;
  const effortParam = options.effortParam ?? null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;
  const idPrefix = options.idPrefix ?? "call";
  const info: ModelInfo = {
    id: `openai-compatible:${options.model}`,
    contextTokens: options.contextTokens,
    nativeTools,
  };

  // Every text that could reach an error message passes through here, so the key cannot leak into one.
  const safe = (text: string): string => {
    const cleaned = apiKey ? text.split(apiKey).join("[key removed]") : text;
    return cleaned.length > DETAIL_CHARS ? `${cleaned.slice(0, DETAIL_CHARS)}...` : cleaned;
  };

  const newId = (): string => `${idPrefix}_${randomBytes(6).toString("hex")}`;

  const send = async (body: string, signal: AbortSignal | undefined): Promise<Sent> => {
    if (signal?.aborted) return { type: "aborted" };
    const fetchFn = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = { timedOut: false };
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timer.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    try {
      const res = await fetchFn(endpoint, { method: "POST", headers, body, signal: controller.signal });
      const text = await res.text();
      return {
        type: "reply",
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        text,
      };
    } catch (err) {
      if (timer.timedOut) return { type: "timeout" };
      if (signal?.aborted) return { type: "aborted" };
      return { type: "network", detail: safe(errorText(err)) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  };

  // Waits before a retry; a caller abort during the wait ends the call at once.
  const pause = (ms: number, signal: AbortSignal | undefined, attempt: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new ModelError("request aborted by caller", "aborted", attempt));
      signal?.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        (err: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });

  return {
    info,
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const body = JSON.stringify(buildBody({ model: options.model, nativeTools, effortParam }, request));
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new ModelError("request aborted by caller", "aborted", attempt);
        const started = Date.now();
        const sent = await send(body, signal);

        if (sent.type === "aborted") throw new ModelError("request aborted by caller", "aborted", attempt);
        if (sent.type === "timeout") {
          throw new ModelError(`no reply from the model service within ${timeoutMs} ms`, "timeout", attempt);
        }
        if (sent.type === "network") {
          if (attempt >= maxAttempts) {
            throw new ModelError(
              `model service unreachable after ${attempt} attempts: ${sent.detail}`,
              "unavailable",
              attempt,
            );
          }
          await pause(backoffMs(attempt), signal, attempt);
          continue;
        }

        if (sent.status >= 200 && sent.status < 300) {
          return parseReply(sent.text, Date.now() - started, attempt, newId);
        }
        if (RETRYABLE_STATUS.has(sent.status) && attempt < maxAttempts) {
          await pause(sent.retryAfterMs ?? backoffMs(attempt), signal, attempt);
          continue;
        }
        throw httpError(sent.status, sent.text, attempt, safe);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Request side

function buildBody(
  options: { model: string; nativeTools: boolean; effortParam: "reasoning_effort" | null },
  request: ModelRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: request.messages.map(toWireMessage),
  };
  if (options.nativeTools && request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toWireTool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (options.effortParam !== null && request.effort !== undefined) {
    body[options.effortParam] = request.effort;
  }
  return body;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user": {
      if (!message.images || message.images.length === 0) return { role: "user", content: message.content };
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...message.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }
    case "assistant": {
      const calls = message.toolCalls ?? [];
      const wire: Record<string, unknown> = {
        role: "assistant",
        content: message.content ?? (calls.length > 0 ? null : ""),
      };
      if (calls.length > 0) {
        wire.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return wire;
    }
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

// ---------------------------------------------------------------------------------------------------
// Response side

function parseReply(
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
  if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new ModelError("model service reply had no choices", "malformed", attempt);
  }
  const choice: unknown = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ModelError("model service reply had no message", "malformed", attempt);
  }
  const message = choice.message;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.map((raw: unknown) => {
    if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== "string" || raw.function.name === "") {
      throw new ModelError("model service reply had a tool call with no function name", "malformed", attempt);
    }
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : newId();
    return { id, name: raw.function.name, arguments: argumentsText(raw.function.arguments) };
  });

  const response: ModelResponse = {
    content: contentText(message.content),
    toolCalls,
    finish: mapFinish(choice.finish_reason),
    latencyMs,
  };
  if (isRecord(parsed.usage)) {
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (typeof parsed.usage.prompt_tokens === "number") usage.inputTokens = parsed.usage.prompt_tokens;
    if (typeof parsed.usage.completion_tokens === "number") usage.outputTokens = parsed.usage.completion_tokens;
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) response.usage = usage;
  }
  return response;
}

function httpError(
  status: number,
  text: string,
  attempt: number,
  safe: (text: string) => string,
): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError(`model service refused the credentials (HTTP ${status})`, "auth", attempt);
  }
  if (status === 429) {
    return new ModelError(
      `model service is rate limiting this key (HTTP 429) after ${attempt} attempts`,
      "rate_limit",
      attempt,
    );
  }
  const kind: ModelErrorKind =
    status >= 500 || RETRYABLE_STATUS.has(status) || status < 400 ? "unavailable" : "bad_request";
  if (kind === "unavailable") {
    return new ModelError(`model service unavailable (HTTP ${status}) after ${attempt} attempts`, kind, attempt);
  }
  const detail = providerMessage(text);
  const suffix = detail ? `: ${safe(detail)}` : "";
  return new ModelError(`model service rejected the request (HTTP ${status})${suffix}`, kind, attempt);
}

function providerMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message;
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Not JSON: no detail to show.
  }
  return "";
}

// ---------------------------------------------------------------------------------------------------
// Helpers

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/** Retry-After as delay-seconds. HTTP-date form is not used by the providers Natalis targets; it falls back. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function mapFinish(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function contentText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.flatMap((part: unknown) =>
      isRecord(part) && typeof part.text === "string" ? [part.text] : [],
    );
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

function argumentsText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined) return "{}";
  return JSON.stringify(raw);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
