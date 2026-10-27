import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "./config.js";
import {
  checkCopyGuard,
  CopyGuardRefused,
  FOLDER_HASH_KEY,
  FOLDER_MOVED_MESSAGE,
  folderHash,
  machineId,
} from "./copy-guard.js";
import { acquireLarLock } from "./lar-lock.js";
import { openEntity, STATE_FILE, type Entity, type OpenEntityOptions } from "./runtime.js";
import { copyForReplay } from "../replay/copy.js";
import { ScriptedModel } from "../testing/scripted-model.js";
import { createCliWorld } from "../worlds/cli.js";
import { runCommand } from "../bin/commands/run.js";

const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "owner" },
};

/** An invented machine id, so the hash test never depends on this host. */
const MACHINE = "fixture-machine-0001";

let root: string;
let templateRoot: string;
let templateNotebook: string;
const opened: Entity[] = [];

beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "natalis-copy-guard-template-"));
  const seeded = join(templateRoot, "seeded");
  const entity = await openEntity({
    dir: seeded,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
    purpose: "eval",
  });
  await entity.stop();
  templateNotebook = join(seeded, "notebook");
}, 60_000);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-copy-guard-"));
});

afterEach(async () => {
  while (opened.length > 0) {
    const entity = opened.pop();
    if (entity !== undefined) await entity.stop().catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function openLive(dir: string, extra: Partial<OpenEntityOptions> = {}): Promise<Entity> {
  if (!existsSync(join(dir, "notebook"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(templateNotebook, join(dir, "notebook"), { recursive: true });
  }
  const entity = await openEntity({
    dir,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
    ...extra,
  });
  opened.push(entity);
  return entity;
}

async function close(entity: Entity): Promise<void> {
  await entity.stop();
  const at = opened.indexOf(entity);
  if (at >= 0) opened.splice(at, 1);
}

/** A live Lar folder, then a copy of the whole folder at another path. Both have entity.json. */
async function copiedLar(extraFiles: Record<string, string> = {}): Promise<{ source: string; copy: string }> {
  const source = join(root, "iris");
  await close(await openLive(source));
  writeFileSync(join(source, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  for (const [name, text] of Object.entries(extraFiles)) writeFileSync(join(source, name), text);
  const copy = join(root, "copy");
  cpSync(source, copy, { recursive: true });
  return { source, copy };
}

function stateOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Record<string, unknown>;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for natalis run to start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("folder hash", () => {
  it("hashes the machine id and the folder's absolute real path", () => {
    const dir = join(root, "iris");
    mkdirSync(dir);
    const expected = createHash("sha256").update(`${MACHINE}\n${realpathSync(dir)}`).digest("hex");
    expect(folderHash(dir, MACHINE)).toBe(expected);
  });

  it("reads the machine id from the host files, else the host name", () => {
    const fromFiles = ["/etc/machine-id", "/var/lib/dbus/machine-id"].flatMap((path) => {
      try {
        const text = readFileSync(path, "utf8").trim();
        return text === "" ? [] : [text];
      } catch {
        return [];
      }
    });
    expect(machineId()).toBe(fromFiles[0] ?? hostname());
  });
});

describe("the copy guard decision", () => {
  it("records a missing hash, keeps a matching one, and re-records after a move", () => {
    const dir = join(root, "iris");
    mkdirSync(dir);
    const hash = folderHash(dir, MACHINE);
    expect(checkCopyGuard({ dir, recorded: undefined, machine: MACHINE })).toEqual({ action: "record", folderHash: hash });
    expect(checkCopyGuard({ dir, recorded: hash, machine: MACHINE })).toEqual({ action: "keep", folderHash: hash });
    expect(checkCopyGuard({ dir, recorded: "somewhere-else", moved: true, machine: MACHINE })).toEqual({
      action: "record",
      folderHash: hash,
    });
  });

  it("refuses a different folder with the exact message", () => {
    const dir = join(root, "iris");
    mkdirSync(dir);
    expect(checkCopyGuard({ dir, recorded: "somewhere-else", machine: MACHINE })).toEqual({
      action: "refuse",
      message: FOLDER_MOVED_MESSAGE,
    });
    expect(FOLDER_MOVED_MESSAGE).toBe("This Lar's folder was moved or copied. If this is the real Lar, start it with --moved.");
  });
});

describe("a live Lar in a copied folder", () => {
  it("refuses to start, with the exact message and no new hash", async () => {
    const { source, copy } = await copiedLar();
    const attempt = openEntity({
      dir: copy,
      config: CONFIG,
      model: new ScriptedModel([]),
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    await expect(attempt).rejects.toBeInstanceOf(CopyGuardRefused);
    await expect(attempt).rejects.toMatchObject({ message: FOLDER_MOVED_MESSAGE });
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe(folderHash(source));
  });

  it("starts with moved, re-records the new folder, and starts normally after that", async () => {
    const { copy } = await copiedLar();
    await expect(
      openEntity({ dir: copy, config: CONFIG, model: new ScriptedModel([]), worlds: [createCliWorld({ onSay: () => {} })] }),
    ).rejects.toBeInstanceOf(CopyGuardRefused);

    await close(await openLive(copy, { moved: true }));
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe(folderHash(copy));

    const again = await openLive(copy);
    expect(again.river.lastSeq()).toBe(0);
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe(folderHash(copy));
  });
});

describe("first start and the state file", () => {
  it("records the hash when the key is missing, and starts normally", async () => {
    const dir = join(root, "fresh");
    await openLive(dir);
    expect(stateOf(dir)[FOLDER_HASH_KEY]).toBe(folderHash(dir));
  });

  it("loads state.json that already carries folderHash through the existing state loader", async () => {
    const dir = join(root, "loader");
    mkdirSync(dir);
    const recorded = "a-hash-from-an-earlier-start";
    writeFileSync(
      join(dir, STATE_FILE),
      `${JSON.stringify({ lastSeq: 0, threads: {}, asks: [], wakes: [], mood: null, folderHash: recorded }, null, 2)}\n`,
    );
    const entity = await openEntity({
      dir,
      config: CONFIG,
      model: new ScriptedModel([]),
      worlds: [createCliWorld({ onSay: () => {} })],
      purpose: "eval",
    });
    opened.push(entity);
    await close(entity);
    expect(stateOf(dir)[FOLDER_HASH_KEY]).toBe(recorded);
  });
});

describe("replay and eval copies", () => {
  it("a replay copy starts, never refuses, and keeps no hash of its own", async () => {
    const source = join(root, "iris");
    const entity = await openLive(source);
    const at = Date.now();
    entity.river.append({ thread: "cli:owner", kind: "event", source: "owner", place: "cli:owner", text: "Hello.", atMs: at });
    await close(entity);
    writeFileSync(join(source, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);

    const copy = join(root, "replay");
    await copyForReplay({ from: source, to: copy, cutAtMs: at + 60_000 });
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBeUndefined();

    // Even a hash left by an earlier copy never refuses a replay and is never replaced.
    const state = stateOf(copy);
    state[FOLDER_HASH_KEY] = "a-folder-from-elsewhere";
    writeFileSync(join(copy, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    const replay = await openEntity({
      dir: copy,
      config: CONFIG,
      model: new ScriptedModel([]),
      worlds: [createCliWorld({ onSay: () => {} })],
      purpose: "replay",
    });
    opened.push(replay);
    await replay.start();
    await close(replay);
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe("a-folder-from-elsewhere");
  });

  it("an eval copy starts and never records the folder it is in", async () => {
    const { source, copy } = await copiedLar();
    const entity = await openEntity({
      dir: copy,
      config: CONFIG,
      model: new ScriptedModel([]),
      worlds: [createCliWorld({ onSay: () => {} })],
      purpose: "eval",
    });
    opened.push(entity);
    await entity.start();
    await close(entity);
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe(folderHash(source));
  });
});

describe("natalis run", () => {
  it("refuses a copied folder with the exact message, exit 1, and no other output", async () => {
    const { copy } = await copiedLar({ "web.json": "{}\n" });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCommand(["--dir", copy], (line) => out.push(line), (line) => err.push(line));
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([FOLDER_MOVED_MESSAGE]);
    const lock = acquireLarLock(copy);
    lock.release();
  });

  it("--moved starts the copied Lar and records its new folder", async () => {
    const { copy } = await copiedLar({ "web.json": "{}\n" });
    const out: string[] = [];
    const err: string[] = [];
    const before = new Set(process.listeners("SIGINT"));
    const running = runCommand(["--dir", copy, "--moved"], (line) => out.push(line), (line) => err.push(line));
    await waitFor(() => out.some((line) => line.includes("is running in:")));
    const added = process.listeners("SIGINT").filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(await running).toBe(0);
    expect(err).toEqual([]);
    expect(stateOf(copy)[FOLDER_HASH_KEY]).toBe(folderHash(copy));
  }, 20_000);
});
