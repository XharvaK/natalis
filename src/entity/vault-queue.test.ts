import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretScanner } from "../secrets/index.js";
import { keepVaultEntry, readVaultEntry } from "../worlds/web/vault.js";
import {
  openVaultChannel,
  startVaultChannel,
  VAULT_CHANNEL_TIMEOUT_MS,
  VAULT_SOCKET_FILE,
  vaultChannelPath,
  vaultPipeName,
  type VaultChannel,
  type VaultChannelClient,
  type VaultKeepRequest,
} from "./vault-queue.js";

let root: string;
let dir: string;
let channels: VaultChannel[];

// Built at runtime, so no file in the repository holds anything key-shaped.
function marker(...parts: string[]): string {
  return parts.join("-");
}

function talk(path: string, lines: string[], count: number): Promise<string[]> {
  return new Promise((resolveTalk, rejectTalk) => {
    const socket = connect(path);
    const replies: string[] = [];
    let buffer = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy();
      rejectTalk(new Error(`the channel did not answer; buffered ${JSON.stringify(buffer)}`));
    }, 3_000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolveTalk(replies);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(lines.map((line) => `${line}\n`).join("")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        replies.push(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        if (replies.length >= count) {
          finish();
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectTalk(error);
    });
  });
}

/** Sends one line and resolves with the reply only when the server closes the connection. */
function untilClosed(path: string, line: string): Promise<string> {
  return new Promise((resolveRead, rejectRead) => {
    const socket = connect(path);
    let buffer = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy();
      rejectRead(new Error(`the channel did not close; buffered ${JSON.stringify(buffer)}`));
    }, 3_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRead(buffer.trim());
    });
    socket.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRead(buffer.trim());
    });
    socket.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectRead(error);
    });
  });
}

async function start(keep: (request: VaultKeepRequest) => void | Promise<void>): Promise<VaultChannel> {
  const channel = await startVaultChannel(dir, keep);
  channels.push(channel);
  return channel;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-vaultqueue-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");
  channels = [];
});

afterEach(async () => {
  for (const channel of channels) await channel.close();
  channels = [];
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("the vault channel", () => {
  it("names the Windows pipe from the first 16 hex of sha256 of the folder's absolute path", () => {
    const expected = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
    expect(vaultPipeName(dir)).toBe(`\\\\.\\pipe\\natalis-vault-${expected}`);
    expect(vaultPipeName(join(root, "other"))).not.toBe(vaultPipeName(dir));
  });

  it.skipIf(process.platform === "win32")("puts an owner-only socket in the Lar folder and removes it on close", async () => {
    expect(vaultChannelPath(dir)).toBe(join(resolve(dir), VAULT_SOCKET_FILE));
    const channel = await start((request) => keepVaultEntry(dir, request.name, { host: request.host, value: request.value }));
    expect(channel.path).toBe(join(resolve(dir), VAULT_SOCKET_FILE));
    expect(existsSync(channel.path)).toBe(true);
    const stat = statSync(channel.path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);

    await channel.close();
    expect(existsSync(channel.path)).toBe(false);
    await expect(openVaultChannel(dir, 200)).rejects.toThrow();
  });

  it("keeps a value through the channel, and a reader in the same process sees it", async () => {
    const scanner = createSecretScanner();
    await start((request) => {
      scanner.addKnownValue(request.value);
      keepVaultEntry(dir, request.name, { host: request.host, value: request.value });
    });
    const value = marker("harbor", "bramble", "quartz", "meadow", "tide");
    const client = await openVaultChannel(dir);
    try {
      expect(await client.send({ op: "keep", name: "board_key", host: "board.example.org", value, replace: false })).toBe("kept");
    } finally {
      client.close();
    }

    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value });
    expect(readFileSync(join(dir, "vault", "board_key.json"), "utf8")).toBe(JSON.stringify({ host: "board.example.org", value }));
    expect(scanner.redact(`the page showed ${value} back`)).not.toContain(value);
  });

  it("refuses any other operation and closes that connection", async () => {
    await start((request) => keepVaultEntry(dir, request.name, { host: request.host, value: request.value }));

    const otherOp = await untilClosed(channelPath(), JSON.stringify({ op: "remove", name: "board_key" }));
    expect(otherOp).not.toBe("kept");
    expect(otherOp).toContain("keep");

    const notJson = await untilClosed(channelPath(), "this is not json");
    expect(notJson).not.toBe("kept");
    expect(notJson.toLowerCase()).toContain("json");
    expect(readVaultEntry(dir, "board_key")).toBeUndefined();
  });

  it("runs two keeps at once one after the other, in order, and both land", async () => {
    const order: string[] = [];
    let active = 0;
    let mostActive = 0;
    await start(async (request) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      order.push(request.name);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      keepVaultEntry(dir, request.name, { host: request.host, value: request.value });
      active -= 1;
    });
    const first = marker("cobalt", "thistle", "amber", "willow");
    const second = marker("marigold", "pebble", "clover", "tide");
    const replies = await talk(
      channelPath(),
      [
        JSON.stringify({ op: "keep", name: "first_key", host: "one.example.org", value: first, replace: false }),
        JSON.stringify({ op: "keep", name: "second_key", host: "two.example.org", value: second, replace: false }),
      ],
      2,
    );

    expect(replies).toEqual(["kept", "kept"]);
    expect(order).toEqual(["first_key", "second_key"]);
    expect(mostActive).toBe(1);
    expect(readVaultEntry(dir, "first_key")).toEqual({ host: "one.example.org", value: first });
    expect(readVaultEntry(dir, "second_key")).toEqual({ host: "two.example.org", value: second });
  });

  it.skipIf(process.platform === "win32")("replaces a stale socket file left by a kill", async () => {
    const stale = vaultChannelPath(dir);
    writeFileSync(stale, "stale from a run that was killed", "utf8");
    expect(existsSync(stale)).toBe(true);

    const channel = await start((request) => keepVaultEntry(dir, request.name, { host: request.host, value: request.value }));
    expect(statSync(stale).isSocket()).toBe(true);
    const value = marker("harbor", "bramble", "clover", "meadow");
    const client = await openVaultChannel(dir);
    try {
      expect(await client.send({ op: "keep", name: "board_key", host: "board.example.org", value, replace: false })).toBe("kept");
    } finally {
      client.close();
    }
    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value });
    expect(channel.path).toBe(stale);
  });

  it("gives up when a channel accepts the connection but never answers", async () => {
    const accepted = new Set<Socket>();
    const server = createServer((socket) => {
      // Accepts the connection and says nothing.
      accepted.add(socket);
      socket.on("close", () => accepted.delete(socket));
    });
    await new Promise<void>((resolveListen) => server.listen(vaultChannelPath(dir), () => resolveListen()));
    let client: VaultChannelClient | undefined;
    try {
      client = await openVaultChannel(dir, 100);
      await expect(
        client.send({ op: "keep", name: "board_key", host: "board.example.org", value: marker("harbor", "quartz"), replace: false }),
      ).rejects.toThrow(/answer/i);
    } finally {
      client?.close();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("uses a five-second wait when none is given", () => {
    expect(VAULT_CHANNEL_TIMEOUT_MS).toBe(5_000);
  });

  it("has no socket or pipe left after close, even with a client still connected", async () => {
    const channel = await start((request) => keepVaultEntry(dir, request.name, { host: request.host, value: request.value }));
    const client = await openVaultChannel(dir);
    await channel.close();
    client.close();
    await expect(openVaultChannel(dir, 100)).rejects.toThrow();
  });
});

function channelPath(): string {
  return vaultChannelPath(dir);
}
