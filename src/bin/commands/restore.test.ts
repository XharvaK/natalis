import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityConfig } from "../../entity/config.js";
import { openEntity, type Entity } from "../../entity/runtime.js";
import { openRiver } from "../../river/index.js";
import { ScriptedModel } from "../../testing/scripted-model.js";
import { createCliWorld } from "../../worlds/cli.js";
import { BUNDLE_FILE, MANIFEST_FILE, readRiverLastSeq, type Manifest } from "./backup-format.js";
import { backupEntity } from "./backup.js";
import { restoreCommand, restoreEntity } from "./restore.js";

const T0 = Date.UTC(2026, 9, 11, 9, 0, 0);
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "summoner" },
};

let root: string;
const running: Entity[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-restore-"));
});

afterEach(async () => {
  for (const entity of running.splice(0)) await entity.stop().catch(() => undefined);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function startLar(dir: string): Promise<Entity> {
  const entity = await openEntity({
    dir,
    config: CONFIG,
    model: new ScriptedModel([]),
    worlds: [createCliWorld({ onSay: () => {} })],
  });
  running.push(entity);
  entity.river.append({ thread: "cli:summoner", kind: "event", source: "owner", place: "cli:summoner", text: "Hello.", atMs: T0 });
  entity.river.append({ thread: "cli:summoner", kind: "say", source: "self", place: "cli:summoner", text: "Hello back.", atMs: T0 + 60_000 });
  await entity.notebook.write("notes/first.md", "The first note.\n", "Write the first note", "body");
  await entity.notebook.write("notes/second.md", "The second note.\n", "Write the second note", "body");
  return entity;
}

function textsOf(dir: string): string[] {
  const river = openRiver(join(dir, "river.db"));
  try {
    return river.read({ limit: 1000 }).map((row) => `${row.seq}:${row.kind}:${row.text ?? ""}`);
  } finally {
    river.close();
  }
}

function headOf(notebook: string): string {
  return execFileSync("git", ["-C", notebook, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Backs up a live Lar (so the river is copied while it runs) and stops it. Returns the backup folder. */
async function backupOf(lar: string, name = "iris-20261011-103005"): Promise<string> {
  const entity = await startLar(lar);
  writeFileSync(join(lar, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  const out = join(root, "backups");
  const made = await backupEntity({ dir: lar, out, now: new Date(2026, 9, 11, 10, 30, 5), say: () => {} });
  await entity.stop();
  running.length = 0;
  expect(made.folder.endsWith(name)).toBe(true);
  return made.folder;
}

describe("natalis restore", () => {
  it("round trip: backup, restore, and the restored Lar starts with the same river and notebook", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    const originalHead = headOf(join(lar, "notebook"));
    const target = join(root, "restored", "iris");

    const log: string[] = [];
    const result = await restoreEntity({ from: backup, dir: target, say: (line) => log.push(line) });

    expect(result.dir).toBe(target);
    expect(textsOf(target)).toEqual(textsOf(lar));
    expect(headOf(join(target, "notebook"))).toBe(originalHead);
    expect(readFileSync(join(target, "notebook", "notes", "second.md"), "utf8")).toBe("The second note.\n");
    expect(execFileSync("git", ["-C", join(target, "notebook"), "remote"], { encoding: "utf8" }).trim()).toBe("");
    expect(existsSync(join(target, "state.json"))).toBe(true);
    expect(existsSync(join(target, "entity.json"))).toBe(true);
    expect(existsSync(join(target, BUNDLE_FILE))).toBe(false);
    expect(log.join("\n")).toContain("Checked 4 files");
    // Nothing is left beside the target but the target itself.
    expect(readdirSync(join(root, "restored"))).toEqual(["iris"]);

    const model = new ScriptedModel([]);
    const restored = await openEntity({
      dir: target,
      config: CONFIG,
      model,
      worlds: [createCliWorld({ onSay: () => {} })],
    });
    running.push(restored);
    expect(restored.river.lastSeq()).toBe(readRiverLastSeq(join(target, "river.db")));
    expect(restored.notebook.read("notes/first.md")).toBe("The first note.\n");
    await restored.start();
    await restored.stop();
    running.length = 0;
  }, 60_000);

  it("accepts an existing empty folder as the target", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    const target = join(root, "empty-target");
    mkdirSync(target);
    await restoreEntity({ from: backup, dir: target, say: () => {} });
    expect(textsOf(target)).toEqual(textsOf(lar));
  }, 60_000);

  it("refuses a target that is not empty, and changes nothing in it", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    const target = join(root, "busy");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "not mine to overwrite\n");
    await expect(restoreEntity({ from: backup, dir: target, say: () => {} })).rejects.toThrow(/not empty/);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
    expect(readdirSync(root).sort()).toEqual(["backups", "busy", "iris"]);
  }, 60_000);

  it("refuses a backup whose river was changed, and writes nothing", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    appendFileSync(join(backup, "river.db"), "x");
    const target = join(root, "restored", "iris");
    await expect(restoreEntity({ from: backup, dir: target, say: () => {} })).rejects.toThrow(/river.db does not match its manifest \(size\)/);
    expect(existsSync(join(root, "restored"))).toBe(false);
  }, 60_000);

  it("refuses a backup whose notebook bundle has the same size but another hash", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    const bundle = join(backup, BUNDLE_FILE);
    const bytes = readFileSync(bundle);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(bundle, bytes);
    const target = join(root, "restored", "iris");
    await expect(restoreEntity({ from: backup, dir: target, say: () => {} })).rejects.toThrow(/notebook.bundle does not match its manifest \(hash\)/);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("refuses a folder with no manifest", async () => {
    const empty = join(root, "not-a-backup");
    mkdirSync(empty);
    await expect(restoreEntity({ from: empty, dir: join(root, "t"), say: () => {} })).rejects.toThrow(/No MANIFEST.json|could not be read/);
  });

  it("refuses a manifest that lists a file with env in its name", async () => {
    const lar = join(root, "iris");
    const backup = await backupOf(lar);
    const manifestPath = join(backup, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    manifest.files.push({ name: "iris.env", bytes: 0, sha256: "0".repeat(64) });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const target = join(root, "restored", "iris");
    await expect(restoreEntity({ from: backup, dir: target, say: () => {} })).rejects.toThrow(/not allowed/);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("exits 2 without --from or --dir, and 1 when the restore is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await restoreCommand(["--from", join(root, "x")])).toBe(2);
    expect(await restoreCommand(["--dir", join(root, "y")])).toBe(2);
    expect(await restoreCommand(["--from", join(root, "x"), "--dir", join(root, "y")])).toBe(1);
  });
});
