// NB-A: an entry swapped for a link while the backup walks the home never brings a host file into the backup.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook: { swap?: () => void } = {};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readdirSync: ((...args: Parameters<typeof real.readdirSync>) => {
      const out = real.readdirSync(...args);
      if (hook.swap) {
        const swap = hook.swap;
        hook.swap = undefined;
        swap();
      }
      return out;
    }) as typeof real.readdirSync,
  };
});

const { copyTree } = await import("./backup.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "natalis-backup-race-"));
  fs.mkdirSync(join(dir, "lar", "home", "sub"), { recursive: true });
  fs.writeFileSync(join(dir, "lar", "home", "f.txt"), "mine");
  fs.writeFileSync(join(dir, "lar", "home", "sub", "g.txt"), "mine too");
  fs.mkdirSync(join(dir, "outside"));
  fs.writeFileSync(join(dir, "outside", "secret.txt"), "HOST SECRET");
  fs.mkdirSync(join(dir, "partial"));
});
afterEach(() => {
  hook.swap = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function everythingIn(root: string): string {
  let text = "";
  const walk = (path: string): void => {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) text += fs.readFileSync(child, "utf8");
    }
  };
  walk(root);
  return text;
}

describe("copyTree and entries swapped mid-walk (NB-A)", () => {
  it("leaves out a file that became a link after the folder was listed", () => {
    hook.swap = () => {
      fs.rmSync(join(dir, "lar", "home", "f.txt"));
      fs.symlinkSync(join(dir, "outside", "secret.txt"), join(dir, "lar", "home", "f.txt"));
    };
    const copied = copyTree(join(dir, "lar"), join(dir, "partial"), "home", () => true);
    expect(everythingIn(join(dir, "partial"))).not.toContain("HOST SECRET");
    expect(copied).not.toContain("home/f.txt");
    expect(copied).toContain("home/sub/g.txt");
  });

  it("does not walk into a folder that became a link after the folder was listed", () => {
    hook.swap = () => {
      fs.rmSync(join(dir, "lar", "home", "sub"), { recursive: true });
      fs.symlinkSync(join(dir, "outside"), join(dir, "lar", "home", "sub"));
    };
    copyTree(join(dir, "lar"), join(dir, "partial"), "home", () => true);
    expect(everythingIn(join(dir, "partial"))).not.toContain("HOST SECRET");
  });
});
