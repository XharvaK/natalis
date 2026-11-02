import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContacts } from "../entity/contacts.js";
import { writeFileAtomic, type AtomicFs } from "./write-atomic.js";
import * as realFs from "node:fs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-atomic-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeFileAtomic (NB-B, NOTE-1)", () => {
  it("writes the whole file, 0600 by default, and leaves no temporary file", () => {
    const path = join(dir, "state.json");
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("keeps a mode it is given", () => {
    const path = join(dir, "picture.png");
    writeFileAtomic(path, new Uint8Array([1, 2]), { mode: 0o640 });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("syncs the file before the rename and the folder after it", () => {
    const calls: string[] = [];
    const fs: AtomicFs = {
      ...realFs,
      fsyncSync: (fd) => {
        calls.push(`fsync:${realFs.fstatSync(fd).isDirectory() ? "dir" : "file"}`);
        realFs.fsyncSync(fd);
      },
      renameSync: (from, to) => {
        calls.push("rename");
        realFs.renameSync(from, to);
      },
    };
    writeFileAtomic(join(dir, "a.json"), "x", { fs });
    expect(calls).toEqual(["fsync:file", "rename", "fsync:dir"]);
  });

  it("uses a new temporary name each time, so two writers never share one", () => {
    const names = new Set<string>();
    const fs: AtomicFs = { ...realFs, renameSync: (from, to) => { names.add(String(from)); realFs.renameSync(from, to); } };
    for (let i = 0; i < 20; i++) writeFileAtomic(join(dir, "a.json"), String(i), { fs });
    expect(names.size).toBe(20);
  });
});

describe("a planted <file>.tmp link is never followed (NOTE-1)", () => {
  it("writeContacts does not write through contacts.json.tmp", () => {
    mkdirSync(join(dir, "outside"));
    const target = join(dir, "outside", "victim");
    writeFileSync(target, "untouched");
    const path = join(dir, "contacts.json");
    symlinkSync(target, `${path}.tmp`);
    writeContacts(path, { version: 1, discord: ["1"] });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, discord: ["1"] });
  });
});
