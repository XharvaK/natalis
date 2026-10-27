import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLarLock } from "../../entity/lar-lock.js";
import { startVaultChannel, VAULT_CHANNEL_NO_ANSWER_MESSAGE, type VaultChannel } from "../../entity/vault-queue.js";
import { keepVaultEntry, readVaultEntry } from "../../worlds/web/vault.js";
import { vaultCommand } from "./vault.js";

let root: string;
let dir: string;
let out: string[];
let err: string[];
let prompts: string[];
let channels: VaultChannel[];

// Built at runtime, so no file in the repository holds anything key-shaped.
const typed = ["fern", "lantern", "x7", "q9", "harbor"].join("-");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-vaultcmd-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");
  out = [];
  err = [];
  prompts = [];
  channels = [];
});

afterEach(async () => {
  for (const channel of channels) await channel.close();
  channels = [];
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function startTestChannel(): Promise<VaultChannel> {
  const channel = await startVaultChannel(dir, (request) => {
    keepVaultEntry(dir, request.name, { host: request.host, value: request.value });
  });
  channels.push(channel);
  return channel;
}

function regularFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...regularFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function run(args: string[], value = typed): Promise<number> {
  return vaultCommand(
    args,
    async (prompt) => {
      prompts.push(prompt);
      return value;
    },
    (line) => out.push(line),
    (line) => err.push(line),
  );
}

describe("natalis vault", () => {
  it("lists names with their hosts and never the values", async () => {
    expect(await run(["--dir", dir])).toBe(0);
    expect(out).toEqual(["The vault is empty."]);

    keepVaultEntry(dir, "board_key", { host: "board.example.org", value: typed });
    out = [];
    expect(await run(["--dir", dir])).toBe(0);
    expect(out).toEqual(["board_key (for board.example.org)"]);
    expect(out.join("\n")).not.toContain(typed);
  });

  it("keeps a typed value for one host and never prints it", async () => {
    expect(await run(["--dir", dir, "--keep", "board_key", "--host", "WWW.Board.Example.org."])).toBe(0);
    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "www.board.example.org", value: typed });
    expect(prompts[0]).toContain("sent only to www.board.example.org");
    expect(out.join("\n")).toContain("Kept the value named board_key");
    expect(out.join("\n")).toContain("restart it");
    expect([...out, ...err, ...prompts].join("\n")).not.toContain(typed);
  });

  it("refuses to replace a value unless --replace is given", async () => {
    keepVaultEntry(dir, "board_key", { host: "board.example.org", value: typed });
    const next = [typed, "2"].join("");
    expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"], next)).toBe(1);
    expect(err.join("\n")).toContain("--replace");
    expect(prompts).toEqual([]);
    expect(readVaultEntry(dir, "board_key")?.value).toBe(typed);

    expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org", "--replace"], next)).toBe(0);
    expect(readVaultEntry(dir, "board_key")?.value).toBe(next);
    expect(out.at(-1)).toContain("Replaced");
  });

  it("refuses empty, short, spaced values and keeps nothing", async () => {
    for (const bad of ["", "   ", "short", ["two", "words", "here"].join(" ")]) {
      err = [];
      expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"], bad)).toBe(1);
      expect(err.join("\n")).toContain("Nothing was kept");
    }
    expect(readVaultEntry(dir, "board_key")).toBeUndefined();
  });

  it("refuses a bad name, a bad host and a folder that is not an entity", async () => {
    expect(await run(["--dir", dir, "--keep", "../up", "--host", "board.example.org"])).toBe(2);
    expect(await run(["--dir", dir, "--keep", "board_key", "--host", "localhost"])).toBe(2);
    expect(await run(["--dir", dir, "--keep", "board_key"])).toBe(2);
    expect(await run(["--dir", root])).toBe(1);
    expect(await run([])).toBe(2);
    expect(prompts).toEqual([]);
    expect(readVaultEntry(dir, "board_key")).toBeUndefined();
  });

  it("refuses a keep while another holder has the lock and no channel answers, and keeps it once the lock is free", async () => {
    const lock = acquireLarLock(dir);
    try {
      expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"])).toBe(1);
      expect(err).toEqual([VAULT_CHANNEL_NO_ANSWER_MESSAGE]);
      expect(prompts).toEqual([]);
      expect(readVaultEntry(dir, "board_key")).toBeUndefined();
      // Listing names does not write, so it still works while the lock is held.
      out = [];
      expect(await run(["--dir", dir])).toBe(0);
      expect(out).toEqual(["The vault is empty."]);
    } finally {
      lock.release();
    }
    // The Lar is stopped (no lock): a keep writes as it did before.
    expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"])).toBe(0);
    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value: typed });
  });

  it("keeps through the running Lar's channel, and the marker stays out of every other file and log", async () => {
    const value = ["harbor", "bramble", "quartz", "meadow", "tide"].join("-");
    const printer = ["log", "error", "warn", "info"] as const;
    const logged: string[] = [];
    const spies = printer.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    const lock = acquireLarLock(dir);
    try {
      await startTestChannel();
      expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"], value)).toBe(0);
      expect(err).toEqual([]);
      expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value });
      expect(out.join("\n")).toContain("The running Lar has it now");
      expect(prompts[0]).toContain("sent only to board.example.org");
      expect([...out, ...err, ...prompts, ...logged].join("\n")).not.toContain(value);

      const vaultFile = join(dir, "vault", "board_key.json");
      const others = regularFiles(dir).filter((file) => file !== vaultFile);
      expect(others).toContain(join(dir, "entity.json"));
      for (const file of others) {
        expect(readFileSync(file).toString("utf8"), file).not.toContain(value);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      lock.release();
    }
  });

  it("keeps two values at once through the channel and both land", async () => {
    const first = ["cobalt", "thistle", "amber", "willow"].join("-");
    const second = ["marigold", "pebble", "clover", "tide"].join("-");
    const lock = acquireLarLock(dir);
    try {
      await startTestChannel();
      const codes = await Promise.all([
        run(["--dir", dir, "--keep", "first_key", "--host", "one.example.org"], first),
        run(["--dir", dir, "--keep", "second_key", "--host", "two.example.org"], second),
      ]);
      expect(codes).toEqual([0, 0]);
      expect(err).toEqual([]);
      expect(readVaultEntry(dir, "first_key")).toEqual({ host: "one.example.org", value: first });
      expect(readVaultEntry(dir, "second_key")).toEqual({ host: "two.example.org", value: second });
    } finally {
      lock.release();
    }
  });
});
