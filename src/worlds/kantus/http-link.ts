// The HTTP/NDJSON transport for the Kantus studio bridge. Kantus.exe opens one persistent chunked POST /kantus/session
// stream (sending hello, chat, ask_answer and stop lines, and receiving handshake, chat, rpc, ask and status lines) and
// sends short POSTs for mode switches, stops, rpc results, studio events and Capabilities/ syncs.
//
// Everything here is transport and auth only: bearer verification via SHA-256 constant-time compare, strict body caps,
// request timeouts for pending RPCs and asks, and clean disconnect cleanup.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CapabilitiesStore, CapabilityEntry } from "./capabilities-store.js";
import {
  BODY_LIMIT, LARGE_BODY_LIMIT, tokensEqual, WireError,
  type StudioEvent, type StudioLink, type StudioReply, type StudioStatus,
} from "./wire.js";

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_ASK_TIMEOUT_MS = 600_000;
const SHORT_POST_TIMEOUT_MS = 15_000;
const MAX_SESSION_BUFFER_BYTES = BODY_LIMIT * 2;
const KEEPALIVE_INTERVAL_MS = 30_000;

export type KantusHttpLinkOptions = {
  host: string;
  port: number;
  token: string;
  entityName: string;
  caps: CapabilitiesStore;
  nowMs?: () => number;
  rpcTimeoutMs?: number;
  askTimeoutMs?: number;
};

export interface KantusHttpLink extends StudioLink {
  start(): Promise<void>;
  stop(): Promise<void>;
  listeningAddress(): { host: string; port: number } | null;
}

type PendingWait = {
  resolve: (reply: StudioReply) => void;
  cleanup: () => void;
};

