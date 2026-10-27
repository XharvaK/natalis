import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultChannelPath } from "../../entity/vault-queue.js";
import { readVaultEntry } from "../../worlds/web/vault.js";
import { vaultCommand } from "./vault.js";
import { parseDiscordFile } from "./run.js";

describe("discord.json", () => {
  it("reads the token's variable name, the owner and the rooms", () => {
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", rooms: ["5678"] })).toEqual({
      tokenEnv: "TEST_BOT_TOKEN",
      ownerUserId: "1234",
      rooms: ["5678"],
    });
    expect(parseDiscordFile({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234" }).rooms).toEqual([]);
  });

  it("refuses a token written in place of its variable name, and unknown fields", () => {
    const tokenShaped = ["abc", "def", "ghi"].join(".");
    expect(() => parseDiscordFile({ tokenEnv: tokenShaped, ownerUserId: "1", rooms: [] })).toThrow(/tokenEnv/);
    expect(() => parseDiscordFile({ token: "x", tokenEnv: "T", ownerUserId: "1" })).toThrow(/Unknown field "token"/);
    expect(() => parseDiscordFile({ tokenEnv: "T", ownerUserId: "mara" })).toThrow(/ownerUserId/);
    expect(() => parseDiscordFile({ tokenEnv: "T", ownerUserId: "1", rooms: ["general"] })).toThrow(/rooms/);
  });
});

describe("after Stopped., round 6", () => {
  it("P1-2: the process is made to exit after a short grace if the event loop does not drain", async () => {
    const { armExitFailsafe } = await import("./run.js");
    const codes: number[] = [];
    const timer = armExitFailsafe(0, 10, (code) => codes.push(code));
    await new Promise((r) => setTimeout(r, 40));
    expect(codes).toEqual([0]);
    expect(timer.hasRef()).toBe(false);
  });
});

describe("after Stopped., round 7 (N-C)", () => {
  it("a loop that did not drain exits non-zero, with a warning", async () => {
    const { armExitFailsafe, EXIT_NOT_DRAINED } = await import("./run.js");
    expect(EXIT_NOT_DRAINED).not.toBe(0);
    const codes: number[] = [];
    const warnings: string[] = [];
    armExitFailsafe(EXIT_NOT_DRAINED, 10, (code) => codes.push(code), (line) => warnings.push(line));
    await new Promise((r) => setTimeout(r, 40));
    expect(codes).toEqual([EXIT_NOT_DRAINED]);
    expect(warnings).toEqual([expect.stringMatching(/^<4>\[natalis\] warning: the event loop did not drain 10 ms after stopping/)]);
  });
});

const RUN_CHILD = fileURLToPath(new URL("./run-vault-child.mjs", import.meta.url));
const TS_RESOLVE = fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url));

function regularFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...regularFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return check();
}

describe("the vault channel while run is live", () => {
  let root: string | undefined;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    root = undefined;
    child = undefined;
  });

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child !== undefined) {
      await new Promise<void>((resolveExit) => {
        if (child!.exitCode !== null || child!.signalCode !== null) resolveExit();
        else child!.once("exit", () => resolveExit());
      });
    }
    if (root !== undefined) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    root = undefined;
    child = undefined;
  });

  it.skipIf(process.platform === "win32")("a keep lands in the vault, the running Lar has it, and the socket goes on stop", async () => {
    const value = ["harbor", "bramble", "quartz", "meadow", "tide"].join("-");
    root = mkdtempSync(join(tmpdir(), "natalis-runvault-"));
    const dir = join(root, "iris");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "entity.json"),
      JSON.stringify({
        model: { baseUrl: "https://model.example.invalid/v1", model: "test-model", contextTokens: 1000 },
        summoner: { alias: "Mara" },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "web.json"), JSON.stringify({ sites: [] }), "utf8");
    const socketPath = vaultChannelPath(dir);
    // A run killed earlier leaves its socket file behind. This start must replace it, after it wins the lock.
    writeFileSync(socketPath, "stale from a run that was killed", "utf8");

    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", "--experimental-loader", TS_RESOLVE, RUN_CHILD, dir], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child!.on("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const up = await until(() => stdout.includes("is running in: web") && existsSync(socketPath), 20_000);
    if (!up) throw new Error(`the run did not start\nstdout: ${stdout}\nstderr: ${stderr}`);
    expect(statSync(socketPath).isSocket()).toBe(true);

    const out: string[] = [];
    const err: string[] = [];
    const code = await vaultCommand(
      ["--dir", dir, "--keep", "board_key", "--host", "board.example.org"],
      async () => value,
      (line) => out.push(line),
      (line) => err.push(line),
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("The running Lar has it now");
    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value });
    expect(stdout).not.toContain(value);
    expect(stderr).not.toContain(value);

    expect(child.kill("SIGTERM")).toBe(true);
    const ended = await exit;
    expect(ended).toEqual({ code: 0, signal: null });
    expect(existsSync(socketPath)).toBe(false);

    // The value is in the vault file, and in no other file the Lar folder holds (river, logs, state, notebook).
    expect(readVaultEntry(dir, "board_key")).toEqual({ host: "board.example.org", value });
    const vaultFile = join(dir, "vault", "board_key.json");
    const files = regularFiles(dir);
    expect(files).toContain(vaultFile);
    expect(files).toContain(join(dir, "river.db"));
    for (const file of files) {
      if (file === vaultFile) continue;
      expect(readFileSync(file).toString("utf8"), file).not.toContain(value);
    }
  }, 30_000);
});
