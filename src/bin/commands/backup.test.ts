import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityConfig } from "../../entity/config.js";
import { openEntity, type Entity } from "../../entity/runtime.js";
import { createCliWorld } from "../../worlds/cli.js";
import { ScriptedModel } from "../../testing/scripted-model.js";
import { BUNDLE_FILE, MANIFEST_FILE, readRiverLastSeq, sha256File, type Manifest } from "./backup-format.js";
import { backupCommand, backupEntity, parseKeep } from "./backup.js";

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
  root = mkdtempSync(join(tmpdir(), "natalis-backup-"));
});

afterEach(async () => {
  for (const entity of running.splice(0)) await entity.stop().catch(() => undefined);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A Lar folder as a real one looks after its first start: a few rows, a state file and a notebook with commits. */
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
  return entity;
}

function quiet(): { say: string[] } {
  return { say: [] };
}

describe("natalis backup", () => {
  it("backs up a running Lar into one dated folder, checked, with no env or stop file in it", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    writeFileSync(join(lar, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
    writeFileSync(join(lar, "discord.json"), `${JSON.stringify({ tokenEnv: "IRIS_BOT_TOKEN", ownerUserId: "1234", rooms: [] })}\n`);
    writeFileSync(join(lar, "iris.env"), "IRIS_MODEL_KEY=not-a-real-key\n");
    writeFileSync(join(lar, "STOP"), "on\n");
    const seqBefore = entity.river.lastSeq();
    const log = quiet();
    const out = join(root, "backups");

    const result = await backupEntity({ dir: lar, out, now: new Date(2026, 9, 11, 10, 30, 5), say: (line) => log.say.push(line) });

    expect(basename(result.folder)).toBe("iris-20261011-103005");
    expect(readdirSync(out)).toEqual(["iris-20261011-103005"]);
    const names = readdirSync(result.folder).sort();
    expect(names).toEqual(["MANIFEST.json", "discord.json", "entity.json", "notebook.bundle", "river.db", "state.json"]);
    expect(names.some((name) => name.toLowerCase().includes("env"))).toBe(false);
    expect(names).not.toContain("STOP");

    const manifest = JSON.parse(readFileSync(join(result.folder, MANIFEST_FILE), "utf8")) as Manifest;
    expect(manifest.format).toBe("natalis-backup");
    expect(manifest.entity).toBe("iris");
    expect(manifest.createdAt).toBe(result.manifest.createdAt);
    expect(manifest.riverLastSeq).toBe(seqBefore);
    expect(readRiverLastSeq(join(result.folder, "river.db"))).toBe(seqBefore);
    expect(manifest.notebookHead).toMatch(/^[0-9a-f]{40}$/);
    for (const file of manifest.files) {
      const path = join(result.folder, file.name);
      expect(file.bytes).toBe(readFileSync(path).length);
      expect(file.sha256).toBe(sha256File(path));
    }
    expect(log.say.join("\n")).toContain("Backup is ready");
    expect(log.say.join("\n")).toContain("git bundle verify");
  }, 60_000);

  it("the notebook bundle carries the notebook's commits", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    const out = join(root, "backups");
    const result = await backupEntity({ dir: lar, out, say: () => {} });
    const bundle = join(result.folder, BUNDLE_FILE);
    execFileSync("git", ["bundle", "verify", bundle], { stdio: "ignore" });
    const heads = execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" });
    expect(heads).toContain(result.manifest.notebookHead);
    expect(entity.notebook.read("notes/first.md")).toBe("The first note.\n");
  }, 60_000);

  it("keeps the newest backups of this Lar and removes only folders named like its backups", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    await entity.stop();
    running.length = 0;
    const out = join(root, "backups");
    mkdirSync(out, { recursive: true });
    mkdirSync(join(out, "iris-notes"));
    mkdirSync(join(out, "iris-2026-old"));
    mkdirSync(join(out, "lar-20261011-100001"));

    const removedLog: string[] = [];
    for (const second of [1, 2, 3]) {
      const made = await backupEntity({
        dir: lar,
        out,
        keep: 2,
        now: new Date(2026, 9, 11, 10, 0, second),
        say: (line) => removedLog.push(line),
      });
      expect(made.folder).toContain(`iris-20261011-10000${second}`);
    }

    expect(readdirSync(out).sort()).toEqual(
      ["iris-20261011-100002", "iris-20261011-100003", "iris-2026-old", "iris-notes", "lar-20261011-100001"].sort(),
    );
    expect(removedLog).toContain("Removed old backup iris-20261011-100001.");
  }, 60_000);

  it("refuses a folder that is not a Lar, and writes nothing", async () => {
    const empty = join(root, "not-a-lar");
    mkdirSync(empty);
    const out = join(root, "backups");
    await expect(backupEntity({ dir: empty, out, say: () => {} })).rejects.toThrow(/No river.db/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a Lar folder with a river but no notebook", async () => {
    const lar = join(root, "iris");
    mkdirSync(lar);
    const db = new DatabaseSync(join(lar, "river.db"));
    db.exec("CREATE TABLE rows (seq INTEGER PRIMARY KEY)");
    db.close();
    await expect(backupEntity({ dir: lar, out: join(root, "backups"), say: () => {} })).rejects.toThrow(/No notebook/);
  });

  it("leaves no half-written folder when a step fails", async () => {
    const lar = join(root, "iris");
    mkdirSync(lar);
    execFileSync("git", ["init", "--quiet", join(lar, "notebook")]);
    const db = new DatabaseSync(join(lar, "river.db"));
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();
    const out = join(root, "backups");
    await expect(backupEntity({ dir: lar, out, say: () => {} })).rejects.toThrow(/not a readable Natalis river/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses a Lar whose notebook has no commit yet", async () => {
    const lar = join(root, "iris");
    mkdirSync(lar);
    execFileSync("git", ["init", "--quiet", join(lar, "notebook")]);
    const db = new DatabaseSync(join(lar, "river.db"));
    db.exec("CREATE TABLE rows (seq INTEGER PRIMARY KEY)");
    db.close();
    const out = join(root, "backups");
    await expect(backupEntity({ dir: lar, out, say: () => {} })).rejects.toThrow(/no commits yet/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("never overwrites a backup that already has the same name", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    await entity.stop();
    running.length = 0;
    const out = join(root, "backups");
    const now = new Date(2026, 9, 11, 11, 0, 0);
    await backupEntity({ dir: lar, out, now, say: () => {} });
    await expect(backupEntity({ dir: lar, out, now, say: () => {} })).rejects.toThrow(/already exists/);
  }, 60_000);

  it("parses --keep as a whole number of 1 or more", () => {
    expect(parseKeep(undefined)).toBeUndefined();
    expect(parseKeep("14")).toBe(14);
    expect(() => parseKeep("0")).toThrow(/whole number/);
    expect(() => parseKeep("-2")).toThrow(/whole number/);
    expect(() => parseKeep("two")).toThrow(/whole number/);
  });

  it("exits 2 on a usage mistake and 1 when the backup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lar = join(root, "iris");
    mkdirSync(lar);
    const out = join(root, "backups");
    expect(await backupCommand(["--dir", lar])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--keep", "0"])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--bogus"])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out])).toBe(1);
  });
});
