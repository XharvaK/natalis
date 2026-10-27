import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../bin/commands/run.js";
import {
  acquireLarLock,
  LAR_LOCK_BUSY_MESSAGE,
  LAR_LOCK_DATABASE_FILE,
  LAR_LOCK_INFO_FILE,
  LarLockBusy,
} from "./lar-lock.js";

const CHILD = fileURLToPath(new URL("./lar-lock-child.mjs", import.meta.url));

type Taker = {
  child: ChildProcess;
  lines: string[];
  stderr: () => string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

let root: string;
let dir: string;
let started: Taker[];

function startTaker(): Taker {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, dir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines: string[] = [];
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveDone) => {
    child.on("exit", (code, signal) => resolveDone({ code, signal }));
  });
  const taker: Taker = { child, lines, stderr: () => stderr, done };
  started.push(taker);
  return taker;
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return check();
}

function captured(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-larlock-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), JSON.stringify({
    model: { baseUrl: "https://model.example.invalid/v1", model: "test-model", contextTokens: 1000 },
    summoner: { alias: "Mara" },
  }), "utf8");
  started = [];
});

afterEach(async () => {
  for (const taker of started) {
    if (taker.child.exitCode === null && taker.child.signalCode === null) taker.child.kill("SIGKILL");
  }
  await Promise.allSettled(started.map((taker) => taker.done));
  started = [];
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("the lar folder lock", () => {
  it("lets exactly one of twenty child processes take it", async () => {
    const takers = Array.from({ length: 20 }, () => startTaker());
    const allAnswered = await until(
      () => takers.every((taker) => taker.lines.length > 0),
      15_000,
    );
    if (!allAnswered) {
      const report = takers.map((taker, index) =>
        `#${index}: lines=${JSON.stringify(taker.lines)} stderr=${JSON.stringify(taker.stderr())}`);
      throw new Error(`not every taker answered:\n${report.join("\n")}`);
    }
    const locked = takers.filter((taker) => taker.lines.includes("LOCKED"));
    const busy = takers.filter((taker) => taker.lines.includes("BUSY LarLockBusy"));
    expect(locked).toHaveLength(1);
    expect(busy).toHaveLength(19);
  }, 30_000);

  it.skipIf(process.platform === "win32")("releases the lock when the holder is SIGKILLed", async () => {
    const holder = startTaker();
    expect(await until(() => holder.lines.includes("LOCKED"), 10_000)).toBe(true);

    const killedAt = Date.now();
    holder.child.kill("SIGKILL");
    const exit = await holder.done;
    expect(exit.signal).toBe("SIGKILL");

    const lock = acquireLarLock(dir);
    expect(Date.now() - killedAt).toBeLessThan(2_000);
    lock.release();
  });

  it("refuses a second acquire in the same process, and takes it again after release", () => {
    const lock = acquireLarLock(dir);
    const refused = captured(() => acquireLarLock(dir));
    expect(refused).toBeInstanceOf(LarLockBusy);
    expect((refused as Error).message).toBe(LAR_LOCK_BUSY_MESSAGE);

    lock.release();
    const again = acquireLarLock(dir);
    again.release();
  });

  it("writes pid, start, token and host to lar.lock.info, which is never read to decide", () => {
    writeFileSync(join(dir, LAR_LOCK_INFO_FILE), "{ this is not json", "utf8");
    const lock = acquireLarLock(dir);
    const info = JSON.parse(readFileSync(join(dir, LAR_LOCK_INFO_FILE), "utf8")) as Record<string, unknown>;
    expect(info.pid).toBe(process.pid);
    expect(typeof info.startedAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(info.startedAt)))).toBe(false);
    expect(typeof info.token).toBe("string");
    expect((info.token as string).length).toBeGreaterThanOrEqual(16);
    expect(info.host).toBe(hostname());
    lock.release();

    writeFileSync(join(dir, LAR_LOCK_INFO_FILE), "stale garbage from a dead process", "utf8");
    const again = acquireLarLock(dir);
    again.release();
  });

  it("an idle holder still blocks a second taker", async () => {
    const lock = acquireLarLock(dir);
    const taker = startTaker();
    expect(await until(() => taker.lines.length > 0, 10_000)).toBe(true);
    expect(taker.lines).toEqual(["BUSY LarLockBusy"]);
    expect(taker.stderr()).toContain(LAR_LOCK_BUSY_MESSAGE);
    lock.release();
  });

  it("uses the delete journal, never WAL, and waits 0 ms for a busy lock", async () => {
    const lock = acquireLarLock(dir);
    lock.release();

    const databasePath = join(dir, LAR_LOCK_DATABASE_FILE);
    const check = new DatabaseSync(databasePath);
    try {
      expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(check.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    } finally {
      check.close();
    }

    const raw = new DatabaseSync(databasePath, { timeout: 0 });
    try {
      raw.exec("PRAGMA locking_mode = EXCLUSIVE");
      raw.exec("BEGIN EXCLUSIVE");
      raw.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER)");
      raw.exec("INSERT INTO probe (n) VALUES (1)");
      const begin = Date.now();
      expect(captured(() => acquireLarLock(dir))).toBeInstanceOf(LarLockBusy);
      expect(Date.now() - begin).toBeLessThan(500);
    } finally {
      raw.close();
    }
  });

  it("natalis run refuses, with a plain message, while another process holds the lock", async () => {
    const lock = acquireLarLock(dir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCommand(["--dir", dir], (line) => out.push(line), (line) => err.push(line));
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([LAR_LOCK_BUSY_MESSAGE]);
    lock.release();
  });

  it("natalis run releases the lock when it stops before opening the Lar", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCommand(["--dir", dir], (line) => out.push(line), (line) => err.push(line));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("No worlds to run in");

    const lock = acquireLarLock(dir);
    lock.release();
  });
});
