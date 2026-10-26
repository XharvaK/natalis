// One adapter for any OpenAI-compatible chat/completions service or local server, and for services that serve a
// model on /responses only (responses-wire.ts). The model is the mind; this file is only the wire: it maps Natalis
// messages and tools onto the protocol and back, retries the transient failures a provider throws, and turns every
// failure into a ModelError that never shows the key.

import { randomBytes } from "node:crypto";
import { ModelError, type QuotaWindow } from "../contracts.js";
import { markedTextParts, markPlan } from "./cache-marks.js";
import { buildResponsesBody, parseResponsesReply, REASONING_ITEMS } from "./responses-wire.js";
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
  /**
   * Send provider cache marks (cache_control on the parts cache-marks.ts names). Off by default: the wire text is then the
   * plain string it has always been.
   */
  cacheMarks?: boolean;
  /** The protocol: "chat" (/chat/completions, default) or "responses" (/responses). Cache marks are chat only. */
  api?: "chat" | "responses";
  /** Extra request headers a service asks for (a workspace id, a session id, a user agent). The key header always wins. */
  headers?: Record<string, string>;
  /** Wire values for the entity's efforts, for a service whose levels differ (e.g. xhigh sent as "max"). Unmapped go as they are. */
  effortMap?: Partial<Record<NonNullable<ModelRequest["effort"]>, string>>;
  /**
   * Ask for the reply as a stream (chat protocol only), so a model that goes silent is noticed: when nothing arrives for
   * idleTimeoutMs, the call fails as a timeout and a backup can answer. timeoutMs still bounds the whole call. Default false.
   */
  stream?: boolean;
  /** With stream on: the longest wait for the next piece of the reply, the first included. Default 120000. */
  idleTimeoutMs?: number;
  /**
   * The whole call's limit: every attempt and every wait between attempts. Default timeoutMs + 120000. No attempt runs,
   * and no wait starts, past it.
   */
  callDeadlineMs?: number;
  /** Writes one line per retry. Default: console.error to the journal. Never given a key or a reply body. */
  log?: (line: string) => void;
};

type ModelErrorKind = ConstructorParameters<typeof ModelError>[1];

/** Statuses retried with backoff. Anything else is final. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 524]);
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_ATTEMPTS = 4;
/** A Retry-After longer than this is not waited out: the call fails at once so a backup can answer. */
export const RETRY_AFTER_MAX_MS = 60_000;
const DEADLINE_SLACK_MS = 120_000;
const DETAIL_CHARS = 300;

/** Outcome of one HTTP attempt, before any retry decision. */
type Sent =
  | { type: "reply"; status: number; retryAfterMs: number | undefined; text: string }
  | { type: "timeout" }
  | { type: "silent" }
  | { type: "aborted" }
  | { type: "network"; detail: string };