type ActiveSession = {
  id: number;
  req: IncomingMessage;
  res: ServerResponse;
  close: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringProp(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function isMode(value: unknown): value is NonNullable<StudioStatus["mode"]> {
  return value === "RO" || value === "RW" || value === "STOP";
}

function isTransport(value: unknown): value is NonNullable<StudioStatus["transport"]> {
  return value === "idle" || value === "playing" || value === "recording";
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("request timeout"));
    }, SHORT_POST_TIMEOUT_MS);

    const finish = (value: Buffer | "too_large"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        req.resume();
        finish("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("close", () => finish(Buffer.concat(chunks)));
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseJsonBody(raw: Buffer): Record<string, unknown> | undefined {
  if (raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeNdjson(res: ServerResponse, frame: Record<string, unknown>): boolean {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`${JSON.stringify(frame)}\n`);
  return true;
}

/** Creates the HTTP + chunked NDJSON StudioLink listener for the Kantus world. */
export function createKantusHttpLink(options: KantusHttpLinkOptions): KantusHttpLink {
  const nowMs = options.nowMs ?? (() => Date.now());
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  const handlers = new Set<(event: StudioEvent) => void>();
  const pendingRpcs = new Map<string, PendingWait>();
  const pendingAsks = new Map<string, PendingWait>();

  let server: Server | null = null;
  let bound: { host: string; port: number } | null = null;
  let activeSession: ActiveSession | null = null;
  let nextSessionId = 0;

  let currentMode: NonNullable<StudioStatus["mode"]> = "RO";
  let currentTransport: NonNullable<StudioStatus["transport"]> = "idle";
  let currentProject: string | undefined;

  function emitEvent(event: StudioEvent): void {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (error) {
        console.error(`[kantus-http] event handler threw: ${messageOf(error)}`);
      }
    }
  }

  function rejectPending(map: Map<string, PendingWait>, code: string, reason: string): void {
    for (const [id, wait] of [...map.entries()]) {
      map.delete(id);
      wait.cleanup();
      wait.resolve({ ok: false, code, reason });
    }
  }

  function rejectAllPending(code: string, reason: string): void {
    rejectPending(pendingRpcs, code, reason);
    rejectPending(pendingAsks, code, reason);
  }

  function updateStatusFields(record: Record<string, unknown>): void {
    if (isMode(record["mode"])) currentMode = record["mode"];
    if (isTransport(record["transport"])) currentTransport = record["transport"];
    if (typeof record["project"] === "string" && record["project"].trim() !== "") {
      currentProject = record["project"].trim();
    }
  }

  function statusNow(): StudioStatus {
    const attached = activeSession !== null && !activeSession.res.destroyed && !activeSession.res.writableEnded;
    if (!attached) return { attached: false };
    return {
      attached: true,
      mode: currentMode,
      transport: currentTransport,
      ...(currentProject === undefined ? {} : { project: currentProject }),
    };
  }

  function waitOn(
    map: Map<string, PendingWait>,
    id: string,
    timeoutMs: number,
    timeoutReason: string,
    signal?: AbortSignal,
  ): Promise<StudioReply> {
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, code: "stopped", reason: "The emergency stop ended the request to the studio." });
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (reply: StudioReply): void => {
        if (done) return;
        done = true;
        map.delete(id);
        wait.cleanup();
        resolve(reply);
      };
      const onAbort = (): void => finish({ ok: false, code: "stopped", reason: "The emergency stop ended the request to the studio." });
      const timer = setTimeout(() => finish({ ok: false, code: "timeout", reason: timeoutReason }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const wait: PendingWait = {
        resolve: finish,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      map.set(id, wait);
    });
  }

  function settlePendingMap(map: Map<string, PendingWait>, id: string, reply: StudioReply): boolean {
    const wait = map.get(id);
    if (!wait) return false;
    map.delete(id);
    wait.cleanup();
    wait.resolve(reply);
    return true;
  }

  function normalizeRpcResult(result: unknown): StudioReply {
    if (!isRecord(result)) return { ok: true, data: result === undefined || result === null ? {} : { value: result } };
    const statusText = typeof result["status"] === "string" ? result["status"] : "";
    const failed =
      statusText === "rejected" ||
      statusText.startsWith("rejected.") ||
      statusText === "needs_confirmation" ||
      statusText === "error" ||
      statusText === "runtime" ||
      result["ok"] === false;
    if (failed) {
      const code = stringProp(result, ["errorCode", "code", "status"]) ?? "studio_error";
      const reason = stringProp(result, ["errorMessage", "message", "reason"]) ?? "The studio rejected the command.";
      return { ok: false, code, reason };
    }
    const data: Record<string, unknown> = { ...result };
    // CommandService envelopes return fields inside `readback`; surface evidence PNG fields at top level for kantus_analyze.
    const readback = isRecord(data["readback"]) ? data["readback"] : undefined;
    if (readback !== undefined) {
      if (data["png_base64"] === undefined && typeof readback["png_base64"] === "string") {
        data["png_base64"] = readback["png_base64"];
      }
      if (data["pngs"] === undefined && Array.isArray(readback["pngs"])) {
        data["pngs"] = readback["pngs"];
      }
    }
    return { ok: true, data };
  }

  function handleSessionLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const type = typeof parsed["type"] === "string" ? parsed["type"].toLowerCase() : "";
    if (type === "hello") {
      updateStatusFields(parsed);
      return;
    }
    if (type === "mode") {
      if (isMode(parsed["mode"])) currentMode = parsed["mode"];
      return;
    }
    if (type === "chat") {
      const text = typeof parsed["text"] === "string" ? parsed["text"].trim() : "";
      if (text === "") return;
      const context = Array.isArray(parsed["context"])
        ? parsed["context"].filter((item): item is string => typeof item === "string" && item.trim() !== "")
        : undefined;
      emitEvent({
        channel: "chat",
        payload: { text, ...(context !== undefined && context.length > 0 ? { context } : {}) },
        atMs: nowMs(),
      });
      return;
    }
    if (type === "stop") {
      currentMode = "STOP";
      rejectAllPending("stopped", "The studio stopped the request.");
      emitEvent({ channel: "stop", payload: {}, atMs: nowMs() });
      return;
    }
    if (type === "ask_answer") {
      const askId = typeof parsed["askId"] === "string" ? parsed["askId"] : "";
      if (askId === "") return;
      const answer = typeof parsed["answer"] === "string" ? parsed["answer"] : String(parsed["answer"] ?? "");
      settlePendingMap(pendingAsks, askId, { ok: true, data: { answer } });
    }
  }

  function handleSession(req: IncomingMessage, res: ServerResponse): void {
    if (activeSession !== null) {
      const previous = activeSession;
      activeSession = null;
      rejectAllPending("studio_detached", "The studio opened a newer session.");
      previous.close();
    }

    const sessionId = ++nextSessionId;
    req.setTimeout(0);
    res.setTimeout(0);
    req.socket?.setTimeout(0);
    req.socket?.setKeepAlive(true, KEEPALIVE_INTERVAL_MS);
    req.socket?.setNoDelay(true);

    let buffer = "";
    let closed = false;

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (!res.writableEnded && !res.destroyed) res.end();
      if (!req.destroyed) req.destroy();
    };

    const session: ActiveSession = { id: sessionId, req, res, close };
    activeSession = session;

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.flushHeaders();
    writeNdjson(res, { type: "handshake", entityName: options.entityName });

    const disconnect = (): void => {
      if (closed) return;
      closed = true;
      if (activeSession?.id === sessionId) {
        activeSession = null;
        rejectAllPending("studio_detached", "Kantus.exe disconnected.");
        emitEvent({ channel: "detached", payload: {}, atMs: nowMs() });
      }
    };

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (closed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_SESSION_BUFFER_BYTES) {
        close();
        disconnect();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handleSessionLine(line);
      }
    });
    req.on("end", () => {
      if (buffer.trim() !== "") handleSessionLine(buffer);
      disconnect();
    });
    req.on("close", disconnect);
    req.on("error", disconnect);
    res.on("close", disconnect);
    res.on("error", disconnect);

    emitEvent({ channel: "attached", payload: {}, atMs: nowMs() });
  }

  async function handleShortPost(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const limit = path === "/kantus/rpc-result" || path === "/kantus/capabilities-sync" ? LARGE_BODY_LIMIT : BODY_LIMIT;
    let raw: Buffer | "too_large";
    try {
      raw = await readBody(req, limit);
    } catch {
      sendJson(res, 408, { ok: false, code: "request_timeout" });
      return;
    }
    if (raw === "too_large") {
      sendJson(res, 413, { ok: false, code: "too_large" });
      return;
    }
    const body = parseJsonBody(raw);
    if (body === undefined) {
      sendJson(res, 400, { ok: false, code: "invalid_body" });
      return;
    }

    if (path === "/kantus/mode") {
      const mode = body["mode"];
      if (!isMode(mode)) {
        sendJson(res, 400, { ok: false, code: "bad_mode" });
        return;
      }
      currentMode = mode;
      if (mode === "STOP") rejectAllPending("stopped", "The studio switched to STOP.");
      sendJson(res, 200, { ok: true, mode });
      return;
    }

    if (path === "/kantus/stop") {
      currentMode = "STOP";
      rejectAllPending("stopped", "The studio stopped the request.");
      emitEvent({ channel: "stop", payload: {}, atMs: nowMs() });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/kantus/rpc-result") {
      const callId = body["callId"];
      if (typeof callId !== "string" || callId === "") {
        sendJson(res, 400, { ok: false, code: "bad_call_id" });
        return;
      }
      settlePendingMap(pendingRpcs, callId, normalizeRpcResult(body["result"]));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/kantus/event") {
      const type = typeof body["type"] === "string" && body["type"].trim() !== "" ? body["type"].trim() : "event";
      const payload = isRecord(body["payload"]) ? body["payload"] : {};
      updateStatusFields(payload);
      if (type === "ask_answer") {
        const askId = typeof payload["askId"] === "string" ? payload["askId"] : "";
        if (askId !== "") {
          const answer = typeof payload["answer"] === "string" ? payload["answer"] : String(payload["answer"] ?? "");
          settlePendingMap(pendingAsks, askId, { ok: true, data: { answer } });
        }
      } else {
        emitEvent({ channel: type, payload, atMs: nowMs() });
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/kantus/capabilities-sync") {
      try {
        const entries = body["entries"] as CapabilityEntry[];
        const counts = options.caps.applySync(entries, { full: body["full"] === true });
        sendJson(res, 200, { ok: true, ...counts });
      } catch (error) {
        const status = error instanceof WireError ? error.status : 400;
        const code = error instanceof WireError ? error.code : "bad_sync";
        sendJson(res, status, { ok: false, code, reason: messageOf(error) });
      }
    }
  }

  async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokensEqual(bearerToken(req), options.token)) {
      req.resume();
      sendJson(res, 401, { ok: false, code: "unauthorized" });
      return;
    }
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method !== "POST") {
      req.resume();
      sendJson(res, 405, { ok: false, code: "method_not_allowed" });
      return;
    }
    if (urlPath === "/kantus/session") {
      handleSession(req, res);
      return;
    }
    if (
      urlPath === "/kantus/mode" ||
      urlPath === "/kantus/stop" ||
      urlPath === "/kantus/rpc-result" ||
      urlPath === "/kantus/event" ||
      urlPath === "/kantus/capabilities-sync"
    ) {
      await handleShortPost(req, res, urlPath);
      return;
    }
    req.resume();
    sendJson(res, 404, { ok: false, code: "not_found" });
  }

  return {
    async start(): Promise<void> {
      if (server !== null) throw new Error("The Kantus HTTP bridge is already listening.");
      const created = createServer((req, res) => {
        void routeRequest(req, res).catch((error: unknown) => {
          console.error(`[kantus-http] unhandled request error: ${messageOf(error)}`);
          sendJson(res, 500, { ok: false, code: "internal_error" });
        });
      });
      // Long-lived /kantus/session streams stay open while idle; short POST routes bound reads in readBody.
      created.requestTimeout = 0;

      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          reject(new Error(`The Kantus bridge could not listen on ${options.host}:${options.port} (${error.code ?? error.message}).`));
        };
        created.once("error", onError);
        created.listen(options.port, options.host, () => {
          created.off("error", onError);
          const addr = created.address();
          bound = typeof addr === "object" && addr !== null ? { host: addr.address, port: addr.port } : { host: options.host, port: options.port };
          server = created;
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      const closing = server;
      server = null;
      bound = null;
      const session = activeSession;
      activeSession = null;
      rejectAllPending("studio_detached", "The bridge stopped.");
      session?.close();
      if (closing !== null) {
        closing.closeAllConnections?.();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
    },

    listeningAddress() {
      return bound === null ? null : { ...bound };
    },

    status: statusNow,

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    async send(channel, payload, signal): Promise<StudioReply> {
      if (signal?.aborted) {
        return { ok: false, code: "stopped", reason: "The emergency stop ended the request to the studio." };
      }
      const session = activeSession;
      if (session === null || session.res.destroyed || session.res.writableEnded) {
        return { ok: false, code: "studio_detached", reason: "Kantus.exe is not connected." };
      }

      if (channel === "say") {
        const ref = randomUUID();
        writeNdjson(session.res, {
          type: "chat",
          entityName: options.entityName,
          text: payload["text"],
          ...(payload["replyTo"] === undefined ? {} : { replyTo: payload["replyTo"] }),
          ...(payload["files"] === undefined ? {} : { files: payload["files"] }),
        });
        return { ok: true, data: { ref } };
      }

      if (channel === "show") {
        writeNdjson(session.res, { type: "status", state: "thinking", text: payload["text"] });
        return { ok: true, data: {} };
      }

      if (channel === "typing") {
        writeNdjson(session.res, { type: "status", state: payload["running"] === true ? "thinking" : "ready" });
        return { ok: true, data: {} };
      }

      if (channel === "stop") {
        writeNdjson(session.res, { type: "status", state: "ready", stopped: true });
        return { ok: true, data: {} };
      }

      if (channel === "command" || channel === "analysis") {
        const callId = randomUUID();
        const waiter = waitOn(pendingRpcs, callId, rpcTimeoutMs, "The studio did not answer the command in time.", signal);
        writeNdjson(session.res, { type: "rpc", callId, op: payload["op"], args: payload["params"] ?? {} });
        return await waiter;
      }

      if (channel === "capabilities") {
        const callId = randomUUID();
        const waiter = waitOn(pendingRpcs, callId, rpcTimeoutMs, "The studio did not acknowledge the overview write in time.", signal);
        writeNdjson(session.res, {
          type: "rpc",
          callId,
          op: "capabilities.writeOverview",
          args: { path: payload["path"], text: payload["text"] },
        });
        return await waiter;
      }

      if (channel === "ask") {
        const askId = randomUUID();
        const waiter = waitOn(pendingAsks, askId, askTimeoutMs, "Your summoner did not answer the question before it timed out.", signal);
        writeNdjson(session.res, {
          type: "ask",
          askId,
          prompt: payload["question"],
          options: Array.isArray(payload["options"]) ? payload["options"] : [],
        });
        return await waiter;
      }

      return { ok: false, code: "unknown_channel", reason: `Unsupported studio channel ${channel}.` };
    },
  };
}
