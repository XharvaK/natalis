// B-1: the files/ folder swapped for a link after the checks must never send a file outside the home.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook: { path?: string; swap?: () => void } = {};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    realpathSync: Object.assign((path: fs.PathLike, options?: unknown) => {
      const out = (real.realpathSync as (p: fs.PathLike, o?: unknown) => string)(path, options);
      if (hook.swap && String(path) === hook.path) {
        const swap = hook.swap;
        hook.swap = undefined;
        swap();
      }
      return out;
    }, { native: real.realpathSync.native }),
  };
});

const { saveFile } = await import("./files.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "natalis-files-race-"));
  fs.mkdirSync(join(dir, "home", "files"), { recursive: true });
  fs.mkdirSync(join(dir, "outside"));
});
afterEach(() => {
  hook.swap = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const home = () => ({ dir: join(dir, "home"), shownAs: "/home/lar" });

describe("saveFile and a folder swapped after its checks (B-1)", () => {
  it("never writes outside the home when files/ becomes a link between the checks and the write", () => {
    hook.path = join(dir, "home");
    hook.swap = () => {
      fs.rmSync(join(dir, "home", "files"), { recursive: true });
      fs.symlinkSync(join(dir, "outside"), join(dir, "home", "files"));
    };
    try {
      saveFile(home(), "x.txt", new Uint8Array([1]));
    } catch {
      // Refusing is fine; writing outside is not.
    }
    expect(fs.readdirSync(join(dir, "outside"))).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("holds against a live loop that flips files/ between a folder and a link (5 s)", async () => {
    const files = join(dir, "home", "files");
    const flip = spawn("sh", ["-c", `while :; do rm -rf '${files}'; mkdir '${files}'; rm -rf '${files}'; ln -s '${join(dir, "outside")}' '${files}'; done`], { stdio: "ignore" });
    try {
      const end = Date.now() + 5000;
      while (Date.now() < end && fs.readdirSync(join(dir, "outside")).length === 0) {
        try {
          saveFile(home(), "x.txt", new Uint8Array([1]));
        } catch {
          // A refusal or a lost race is fine.
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      flip.kill("SIGKILL");
    }
    expect(fs.readdirSync(join(dir, "outside"))).toEqual([]);
  }, 15_000);
});
