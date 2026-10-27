// The vault queue: while `natalis run` holds the Lar folder lock, it listens on one local channel so
// `natalis vault --keep` can hand it a value instead of writing the folder itself. There is still one writer.
// Linux and macOS use <lar>/vault.sock, owner-only; Windows uses a named pipe named from the folder's hash.
// The channel takes one operation, keep. Each request is one JSON line. It closes when the Lar stops.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { MIN_KNOWN_VALUE_LENGTH } from "../secrets/scanner.js";
import { readVaultEntry, validVaultName } from "../worlds/web/vault.js";

export const VAULT_SOCKET_FILE = "vault.sock";
export const VAULT_CHANNEL_TIMEOUT_MS = 5_000;
export const VAULT_VALUE_MAX = 4096;
export const VAULT_CHANNEL_NO_ANSWER_MESSAGE =
  "This Lar is already in use by another natalis process, and its vault channel did not answer. Nothing was kept. " +
  "Stop it, then keep the value again.";
export const VAULT_CHANNEL_ONLY_KEEP_MESSAGE = "The vault channel takes only a keep. Nothing was kept.";
const REQUEST_LINE_MAX = 64 * 1024;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The one operation the channel takes. */
export type VaultKeepRequest = {
  op: "keep";
  name: string;
  host: string;
  value: string;
  replace: boolean;
};

/** The listening side of the channel, held by the running Lar. */
export type VaultChannel = {
  readonly path: string;
  /** Stops listening, finishes any keep already under way, and removes the socket. Calling it twice does nothing. */
  close(): Promise<void>;
};

/** The client side, used by `natalis vault --keep` while the Lar runs. */
export type VaultChannelClient = {
  /** Sends one keep and resolves with "kept" or the Lar's error text. */
  send(request: VaultKeepRequest): Promise<string>;
  close(): void;
};

export type VaultChannelOptions = {
  /** A server error after listening starts. The words never hold a value. */
  onError?: (message: string) => void;
};

/** A host the vault binds a value to: lowercase, no trailing dot, one full name, as the vault command takes it. */
export function normalizeVaultHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/\.+$/, "");
  return HOST.test(host) ? host : undefined;
}

/** The Windows named pipe for one Lar folder: the first 16 hex digits of sha256 of its absolute path. */
export function vaultPipeName(dir: string): string {
  const hash = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\natalis-vault-${hash}`;
}

/** Where the channel listens: a Unix socket in the Lar folder, or a named pipe on Windows. */
export function vaultChannelPath(dir: string): string {
  return process.platform === "win32" ? vaultPipeName(dir) : join(resolve(dir), VAULT_SOCKET_FILE);
}

/**
 * Opens the channel in `dir` and takes keeps until close(). Only the process that won the Lar folder lock may
 * call this: a stale socket is removed here, after that lock is already held.
 */
export async function startVaultChannel(
  dir: string,
  keep: (request: VaultKeepRequest) => void | Promise<void>,
  options: VaultChannelOptions = {},
): Promise<VaultChannel> {
  const folder = resolve(dir);
  const path = vaultChannelPath(folder);
  if (process.platform !== "win32") removeStaleSocket(path);

  const sockets = new Set<Socket>();
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (job: () => void | Promise<void>): Promise<void> => {
    const next = tail.then(job, job);
    tail = next.catch(() => {});
    return next;
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client that goes away mid-request is not an error for the Lar; it simply gets no answer.
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let refusing = false;
    socket.on("data", (chunk: string) => {
      if (refusing) return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        void enqueue(() => handleLine(socket, line));
      }
      if (buffer.length > REQUEST_LINE_MAX) {
        buffer = "";
        refusing = true;
        void enqueue(() => replyAndClose(socket, "The request was too long. Nothing was kept."));
      }
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const failed = (error: Error) => rejectListen(error);
      server.once("error", failed);
      server.listen(path, () => {
        server.off("error", failed);
        resolveListen();
      });
    });
    if (process.platform !== "win32") {
      // The socket is created with the umask's mode; make it owner-only, then check it is in the Lar folder.
      chmodSync(path, 0o600);
      checkSocketInFolder(folder, path);
    }
  } catch (error) {
    try {
      server.close();
    } catch {
      // The server never listened; there is nothing to close.
    }
    if (process.platform !== "win32") {
      try {
        unlinkSync(path);
      } catch {
        // No socket file was made, or another process already removed it.
      }
    }
    throw error;
  }

  server.on("error", (error) => {
    options.onError?.(error instanceof Error ? error.message : String(error));
  });

  let closing: Promise<void> | undefined;
  return {
    path,
    close(): Promise<void> {
      closing ??= (async () => {
        const closed = new Promise<void>((resolveClose) => {
          try {
            server.close(() => resolveClose());
          } catch {
            resolveClose();
          }
        });
        // A keep already accepted finishes, so a client never sees "kept" for a write that did not happen.
        await tail;
        for (const socket of sockets) socket.destroy();
        await closed;
        if (process.platform !== "win32") {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      })();
      return closing;
    },
  };

  /** Runs one request. Every error is an answer, never a throw: a broken client cannot stop the channel. */
  async function handleLine(socket: Socket, line: string): Promise<void> {
    const checked = checkRequest(line);
    if (!checked.ok) {
      replyAndClose(socket, checked.error);
      return;
    }
    const request = checked.value;
    try {
      const existing = readVaultEntry(folder, request.name);
      if (existing !== undefined && !request.replace) {
        replyAndClose(
          socket,
          `The vault already has a value named ${request.name} (for ${existing.host}). Add --replace to replace it. Nothing was kept.`,
        );
        return;
      }
      await keep(request);
      if (!socket.destroyed && socket.writable) socket.write("kept\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      replyAndClose(socket, withoutValue(`The value could not be kept: ${message} Nothing was kept.`, request.value));
    }
  }
}

/** Reads one JSON line and checks every field the channel takes. Errors are plain words and never echo the value. */
function checkRequest(line: string): { ok: true; value: VaultKeepRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, error: "The request was not one line of JSON. Nothing was kept." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "The request is not one object. Nothing was kept." };
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!["op", "name", "host", "value", "replace"].includes(key)) {
      return { ok: false, error: "The keep had a field the vault channel does not take. Nothing was kept." };
    }
  }
  if (root["op"] !== "keep") return { ok: false, error: VAULT_CHANNEL_ONLY_KEEP_MESSAGE };

  const name = root["name"];
  if (typeof name !== "string" || !validVaultName(name)) {
    return { ok: false, error: "A vault name is letters, digits, dots, dashes and underscores, up to 48 characters. Nothing was kept." };
  }
  const host = typeof root["host"] === "string" ? normalizeVaultHost(root["host"]) : undefined;
  if (host === undefined) {
    return {
      ok: false,
      error: "--host is the site the value is sent to, such as www.example.org. The value goes only to that host and its subdomains. Nothing was kept.",
    };
  }
  const value = root["value"];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "No value was given. Nothing was kept." };
  }
  if (/\s/.test(value) || value.length > VAULT_VALUE_MAX) {
    return { ok: false, error: `A value is one piece of text with no spaces or line breaks, up to ${VAULT_VALUE_MAX} characters. Nothing was kept.` };
  }
  if (value.length < MIN_KNOWN_VALUE_LENGTH) {
    return {
      ok: false,
      error: `A value shorter than ${MIN_KNOWN_VALUE_LENGTH} characters cannot be hidden from the Lar's text, so it cannot be kept. Nothing was kept.`,
    };
  }
  const replace = root["replace"];
  if (typeof replace !== "boolean") {
    return { ok: false, error: "The keep must say whether it replaces a value. Nothing was kept." };
  }
  return { ok: true, value: { op: "keep", name, host, value, replace } };
}

