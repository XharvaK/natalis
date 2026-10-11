import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSealableLar,
  isSafeRelativePath,
  openSealedBytes,
  pruneSealed,
  readSealKey,
  sealBytes,
  sealedPackageName,
  sealFolder,
  SEAL_MAGIC,
  type SealedEntry,
} from "./backup-seal.js";

const LAR = "iris";
const STAMP = "20261011-103005";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-seal-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const SAMPLE: SealedEntry[] = [
  { path: "river.db", content: randomBytes(3000) },
  { path: "notebook.bundle", content: Buffer.from("bundle\n\nwith newlines in it\n") },
  { path: "state.json", content: Buffer.from("{}\n") },
];

function sealSample(key: Buffer): Buffer {
  return sealBytes({ lar: LAR, stamp: STAMP, key, entries: SAMPLE });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds a package with the same layout but no checks on the names or hashes, so the opening side can be tested on
 * packages the sealing side would refuse to make. Only the test uses it.
 */
function craftPackage(
  key: Buffer,
  entries: { path: string; content: Buffer; sha256?: string }[],
  files = entries.length,
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const line = { path: entry.path, size: entry.content.length, sha256: entry.sha256 ?? sha256(entry.content) };
    parts.push(Buffer.from(`${JSON.stringify(line)}\n`, "utf8"), entry.content, Buffer.from("\n"));
  }
  const compressed = gzipSync(Buffer.concat(parts));
  const iv = randomBytes(12);
  const prefix = Buffer.from(
    `${SEAL_MAGIC}${JSON.stringify({ v: 1, lar: LAR, stamp: STAMP, alg: "aes-256-gcm", iv: iv.toString("hex"), files })}\n`,
    "utf8",
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(prefix);
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([prefix, body, cipher.getAuthTag()]);
}

describe("the sealing key", () => {
  it("reads 64 hex characters, in either case, as 32 bytes", () => {
    const hex = randomBytes(32).toString("hex");
    expect(readSealKey("K", { K: hex }).equals(Buffer.from(hex, "hex"))).toBe(true);
    expect(readSealKey("K", { K: hex.toUpperCase() }).length).toBe(32);
  });

  it("refuses any other format, and never shows the value", () => {
    const hex = randomBytes(32).toString("hex");
    const bad = ["", "ab", hex.slice(1), `${hex}0`, `${hex.slice(0, 63)}g`, ` ${hex}`, `${hex}\n`, `${hex} x`];
    for (const value of bad) {
      let message = "";
      try {
        readSealKey("K", { K: value });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, JSON.stringify(value)).toMatch(/exactly 64 hex characters/);
      expect(message).not.toContain(hex.slice(0, 20));
    }
  });

  it("says plainly when the variable is not set", () => {
    expect(() => readSealKey("NATALIS_NOT_SET_HERE", {})).toThrow(/NATALIS_NOT_SET_HERE is not set/);
  });

  it("refuses a Lar name that a package cannot carry", () => {
    expect(() => assertSealableLar("my lar")).toThrow(/cannot be sealed/);
    expect(() => assertSealableLar("../iris")).toThrow(/cannot be sealed/);
    expect(() => assertSealableLar("-iris")).toThrow(/cannot be sealed/);
    expect(() => assertSealableLar("iris_2-b")).not.toThrow();
    expect(sealedPackageName("iris", STAMP)).toBe("iris-20261011-103005.natalisbak");
  });
});

describe("the sealed package", () => {
  it("lays out the magic, one JSON header line and the files sorted by path", () => {
    const key = randomBytes(32);
    const bytes = sealSample(key);
    expect(bytes.subarray(0, SEAL_MAGIC.length).toString("ascii")).toBe("NATALIS1\n");
    const headerEnd = bytes.indexOf(0x0a, SEAL_MAGIC.length);
    const header = JSON.parse(bytes.subarray(SEAL_MAGIC.length, headerEnd).toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(header)).toEqual(["v", "lar", "stamp", "alg", "iv", "files"]);
    expect(header).toMatchObject({ v: 1, lar: LAR, stamp: STAMP, alg: "aes-256-gcm", files: 3 });
    expect(String(header["iv"])).toMatch(/^[0-9a-f]{24}$/);

    const opened = openSealedBytes(bytes, key);
    expect(opened.header.lar).toBe(LAR);
    expect(opened.entries.map((entry) => entry.path)).toEqual(["notebook.bundle", "river.db", "state.json"]);
    for (const entry of opened.entries) {
      const original = SAMPLE.find((item) => item.path === entry.path);
      expect(entry.content.equals(original?.content ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it("keeps the file contents out of the package in plain text", () => {
    const bytes = sealSample(randomBytes(32));
    expect(bytes.includes(Buffer.from("with newlines in it"))).toBe(false);
  });

  it("uses a fresh IV for every package, so the same files seal differently", () => {
    const key = randomBytes(32);
    const first = sealSample(key);
    const second = sealSample(key);
    expect(first.equals(second)).toBe(false);
    expect(openSealedBytes(second, key).entries.length).toBe(3);
  });

  it("opens an empty folder as an empty package", () => {
    const key = randomBytes(32);
    const bytes = sealBytes({ lar: LAR, stamp: STAMP, key, entries: [] });
    expect(openSealedBytes(bytes, key).entries).toEqual([]);
  });

  it("refuses the wrong key", () => {
    expect(() => openSealedBytes(sealSample(randomBytes(32)), randomBytes(32))).toThrow(/did not open/);
  });

  it("refuses a flipped byte in the magic, the header, the ciphertext or the tag", () => {
    const key = randomBytes(32);
    const bytes = sealSample(key);
    const headerEnd = bytes.indexOf(0x0a, SEAL_MAGIC.length);
    const positions: number[] = [];
    for (let at = 0; at <= headerEnd; at += 1) positions.push(at);
    const bodyStart = headerEnd + 1;
    const bodyLength = bytes.length - 16 - bodyStart;
    for (let k = 0; k < 40; k += 1) positions.push(bodyStart + Math.floor((k * bodyLength) / 40));
    for (let at = bytes.length - 16; at < bytes.length; at += 1) positions.push(at);
    for (const at of positions) {
      const copy = Buffer.from(bytes);
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      expect(() => openSealedBytes(copy, key), `flipped byte ${at}`).toThrow();
    }
  });

  it("refuses a package that was cut short", () => {
    const key = randomBytes(32);
    const bytes = sealSample(key);
    expect(() => openSealedBytes(bytes.subarray(0, bytes.length - 1), key)).toThrow();
    expect(() => openSealedBytes(bytes.subarray(0, 20), key)).toThrow();
  });

  it("refuses a file that is not a sealed package", () => {
    expect(() => openSealedBytes(Buffer.from("PK\u0003\u0004 some zip file that is not ours at all"), randomBytes(32))).toThrow(
      /not a sealed Natalis package/,
    );
  });

  it("opens a well-formed hand-made package, so the refusals below are about the one thing they test", () => {
    const key = randomBytes(32);
    const made = craftPackage(key, [{ path: "a/b.txt", content: Buffer.from("ok\n") }]);
    expect(openSealedBytes(made, key).entries[0]?.path).toBe("a/b.txt");
  });

  it("refuses unsafe names when sealing", () => {
    const key = randomBytes(32);
    for (const path of ["../x", "/abs", "a\\b", "C:/x", "C:x", "a//b", "a/./b", "a/../b", "./x", ""]) {
      expect(() => sealBytes({ lar: LAR, stamp: STAMP, key, entries: [{ path, content: Buffer.from("x") }] }), path).toThrow(
        /not a safe file name/,
      );
    }
  });

  it("refuses unsafe names when opening, even under a valid tag", () => {
    const key = randomBytes(32);
    for (const path of ["../evil.txt", "/abs.txt", "a\\b.txt", "C:/evil.txt", "a//b.txt", "a/../../b.txt", "./c.txt"]) {
      const made = craftPackage(key, [{ path, content: Buffer.from("x") }]);
      expect(() => openSealedBytes(made, key), path).toThrow(/not safe/);
    }
  });

  it("refuses a package whose header count or file hash does not match its archive", () => {
    const key = randomBytes(32);
    const content = Buffer.from("hello\n");
    expect(() => openSealedBytes(craftPackage(key, [{ path: "a.txt", content }], 2), key)).toThrow(/header says 2/);
    expect(() => openSealedBytes(craftPackage(key, [{ path: "a.txt", content, sha256: "0".repeat(64) }]), key)).toThrow(
      /does not match its hash/,
    );
    expect(() =>
      openSealedBytes(
        craftPackage(key, [
          { path: "a.txt", content },
          { path: "a.txt", content },
        ]),
        key,
      ),
    ).toThrow(/listed twice/);
  });

  it("checks the path rule on its own", () => {
    expect(isSafeRelativePath("MANIFEST.json")).toBe(true);
    expect(isSafeRelativePath("notebook/notes/a.md")).toBe(true);
    expect(isSafeRelativePath("..a")).toBe(true);
    expect(isSafeRelativePath("a/..b")).toBe(true);
    expect(isSafeRelativePath("../a")).toBe(false);
    expect(isSafeRelativePath("a/..")).toBe(false);
  });
});

describe("sealing a folder and pruning sealed packages", () => {
  it("seals a folder with a subfolder into one checked package, and leaves no partial file", () => {
    const folder = join(root, "iris-20261011-103005");
    mkdirSync(join(folder, "notes"), { recursive: true });
    writeFileSync(join(folder, "river.db"), randomBytes(500));
    writeFileSync(join(folder, "notes", "a.md"), "A note.\n");
    writeFileSync(join(folder, "MANIFEST.json"), "{}\n");
    const key = randomBytes(32);
    const out = join(root, "sealed");
    const lines: string[] = [];

    const result = sealFolder({ folder, lar: LAR, stamp: STAMP, key, out, say: (line) => lines.push(line) });

    expect(readdirSync(out)).toEqual(["iris-20261011-103005.natalisbak"]);
    expect(result.files).toBe(3);
    expect(result.removed).toEqual([]);
    const opened = openSealedBytes(readFileSync(result.file), key);
    expect(opened.entries.map((entry) => entry.path)).toEqual(["MANIFEST.json", "notes/a.md", "river.db"]);
    expect(lines.join("\n")).toContain("tag ok, 3 file hashes ok");
    expect(lines.join("\n")).not.toContain(key.toString("hex"));
  });

  it("refuses to seal over an existing package of the same name", () => {
    const folder = join(root, "iris-20261011-103005");
    mkdirSync(folder);
    writeFileSync(join(folder, "river.db"), "x");
    const out = join(root, "sealed");
    const key = randomBytes(32);
    const once = sealFolder({ folder, lar: LAR, stamp: STAMP, key, out, say: () => {} });
    expect(() => sealFolder({ folder, lar: LAR, stamp: STAMP, key, out, say: () => {} })).toThrow(/already exists/);
    expect(readdirSync(out)).toEqual([sealedPackageName(LAR, STAMP)]);
    expect(once.file.endsWith(sealedPackageName(LAR, STAMP))).toBe(true);
  });

  it("prunes the oldest packages of this Lar and touches only names exactly like its own", () => {
    const out = join(root, "sealed");
    mkdirSync(out);
    for (const second of ["100001", "100002", "100003", "100004"]) {
      writeFileSync(join(out, sealedPackageName(LAR, `20261011-${second}`)), "x");
    }
    for (const name of [
      "iris-notes.natalisbak",
      "iris-2026-100000.natalisbak",
      "iris-20261011-100000.natalisbak.partial",
      "lar-20261011-100000.natalisbak",
      "iris-20261011-100000.natalisbak.bak",
    ]) {
      writeFileSync(join(out, name), "x");
    }
    const lines: string[] = [];

    const removed = pruneSealed(out, LAR, 2, (line) => lines.push(line));

    expect(removed).toEqual(["iris-20261011-100001.natalisbak", "iris-20261011-100002.natalisbak"]);
    expect(lines).toContain("Removed old sealed package iris-20261011-100001.natalisbak.");
    expect(readdirSync(out).sort()).toEqual(
      [
        "iris-20261011-100003.natalisbak",
        "iris-20261011-100004.natalisbak",
        "iris-notes.natalisbak",
        "iris-2026-100000.natalisbak",
        "iris-20261011-100000.natalisbak.partial",
        "lar-20261011-100000.natalisbak",
        "iris-20261011-100000.natalisbak.bak",
      ].sort(),
    );
  });
});
