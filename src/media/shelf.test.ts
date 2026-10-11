import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanPictureName,
  isPictureId,
  openShelf,
  PICTURE_BYTES_MAX,
  shelfBody,
  ShelfError,
  sniffPicture,
} from "./shelf.js";

const T0 = Date.UTC(2026, 9, 11, 9, 0, 0);
const FROM = { world: "discord", place: "discord:room:general" };

/** A tiny PNG built from bytes: the signature and a few more. */
function png(extra = 8): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: extra }, (_, i) => i)]);
}
function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}
function gif(): Uint8Array {
  return Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0]);
}
function webp(): Uint8Array {
  return Uint8Array.from([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), 1, 2]);
}

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-shelf-"));
  dir = join(root, "media");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("picture types by their bytes", () => {
  it("knows the four types we keep, and nothing else", () => {
    expect(sniffPicture(png())).toBe("image/png");
    expect(sniffPicture(jpeg())).toBe("image/jpeg");
    expect(sniffPicture(gif())).toBe("image/gif");
    expect(sniffPicture(webp())).toBe("image/webp");
    expect(sniffPicture(Buffer.from("<svg onload='x'/>"))).toBeUndefined();
    expect(sniffPicture(Buffer.from("GIF8xx"))).toBeUndefined();
    expect(sniffPicture(Buffer.from("RIFF0000WAVE"))).toBeUndefined();
    expect(sniffPicture(new Uint8Array())).toBeUndefined();
  });

  it("checks ids as the shelf makes them", () => {
    expect(isPictureId("m-ABCD2345")).toBe(true);
    expect(isPictureId("m-abcd2345")).toBe(false);
    expect(isPictureId("../m-ABCD2345")).toBe(false);
    expect(isPictureId("m-ABCD234")).toBe(false);
  });
});

describe("cleanPictureName", () => {
  it("keeps the name as one plain line and clips it", () => {
    expect(cleanPictureName("cat\nphoto\u0000.png")).toBe("cat photo .png");
    expect(cleanPictureName("   ")).toBe("picture");
    expect(cleanPictureName("x".repeat(300)).length).toBe(120);
  });
});