export function createOpenAICompatiblePort(options: OpenAICompatibleOptions): ModelPort {
  const api = options.api ?? "chat";
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/${api === "responses" ? "responses" : "chat/completions"}`;
  const apiKey = options.apiKey || undefined;
  const nativeTools = options.nativeTools ?? true;
  const effortParam = options.effortParam ?? null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;
  const idPrefix = options.idPrefix ?? "call";
  const cacheMarks = options.cacheMarks === true;
  const streaming = options.stream === true && api === "chat";
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const callDeadlineMs = options.callDeadlineMs ?? timeoutMs + DEADLINE_SLACK_MS;
  const log = options.log ?? ((line: string) => console.error(`[natalis] ${line}`));
  const provider = (() => {
    try {
      return new URL(options.baseUrl).host;
    } catch {
      return "model service";
    }
  })();
  const now = (): number => Date.now();
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

  const send = async (body: string, signal: AbortSignal | undefined, limitMs: number): Promise<Sent> => {
    if (signal?.aborted) return { type: "aborted" };
    const fetchFn = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = { timedOut: false, silent: false };
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timer.timedOut = true;
      controller.abort();
    }, Math.max(1, Math.min(timeoutMs, limitMs)));
    // With a stream, every piece that arrives starts the silence watch again; without one, there is no watch.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const heard = (): void => {
      if (!streaming) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        timer.silent = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    heard();
    const headers: Record<string, string> = { ...options.headers, "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    try {
      const res = await fetchFn(endpoint, { method: "POST", headers, body, signal: controller.signal });
      heard();
      const text = streaming && res.ok && res.body ? await readAll(res.body, heard, controller.signal) : await res.text();
      return {
        type: "reply",
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        text,
      };
    } catch (err) {
      if (timer.timedOut) return { type: "timeout" };
      if (timer.silent) return { type: "silent" };
      if (signal?.aborted) return { type: "aborted" };
      return { type: "network", detail: safe(errorText(err)) };
    } finally {
      clearTimeout(timeout);
      clearTimeout(idle);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  };

  // Waits before a retry; a caller abort during the wait ends the call at once.
  const pause = (ms: number, signal: AbortSignal | undefined, attempt: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (options.sleep === undefined) {
        // The default wait is a plain timer, cleared on abort so a stopping process is not kept alive by it.
        if (signal?.aborted) return reject(new ModelError("request aborted by caller", "aborted", attempt));
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onTimerAbort);
          resolve();
        }, ms);
        const onTimerAbort = (): void => {
          clearTimeout(timer);
          reject(new ModelError("request aborted by caller", "aborted", attempt));
        };
        signal?.addEventListener("abort", onTimerAbort, { once: true });
        return;
      }
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
      const effort =
        effortParam === null || request.effort === undefined
          ? undefined
          : (options.effortMap?.[request.effort] ?? request.effort);
      const body = JSON.stringify(
        api === "responses"
          ? buildResponsesBody({ model: options.model, nativeTools, effort }, request)
          : buildBody({ model: options.model, nativeTools, effortParam, effort, cacheMarks, streaming }, request),
      );
      const deadlineAt = now() + callDeadlineMs;
      const overDeadline = (attempt: number): ModelError =>
        new ModelError(`no answer from the model service within the call's ${callDeadlineMs} ms limit, after ${attempt} attempts`, "timeout", attempt);
      // Waits before the next attempt, or fails when the wait would run past the call's limit.
      const retryWait = async (ms: number, attempt: number, why: string): Promise<void> => {
        if (now() + ms >= deadlineAt) throw overDeadline(attempt);
        log(`model retry: ${provider} ${options.model} ${why}, attempt ${attempt}/${maxAttempts}, waiting ${ms} ms`);
        await pause(ms, signal, attempt);
      };
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new ModelError("request aborted by caller", "aborted", attempt);
        const started = now();
        if (started >= deadlineAt) throw overDeadline(attempt - 1);
        const sent = await send(body, signal, deadlineAt - started);

        if (sent.type === "aborted") throw new ModelError("request aborted by caller", "aborted", attempt);
        if (sent.type === "timeout") {
          if (now() >= deadlineAt) throw overDeadline(attempt);
          throw new ModelError(`no reply from the model service within ${timeoutMs} ms`, "timeout", attempt);
        }
        if (sent.type === "silent") {
          throw new ModelError(`the model service sent nothing for ${idleTimeoutMs} ms`, "timeout", attempt);
        }
        if (sent.type === "network") {
          if (attempt >= maxAttempts) {
            throw new ModelError(
              `model service unreachable after ${attempt} attempts: ${sent.detail}`,
              "unavailable",
              attempt,
            );
          }
          await retryWait(backoffMs(attempt), attempt, "unreachable");
          continue;
        }

        if (sent.status >= 200 && sent.status < 300) {
          const latencyMs = Date.now() - started;
          if (api === "responses") return parseResponsesReply(sent.text, latencyMs, attempt, newId);
          if (!streaming || !isStream(sent.text)) return parseReply(sent.text, latencyMs, attempt, newId);
          const whole = joinStream(sent.text, attempt, safe);
          if (whole !== undefined) return parseChoices(whole, latencyMs, attempt, newId);
          // The stream stopped before its end: the same as a dropped connection, so it is tried again.
          if (attempt >= maxAttempts) {
            throw new ModelError(`model service stream was cut off before its end, after ${attempt} attempts`, "unavailable", attempt);
          }
          await retryWait(backoffMs(attempt), attempt, "stream cut off");
          continue;
        }
        if (RETRYABLE_STATUS.has(sent.status) && attempt < maxAttempts && !isOutOfCredit(sent.status, sent.text)) {
          // A long Retry-After is not waited out: the service will not answer soon, so the call fails now and a backup
          // takes it. A short one, or none, waits as before (the backoff stays capped at BACKOFF_CAP_MS).
          if (sent.retryAfterMs !== undefined && sent.retryAfterMs > RETRY_AFTER_MAX_MS) {
            log(`model retry: ${provider} ${options.model} HTTP ${sent.status}, attempt ${attempt}/${maxAttempts}, retry-after ${sent.retryAfterMs} ms is over ${RETRY_AFTER_MAX_MS} ms, not retried`);
            throw httpError(sent.status, sent.text, attempt, safe, sent.retryAfterMs, now());
          }
          await retryWait(sent.retryAfterMs ?? backoffMs(attempt), attempt, `HTTP ${sent.status}`);
          continue;
        }
        throw httpError(sent.status, sent.text, attempt, safe, sent.retryAfterMs, now());
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Request side

function buildBody(
  options: {
    model: string;
    nativeTools: boolean;
    effortParam: "reasoning_effort" | null;
    effort: string | undefined;
    cacheMarks: boolean;
    streaming?: boolean;
  },
  request: ModelRequest,
): Record<string, unknown> {
  // With marks on, each message carries its marks; with them off, no message does and the wire text is the plain string.
  const plan = options.cacheMarks ? markPlan(request.messages) : undefined;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: request.messages.map((message, index) => toWireMessage(message, plan?.[index])),
  };
  if (options.nativeTools && request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toWireTool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (options.effortParam !== null && options.effort !== undefined) {
    body[options.effortParam] = options.effort;
  }
  if (options.streaming === true) {
    body.stream = true;
    // The token counts come in the stream's last piece only when asked for.
    body.stream_options = { include_usage: true };
  }
  return body;
}

/**
 * One message on the wire. `marks` is the message's cache marks (see cache-marks.ts), or undefined when marks are off. With
 * marks on, system and user text goes as text parts; a marked assistant or tool message does too; any other message is unchanged.
 */
function toWireMessage(message: ChatMessage, marks: readonly number[] | undefined): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: marks === undefined ? message.content : textContent(message.content, marks) };
    case "user": {
      if (!message.images || message.images.length === 0) {
        return { role: "user", content: marks === undefined ? message.content : textContent(message.content, marks) };
      }
      const text: Array<Record<string, unknown>> =
        marks === undefined
          ? [{ type: "text", text: message.content }]
          : message.content === ""
            ? []
            : markedTextParts(message.content, marks);
      return {
        role: "user",
        content: [
          ...text,
          ...message.images.map((picture) => ({
            type: "image_url",
            image_url: { url: `data:${picture.mime};base64,${picture.dataBase64}` },
          })),
        ],
      };
    }
    case "assistant": {
      const calls = message.toolCalls ?? [];
      const wire: Record<string, unknown> = {
        role: "assistant",
        content: markedContent(message.content ?? (calls.length > 0 ? null : ""), marks),
      };
      // Reasoning a provider asked to get back (for example reasoning_details) rides along unchanged. Reasoning items from a
      // /responses model (a backup that answered earlier in the turn) are not chat fields and stay behind.
      if (message.providerState) {
        const { [REASONING_ITEMS]: _responsesOnly, ...chatState } = message.providerState;
        Object.assign(wire, chatState);
      }
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
      return { role: "tool", tool_call_id: message.toolCallId, content: markedContent(message.content, marks) };
  }
}

