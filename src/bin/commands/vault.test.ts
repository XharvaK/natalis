import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLarLock, LAR_LOCK_BUSY_MESSAGE } from "../../entity/lar-lock.js";
import { keepVaultEntry, readVaultEntry } from "../../worlds/web/vault.js";
import { vaultCommand } from "./vault.js";

let root: string;
let dir: string;
let out: string[];
let err: string[];
let prompts: string[];

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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

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

  it("refuses a keep while another holder has the lock, and keeps it once the lock is free", async () => {
    const lock = acquireLarLock(dir);
    try {
      expect(await run(["--dir", dir, "--keep", "board_key", "--host", "board.example.org"])).toBe(1);
      expect(err).toEqual([LAR_LOCK_BUSY_MESSAGE]);
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
});