function replyAndClose(socket: Socket, text: string): void {
  if (!socket.destroyed && socket.writable) socket.write(`${text}\n`);
  socket.end();
}

function withoutValue(text: string, value: string): string {
  return value === "" ? text : text.split(value).join("[the value was withheld]");
}

/** Removes a socket file left by a killed run. The caller holds the lock, so no live channel owns it. */
function removeStaleSocket(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) throw new Error(`${path} is a folder, not a stale vault socket. Nothing was opened.`);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** The socket must be owner-only and in the real Lar folder, not somewhere a link points. */
function checkSocketInFolder(folder: string, path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket()) throw new Error(`The vault channel at ${path} is not a socket.`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`The vault channel at ${path} is not owner-only.`);
  if (realpathSync(dirname(path)) !== realpathSync(folder)) {
    throw new Error(`The vault channel at ${path} is not in the Lar folder.`);
  }
}

/** Connects to the running Lar's channel. Throws when nothing answers within the timeout. */
export async function openVaultChannel(dir: string, timeoutMs: number = VAULT_CHANNEL_TIMEOUT_MS): Promise<VaultChannelClient> {
  const socket = connect(vaultChannelPath(dir));
  socket.setEncoding("utf8");
  let buffer = "";
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  let closed = false;

  await new Promise<void>((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error("The vault channel did not answer in time."));
    }, timeoutMs);
    const connected = () => {
      clearTimeout(timer);
      socket.off("error", failed);
      resolveConnect();
    };
    const failed = (error: Error) => {
      clearTimeout(timer);
      socket.off("connect", connected);
      rejectConnect(error);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
  });

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const waiting = pending;
      if (waiting !== undefined) {
        pending = undefined;
        clearTimeout(waiting.timer);
        waiting.resolve(line);
      }
    }
  });
  socket.on("error", (error) => failPending(error));
  socket.on("close", () => {
    closed = true;
    failPending(new Error("The vault channel closed before it answered."));
  });

  function failPending(error: Error): void {
    const waiting = pending;
    if (waiting === undefined) return;
    pending = undefined;
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }

  return {
    send(request: VaultKeepRequest): Promise<string> {
      return new Promise<string>((resolveSend, rejectSend) => {
        if (closed) {
          rejectSend(new Error("The vault channel is closed."));
          return;
        }
        if (pending !== undefined) {
          rejectSend(new Error("The vault channel is already answering a keep."));
          return;
        }
        const timer = setTimeout(() => {
          const waiting = pending;
          pending = undefined;
          socket.destroy();
          if (waiting !== undefined) waiting.reject(new Error("The vault channel did not answer in time."));
        }, timeoutMs);
        pending = { resolve: resolveSend, reject: rejectSend, timer };
        socket.write(`${JSON.stringify(request)}\n`);
      });
    },
    close(): void {
      closed = true;
      failPending(new Error("The vault channel is closed."));
      socket.destroy();
    },
  };
}
