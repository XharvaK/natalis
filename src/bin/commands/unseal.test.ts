import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityConfig } from "../../entity/config.js";
import { openEntity, type Entity } from "../../entity/runtime.js";
import { openRiver } from "../../river/index.js";
import { ScriptedModel } from "../../testing/scripted-model.js";
import { createCliWorld } from "../../worlds/cli.js";
import { backupCommand, backupEntity } from "./backup.js";
import { restoreEntity } from "./restore.js";
import { unsealCommand, unsealEntity } from "./unseal.js";

const T0 = Date.UTC(2026, 9, 11, 9, 0, 0);
const CONFIG: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", contextTokens: 32_000 },
  ceiling: { maxModelCalls: 10, maxToolCalls: 20 },
  owner: { alias: "summoner" },
};
const KEY_NAME = "NATALIS_SEAL_TEST_KEY";

let root: string;
const running: Entity[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-unseal-"));
});

afterEach(async () => {
  for (const entity of running.splice(0)) await entity.stop().catch(() => undefined);
  vi.restoreAllMocks();
  delete process.env[KEY_NAME];
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

/** A live Lar, backed up and sealed into `sealDir`, then stopped. */
async function sealedLar(lar: string, key: Buffer, sealDir: string, now = new Date(2026, 9, 11, 10, 30, 5)) {
  const entity = await startLar(lar);
  writeFileSync(join(lar, "entity.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
  const made = await backupEntity({ dir: lar, out: join(root, "backups"), now, seal: { dir: sealDir, key }, say: () => {} });
  await entity.stop();
  running.length = 0;
  if (made.sealed === undefined) throw new Error("the backup was not sealed");
  return { made, packageFile: made.sealed.file };
}

describe("natalis backup --seal-to and natalis unseal", () => {
  it("round trip: backup, seal, unseal, restore; the restored Lar has the same river rows and notebook HEAD", async () => {
    const lar = join(root, "iris");
    const key = randomBytes(32);
    const sealDir = join(root, "sealed");
    const { made, packageFile } = await sealedLar(lar, key, sealDir);

    expect(readdirSync(sealDir)).toEqual(["iris-20261011-103005.natalisbak"]);
    expect(readFileSync(packageFile).includes(Buffer.from("The first note."))).toBe(false);

    const unsealed = join(root, "unsealed", "iris");
    const unsealLog: string[] = [];
    const opened = unsealEntity({ from: packageFile, to: unsealed, key, say: (line) => unsealLog.push(line) });
    expect(opened).toMatchObject({ lar: "iris", stamp: "20261011-103005" });
    expect(opened.files).toBe(made.manifest.files.length + 1);
    expect(readdirSync(unsealed).sort()).toEqual(readdirSync(made.folder).sort());
    for (const name of readdirSync(made.folder)) {
      expect(readFileSync(join(unsealed, name)).equals(readFileSync(join(made.folder, name)))).toBe(true);
    }
    expect(unsealLog.join("\n")).toContain("Checked the folder against its manifest");
    expect(readdirSync(join(root, "unsealed"))).toEqual(["iris"]);

    const target = join(root, "restored", "iris");
    await restoreEntity({ from: unsealed, dir: target, say: () => {} });
    expect(textsOf(target)).toEqual(textsOf(lar));
    expect(headOf(join(target, "notebook"))).toBe(made.manifest.notebookHead);
    expect(headOf(join(target, "notebook"))).toBe(headOf(join(lar, "notebook")));
    expect(readFileSync(join(target, "notebook", "notes", "first.md"), "utf8")).toBe("The first note.\n");
  }, 60_000);

  it("a wrong key writes nothing, not even the folder", async () => {
    const lar = join(root, "iris");
    const key = randomBytes(32);
    const { packageFile } = await sealedLar(lar, key, join(root, "sealed"));
    const parent = join(root, "unsealed");
    mkdirSync(parent);

    expect(() => unsealEntity({ from: packageFile, to: join(parent, "iris"), key: randomBytes(32), say: () => {} })).toThrow(
      /did not open.*Nothing was written/,
    );
    expect(readdirSync(parent)).toEqual([]);
    expect(existsSync(join(parent, "iris"))).toBe(false);
  }, 60_000);

  it("a damaged package on disk is refused and writes nothing, whichever part is damaged", async () => {
    const lar = join(root, "iris");
    const key = randomBytes(32);
    const { packageFile } = await sealedLar(lar, key, join(root, "sealed"));
    const original = readFileSync(packageFile);
    const headerEnd = original.indexOf(0x0a, 9);
    for (const at of [12, headerEnd - 3, headerEnd + 10, original.length - 5, original.length - 1]) {
      const damaged = Buffer.from(original);
      damaged[at] = (damaged[at] ?? 0) ^ 0x10;
      const file = join(root, `damaged-${at}.natalisbak`);
      writeFileSync(file, damaged);
      const target = join(root, "unsealed", "iris");
      expect(() => unsealEntity({ from: file, to: target, key, say: () => {} }), `byte ${at}`).toThrow(/Nothing was written/);
      expect(existsSync(join(root, "unsealed"))).toBe(false);
    }
  }, 60_000);

  it("the target must be missing or empty, and a busy folder is left as it was", async () => {
    const lar = join(root, "iris");
    const key = randomBytes(32);
    const { packageFile } = await sealedLar(lar, key, join(root, "sealed"));

    const empty = join(root, "empty");
    mkdirSync(empty);
    unsealEntity({ from: packageFile, to: empty, key, say: () => {} });
    expect(readdirSync(empty)).toContain("river.db");

    const busy = join(root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "not mine\n");
    expect(() => unsealEntity({ from: packageFile, to: busy, key, say: () => {} })).toThrow(/not empty/);
    expect(readdirSync(busy)).toEqual(["keep.txt"]);
  }, 60_000);

  it("keeps the newest sealed packages of this Lar with --seal-keep, and removes the rest", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    await entity.stop();
    running.length = 0;
    const key = randomBytes(32);
    const sealDir = join(root, "sealed");
    const removedLog: string[] = [];
    for (const second of [1, 2, 3]) {
      await backupEntity({
        dir: lar,
        out: join(root, "backups"),
        now: new Date(2026, 9, 11, 10, 0, second),
        seal: { dir: sealDir, key, keep: 2 },
        say: (line) => removedLog.push(line),
      });
    }
    expect(readdirSync(sealDir).sort()).toEqual(["iris-20261011-100002.natalisbak", "iris-20261011-100003.natalisbak"]);
    expect(removedLog).toContain("Removed old sealed package iris-20261011-100001.natalisbak.");
  }, 60_000);

  it("refuses a Lar folder name a package cannot carry, before anything is written", async () => {
    const lar = join(root, "my lar");
    const entity = await startLar(lar);
    await entity.stop();
    running.length = 0;
    const out = join(root, "backups");
    await expect(
      backupEntity({ dir: lar, out, seal: { dir: join(root, "sealed"), key: randomBytes(32) }, say: () => {} }),
    ).rejects.toThrow(/cannot be sealed/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(root, "sealed"))).toBe(false);
  }, 60_000);

  it("the key never appears in what the backup command prints", async () => {
    const lar = join(root, "iris");
    const entity = await startLar(lar);
    await entity.stop();
    running.length = 0;
    const hex = randomBytes(32).toString("hex");
    process.env[KEY_NAME] = hex;
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => printed.push(args.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => printed.push(args.map(String).join(" ")));

    const code = await backupCommand([
      "--dir", lar, "--out", join(root, "backups"), "--seal-to", join(root, "sealed"), "--key-env", KEY_NAME,
    ]);

    expect(code).toBe(0);
    const text = printed.join("\n");
    expect(text).toContain("Checked the package: opened with the key, tag ok");
    expect(text).toContain("Sealed package is ready");
    expect(text).not.toContain(hex);
    expect(text).not.toContain(hex.toUpperCase());
    expect(text).not.toContain(hex.slice(0, 16));
  }, 60_000);

  it("exits 2 on a flag mix-up and 1 on a key the environment does not give, before any backup is made", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const lar = join(root, "iris");
    mkdirSync(lar);
    const out = join(root, "backups");
    const sealDir = join(root, "sealed");
    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-to", sealDir])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--key-env", KEY_NAME])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-keep", "2"])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-to", sealDir, "--key-env", "1BAD"])).toBe(2);
    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-to", sealDir, "--key-env", KEY_NAME, "--seal-keep", "0"])).toBe(2);
    expect(existsSync(out)).toBe(false);

    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-to", sealDir, "--key-env", KEY_NAME])).toBe(1);
    expect(existsSync(sealDir)).toBe(false);
    expect(existsSync(out)).toBe(false);

    const badValue = "not-a-key-value-XYZ";
    process.env[KEY_NAME] = badValue;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.map(String).join(" ")));
    expect(await backupCommand(["--dir", lar, "--out", out, "--seal-to", sealDir, "--key-env", KEY_NAME])).toBe(1);
    expect(errors.join("\n")).toContain("exactly 64 hex characters");
    expect(errors.join("\n")).not.toContain(badValue);
    expect(existsSync(out)).toBe(false);
  });

  it("exits 2 on unseal usage mistakes, 1 on a wrong key, and 0 on a good unseal", async () => {
    const lar = join(root, "iris");
    const key = randomBytes(32);
    const { packageFile } = await sealedLar(lar, key, join(root, "sealed"));
    const to = join(root, "unsealed", "iris");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await unsealCommand(["--from", packageFile, "--key-env", KEY_NAME])).toBe(2);
    expect(await unsealCommand(["--from", packageFile, "--to", to, "--key-env", "not a name"])).toBe(2);
    expect(await unsealCommand(["--from", packageFile, "--to", to, "--bogus"])).toBe(2);

    process.env[KEY_NAME] = randomBytes(32).toString("hex");
    expect(await unsealCommand(["--from", packageFile, "--to", to, "--key-env", KEY_NAME])).toBe(1);
    expect(existsSync(join(root, "unsealed"))).toBe(false);

    process.env[KEY_NAME] = key.toString("hex");
    expect(await unsealCommand(["--from", packageFile, "--to", to, "--key-env", KEY_NAME])).toBe(0);
    expect(existsSync(join(to, "MANIFEST.json"))).toBe(true);
  }, 60_000);
});