/** Text that is sent as parts when marks are on (system and user text always are); empty text stays a plain string. */
function textContent(text: string, marks: readonly number[]): string | Array<Record<string, unknown>> {
  return text === "" ? "" : markedTextParts(text, marks);
}

/** A message's content with its marks: parts when it has a mark, otherwise the content as it is. */
function markedContent(content: string | null, marks: readonly number[] | undefined): string | null | Array<Record<string, unknown>> {
  if (marks === undefined || marks.length === 0 || content === null || content === "") return content;
  return markedTextParts(content, marks);
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
  return parseChoices(parsed, latencyMs, attempt, newId);
}

/** A chat reply, already parsed: a whole reply, or a stream's pieces joined into one (joinStream). */
function parseChoices(
  parsed: unknown,
  latencyMs: number,
  attempt: number,
  newId: () => string,
): ModelResponse {
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
  // Providers name the readable reasoning differently; the opaque details go back on the next call.
  const reasoning = [message.reasoning, message.reasoning_content].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (reasoning !== undefined) response.reasoning = reasoning;
  const state: Record<string, unknown> = {};
  if (message.reasoning_details !== undefined && message.reasoning_details !== null) state.reasoning_details = message.reasoning_details;
  // A thinking model can require its reasoning back on the turn's later calls (DeepSeek refuses the request without it),
  // so reasoning_content goes back as it came.
  if (typeof message.reasoning_content === "string" && message.reasoning_content !== "") state.reasoning_content = message.reasoning_content;
  if (Object.keys(state).length > 0) response.providerState = state;
  if (isRecord(parsed.usage)) {
    const usage: NonNullable<ModelResponse["usage"]> = {};
    if (typeof parsed.usage.prompt_tokens === "number") usage.inputTokens = parsed.usage.prompt_tokens;
    if (typeof parsed.usage.completion_tokens === "number") usage.outputTokens = parsed.usage.completion_tokens;
    if (typeof parsed.usage.total_tokens === "number") usage.totalTokens = parsed.usage.total_tokens;
    // DeepSeek-style counts sit at the top of usage; OpenAI-style cached tokens sit in prompt_tokens_details. Neither is derived.
    const details = isRecord(parsed.usage.prompt_tokens_details) ? parsed.usage.prompt_tokens_details : undefined;
    if (typeof parsed.usage.prompt_cache_hit_tokens === "number") usage.cacheHitTokens = parsed.usage.prompt_cache_hit_tokens;
    else if (typeof details?.cached_tokens === "number") usage.cacheHitTokens = details.cached_tokens;
    if (typeof parsed.usage.prompt_cache_miss_tokens === "number") usage.cacheMissTokens = parsed.usage.prompt_cache_miss_tokens;
    if (Object.keys(usage).length > 0) response.usage = usage;
  }
  return response;
}