describe("the shelf", () => {
  it("keeps a picture as <id>.<ext> with a sidecar, and reads it back", () => {
    const shelf = openShelf(dir);
    const meta = shelf.keep({ bytes: png(), name: "cat.png", from: FROM, atMs: T0 });

    expect(isPictureId(meta.id)).toBe(true);
    expect(meta).toEqual({ id: meta.id, mime: "image/png", bytes: png().length, name: "cat.png", from: FROM, atMs: T0 });
    expect(readdirSync(dir).sort()).toEqual([`${meta.id}.json`, `${meta.id}.png`].sort());
    expect(shelf.get(meta.id)).toEqual(meta);
    expect(shelf.pathOf(meta.id)).toBe(join(dir, `${meta.id}.png`));
    expect(shelf.base64Of(meta.id)).toBe(Buffer.from(png()).toString("base64"));
  });

  it("names the file by the picture type, not by the name it was given", () => {
    const shelf = openShelf(dir);
    const meta = shelf.keep({ bytes: jpeg(), name: "../../escape.exe", from: FROM, atMs: T0 });
    expect(readdirSync(dir).filter((file) => file.startsWith(meta.id))).toEqual([`${meta.id}.jpg`, `${meta.id}.json`].sort());
    expect(meta.name).toBe("../../escape.exe");
    expect(existsSync(join(root, "escape.exe"))).toBe(false);
  });

  it("refuses what is not a picture and writes nothing", () => {
    const shelf = openShelf(dir);
    let caught: unknown;
    try {
      shelf.keep({ bytes: Buffer.from("<html>not a picture</html>"), name: "page.png", from: FROM, atMs: T0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShelfError);
    expect((caught as ShelfError).code).toBe("not_picture");
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a picture over the size cap", () => {
    const shelf = openShelf(dir);
    const big = new Uint8Array(PICTURE_BYTES_MAX + 1);
    big.set(png(0));
    expect(() => shelf.keep({ bytes: big, name: "big.png", from: FROM, atMs: T0 })).toThrow(/at most 8 MiB/);
    try {
      shelf.keep({ bytes: big, name: "big.png", from: FROM, atMs: T0 });
    } catch (err) {
      expect((err as ShelfError).code).toBe("too_large");
    }
    expect(shelf.summary()).toEqual({ count: 0, bytes: 0 });
  });

  it("lists the newest first, and sums the size for the board", () => {
    const shelf = openShelf(dir);
    const older = shelf.keep({ bytes: png(4), name: "a.png", from: FROM, atMs: T0 });
    const newer = shelf.keep({ bytes: jpeg(), name: "b.jpg", from: FROM, atMs: T0 + 1000 });
    expect(shelf.list().map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(shelf.summary()).toEqual({ count: 2, bytes: older.bytes + newer.bytes });
  });

  it("forgets one picture, both files, and says so when there was none", () => {
    const shelf = openShelf(dir);
    const keep = shelf.keep({ bytes: png(), name: "a.png", from: FROM, atMs: T0 });
    const other = shelf.keep({ bytes: gif(), name: "b.gif", from: FROM, atMs: T0 });
    expect(shelf.forget(keep.id)).toBe(true);
    expect(shelf.get(keep.id)).toBeUndefined();
    expect(existsSync(join(dir, `${keep.id}.png`))).toBe(false);
    expect(shelf.get(other.id)).toEqual(other);
    expect(shelf.forget(keep.id)).toBe(false);
    expect(shelf.forget("../etc")).toBe(false);
  });

  it("leaves out a picture whose file is missing or the wrong size", () => {
    const shelf = openShelf(dir);
    const gone = shelf.keep({ bytes: png(), name: "gone.png", from: FROM, atMs: T0 });
    const short = shelf.keep({ bytes: png(), name: "short.png", from: FROM, atMs: T0 + 1 });
    rmSync(join(dir, `${gone.id}.png`));
    writeFileSync(join(dir, `${short.id}.png`), "x");
    expect(shelf.list()).toEqual([]);
    expect(shelf.get(gone.id)).toBeUndefined();
    expect(shelf.pathOf(short.id)).toBeUndefined();
  });

  it("ignores a sidecar that is not what the shelf wrote", () => {
    const shelf = openShelf(dir);
    const meta = shelf.keep({ bytes: png(), name: "a.png", from: FROM, atMs: T0 });
    writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify({ ...meta, id: "m-AAAAAAAA" }));
    expect(shelf.get(meta.id)).toBeUndefined();
    writeFileSync(join(dir, "m-BBBBBBBB.json"), "not json");
    expect(shelf.list()).toEqual([]);
  });

  it("gives ids that never hold env, so a backup never leaves one out", () => {
    const shelf = openShelf(dir);
    const ids = new Set<string>();
    for (let i = 0; i < 60; i += 1) ids.add(shelf.keep({ bytes: png(i % 3), name: "x.png", from: FROM, atMs: T0 + i }).id);
    expect(ids.size).toBe(60);
    for (const id of ids) expect(id.toLowerCase()).not.toContain("env");
  });

  it("is what a world gets from the body: keepPicture stamps the Lar's clock", () => {
    const shelf = openShelf(dir);
    const body = shelfBody(shelf, () => T0 + 5);
    const ref = body.keepPicture({ bytes: png(), name: "from-chat.png", from: FROM });
    expect(ref).toEqual({ id: ref.id, mime: "image/png", bytes: png().length, name: "from-chat.png" });
    expect(shelf.get(ref.id)?.atMs).toBe(T0 + 5);
    expect(readFileSync(join(dir, `${ref.id}.png`))).toEqual(Buffer.from(png()));
  });
});