/**
 * Reads a response body to its end, calling `heard` each time a piece arrives. An abort cancels the reading at once, so
 * a body that has gone silent never holds the call.
 */
async function readAll(body: ReadableStream<Uint8Array>, heard: () => void, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("the reading of the reply was aborted");
      if (done) break;
      heard();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return text + decoder.decode();
}

/** True when a reply is a server-sent event stream rather than one JSON reply. */
function isStream(text: string): boolean {
  return /^\s*(data|event|:)/.test(text);
}

type StreamedCall = { id?: string; name?: string; args: string };

/**
 * A chat stream's pieces joined into the one reply the service would have sent without a stream: the words, the
 * reasoning, each tool call's arguments in order, the finish reason and the token counts. Undefined when the stream
 * stopped before its end (no finish reason and no [DONE]). An error the service sent inside the stream is thrown.
 */
function joinStream(text: string, attempt: number, safe: (text: string) => string): Record<string, unknown> | undefined {
  let content: string | null = null;
  let reasoning = "";
  let reasoningField: "reasoning_content" | "reasoning" = "reasoning";
  const details: unknown[] = [];
  const calls = new Map<number, StreamedCall>();
  let finish: unknown;
  let usage: unknown;
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "") continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    let piece: unknown;
    try {
      piece = JSON.parse(data);
    } catch {
      throw new ModelError("model service stream had a piece that was not JSON", "malformed", attempt);
    }
    if (!isRecord(piece)) continue;
    if (piece.error !== undefined) {
      const detail = providerMessage(JSON.stringify(piece));
      throw new ModelError(`model service sent an error in its stream${detail ? `: ${safe(detail)}` : ""}`, "unavailable", attempt);
    }
    if (isRecord(piece.usage)) usage = piece.usage;
    const choice: unknown = Array.isArray(piece.choices) ? piece.choices[0] : undefined;
    if (!isRecord(choice)) continue;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (delta === undefined) continue;
    if (typeof delta.content === "string") content = (content ?? "") + delta.content;
    // The joined reasoning keeps the field name the provider streamed it in, so it goes back under that name.
    if (typeof delta.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
      reasoningField = "reasoning_content";
    } else if (typeof delta.reasoning === "string") {
      reasoning += delta.reasoning;
    }
    if (Array.isArray(delta.reasoning_details)) details.push(...delta.reasoning_details);
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) continue;
        const index = typeof raw.index === "number" ? raw.index : calls.size;
        const call = calls.get(index) ?? { args: "" };
        if (typeof raw.id === "string" && raw.id !== "") call.id ??= raw.id;
        if (isRecord(raw.function)) {
          if (typeof raw.function.name === "string" && raw.function.name !== "") call.name ??= raw.function.name;
          if (typeof raw.function.arguments === "string") call.args += raw.function.arguments;
        }
        calls.set(index, call);
      }
    }
  }
  if (!done && finish === undefined) return undefined;
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args } }));
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning !== "") message[reasoningField] = reasoning;
  if (details.length > 0) message.reasoning_details = details;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { choices: [{ message, finish_reason: finish ?? null }], ...(usage === undefined ? {} : { usage }) };
}

/**
 * Spent credit or quota: HTTP 402, or a 429 whose body names an insufficient quota (the code OpenAI-style services send).
 * It is an outage, not a rate limit, so it is not retried here: the same key will not get credit back in a few seconds.
 */
function isOutOfCredit(status: number, text: string): boolean {
  return status === 402 || (status === 429 && (OUT_OF_CREDIT_429.test(text) || namesLimit(text)));
}

/**
 * A 429 body naming spent quota, credit, billing or a usage limit (OpenAI's insufficient_quota, OpenCode's usage-limit
 * and subscription-quota errors, CommandCode's credit errors). Such a limit lasts hours, not seconds, so it is final.
 */
const OUT_OF_CREDIT_429 =
  /insufficient[_ ]quota|quota|credit|billing|usage[_ ]?limit|exceeded[^"]{0,40}limit|UsageLimitError|subscription/i;

/** A body whose metadata names its limit (OpenCode's limitName): a named, hours-scale limit, not a burst rate limit. */
function namesLimit(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && isRecord(parsed.metadata) && typeof parsed.metadata.limitName === "string";
  } catch {
    return false;
  }
}

function httpError(
  status: number,
  text: string,
  attempt: number,
  safe: (text: string) => string,
  retryAfterMs?: number,
  nowMs: number = Date.now(),
): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError(`model service refused the credentials (HTTP ${status})`, "auth", attempt);
  }
  if (isOutOfCredit(status, text)) {
    const detail = providerMessage(text);
    const suffix = detail ? `: ${safe(detail)}` : "";
    return new ModelError(
      `model service is out of credit or over its quota (HTTP ${status})${suffix}`,
      "out_of_credit",
      attempt,
      quotaWindow(text, retryAfterMs, nowMs),
    );
  }
  if (status === 429) {
    return new ModelError(
      `model service is rate limiting this key (HTTP 429) after ${attempt} attempts`,
      "rate_limit",
      attempt,
      quotaWindow(text, retryAfterMs, nowMs),
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

/**
 * Which limit a quota or rate-limit reply names, and when it resets. The limit comes from the body's metadata.limitName
 * (OpenCode's GoUsageLimitError) or from words in its message ("5-hour", "weekly", "monthly", "daily"); the reset comes
 * from Retry-After. Undefined when the reply says neither.
 */
export function quotaWindow(text: string, retryAfterMs: number | undefined, nowMs: number): QuotaWindow | undefined {
  let limit: string | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.metadata) && typeof parsed.metadata.limitName === "string") {
      limit = normalLimit(parsed.metadata.limitName);
    }
  } catch {
    // Not JSON: the words are looked at below.
  }
  limit ??= normalLimit(text);
  const window: QuotaWindow = {};
  if (limit !== undefined) window.limit = limit;
  if (retryAfterMs !== undefined) window.resetAtMs = nowMs + retryAfterMs;
  return Object.keys(window).length === 0 ? undefined : window;
}

function normalLimit(text: string): string | undefined {
  if (/\b(5[- ]?h(our)?s?|five[- ]hour)\b/i.test(text)) return "5-hour";
  if (/\bweekly\b|\bweek\b/i.test(text)) return "weekly";
  if (/\bmonthly\b|\bmonth\b/i.test(text)) return "monthly";
  if (/\bdaily\b|\bday\b/i.test(text)) return "daily";
  return undefined;
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

/** The longest Retry-After kept (a year), so a reset built from it stays a valid Date. */
const RETRY_AFTER_KEEP_MS = 365 * 24 * 60 * 60_000;

/** Retry-After as delay-seconds or as an HTTP date (RFC 7231), clamped to 0 .. a year. Unreadable: undefined. */
function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value.trim());
  let ms: number;
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    ms = seconds * 1000;
  } else {
    const at = Date.parse(value.trim());
    if (!Number.isFinite(at)) return undefined;
    ms = Math.max(0, at - nowMs);
  }
  return Math.min(ms, RETRY_AFTER_KEEP_MS);
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
