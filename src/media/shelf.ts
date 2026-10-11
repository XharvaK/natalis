// The shelf: the pictures the Lar keeps, in `<entity>/media/`. Each picture is `<id>.<ext>` with a sidecar `<id>.json`
// that says what it is and where it came from. The body checks what a picture is by its bytes (never by its name or
// the type a platform claims), caps its size, and never prunes anything by itself. The summoner can forget one.
//
// The file name on disk is always the id and the extension; the original name is kept as data only, in the sidecar.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorldBody } from "../contracts.js";

export const MEDIA_FOLDER = "media";
/** A picture is at most this large. */
export const PICTURE_BYTES_MAX = 8 * 1024 * 1024;
/** Names are clipped to this many characters. */
const NAME_MAX = 120;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ID_PATTERN = /^m-[A-Z2-7]{8}$/;

export type PictureMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type PictureFrom = { world: string; place: string };
export type PictureMeta = {
  id: string;
  mime: PictureMime;
  bytes: number;
  name: string;
  from: PictureFrom;
  atMs: number;
};

const EXTENSION: Readonly<Record<PictureMime, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type ShelfErrorCode = "not_picture" | "too_large";

/** A picture the shelf refuses to keep, with a plain reason in its message. */
export class ShelfError extends Error {
  constructor(
    message: string,
    readonly code: ShelfErrorCode,
  ) {
    super(message);
    this.name = "ShelfError";
  }
}

export interface Shelf {
  /** The folder the pictures live in. */
  readonly dir: string;
  /** Keeps one picture. Throws ShelfError when it is not a picture we keep or is too large. */
  keep(input: { bytes: Uint8Array; name: string; from: PictureFrom; atMs: number }): PictureMeta;
  /** Every picture on the shelf, newest first. Pictures whose files do not check out are left out. */
  list(): PictureMeta[];
  get(id: string): PictureMeta | undefined;
  /** The file on disk for a picture, for a world to send. Undefined when there is no such picture. */
  pathOf(id: string): string | undefined;
  /** The picture's bytes as base64, for the model. Undefined when there is no such picture. */
  base64Of(id: string): string | undefined;
  /** Removes one picture (both files). False when there was no such picture. */
  forget(id: string): boolean;
  summary(): { count: number; bytes: number };
}

/** The picture's type by its bytes, or undefined when the bytes are not one of the four types we keep. */
export function sniffPicture(bytes: Uint8Array): PictureMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

/** True for an id as the shelf makes them: "m-" and eight base32 characters. */
export function isPictureId(text: string): boolean {
  return ID_PATTERN.test(text);
}

/** A name as data: one line, no control characters, clipped. An empty name becomes "picture". */
export function cleanPictureName(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  const clipped = chars.length <= NAME_MAX ? line : chars.slice(0, NAME_MAX - 3).join("") + "...";
  return clipped === "" ? "picture" : clipped;
}

/** Opens the shelf in a Lar's folder. Nothing is created until a picture is kept. */
export function openShelf(dir: string): Shelf {
  const lookup = (id: string): PictureMeta | undefined => (isPictureId(id) ? readMeta(dir, id) : undefined);
  const shelf: Shelf = {
    dir,

    keep(input) {
      if (input.bytes.length > PICTURE_BYTES_MAX) {
        throw new ShelfError(`A picture can be at most ${PICTURE_BYTES_MAX / (1024 * 1024)} MiB.`, "too_large");
      }
      const mime = sniffPicture(input.bytes);
      if (mime === undefined) {
        throw new ShelfError("Only PNG, JPEG, GIF and WebP pictures can be kept.", "not_picture");
      }
      mkdirSync(dir, { recursive: true });
      const id = freshId(dir);
      const meta: PictureMeta = {
        id,
        mime,
        bytes: input.bytes.length,
        name: cleanPictureName(input.name),
        from: { world: input.from.world, place: input.from.place.slice(0, 200) },
        atMs: input.atMs,
      };
      writeFileSync(join(dir, fileName(meta)), input.bytes);
      writeSidecar(dir, meta);
      return meta;
    },

    list() {
      if (!existsSync(dir)) return [];
      const found: PictureMeta[] = [];
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        const meta = readMeta(dir, entry.slice(0, -".json".length));
        if (meta !== undefined) found.push(meta);
      }
      return found.sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? 1 : -1));
    },

    get(id) {
      return lookup(id);
    },

    pathOf(id) {
      const meta = lookup(id);
      return meta === undefined ? undefined : join(dir, fileName(meta));
    },

    base64Of(id) {
      const path = shelf.pathOf(id);
      return path === undefined ? undefined : readFileSync(path).toString("base64");
    },

    forget(id) {
      const meta = lookup(id);
      if (meta === undefined) return false;
      rmSync(join(dir, fileName(meta)), { force: true });
      rmSync(join(dir, `${id}.json`), { force: true });
      return true;
    },

    summary() {
      const pictures = shelf.list();
      return { count: pictures.length, bytes: pictures.reduce((sum, item) => sum + item.bytes, 0) };
    },
  };
  return shelf;
}

/**
 * The body's way for worlds to keep a picture: the shelf, with the clock of the Lar. `outward` is the body's check of
 * outward words; without one every outward check holds, so a body that was not given the privacy list sends nothing.
 */
export function shelfBody(
  shelf: Shelf,
  nowMs: () => number,
  outward: WorldBody["outwardHold"] = () => ({ kind: "unreadable", problem: "no privacy check is wired" }),
): WorldBody {
  return {
    keepPicture(input) {
      const meta = shelf.keep({ bytes: input.bytes, name: input.name, from: input.from, atMs: nowMs() });
      return { id: meta.id, mime: meta.mime, bytes: meta.bytes, name: meta.name };
    },
    outwardHold: outward,
  };
}

function fileName(meta: { id: string; mime: PictureMime }): string {
  return `${meta.id}.${EXTENSION[meta.mime]}`;
}

/** A fresh id that is not on the shelf, and that does not hold "env" (a backup would leave such a name out). */
function freshId(dir: string): string {
  for (;;) {
    const bytes = randomBytes(8);
    let letters = "";
    for (const byte of bytes) letters += ID_ALPHABET[byte % ID_ALPHABET.length];
    const id = `m-${letters}`;
    if (/env/i.test(id) || existsSync(join(dir, `${id}.json`))) continue;
    return id;
  }
}

function writeSidecar(dir: string, meta: PictureMeta): void {
  const path = join(dir, `${meta.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** One picture's sidecar, checked against its file; undefined when either is missing or does not hold together. */
function readMeta(dir: string, id: string): PictureMeta | undefined {
  if (!isPictureId(id)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const mime = record["mime"];
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/gif" && mime !== "image/webp") return undefined;
  const from = record["from"] as Record<string, unknown> | undefined;
  if (record["id"] !== id || typeof record["bytes"] !== "number" || typeof record["name"] !== "string") return undefined;
  if (typeof from !== "object" || from === null || typeof from["world"] !== "string" || typeof from["place"] !== "string") return undefined;
  if (typeof record["atMs"] !== "number" || !Number.isSafeInteger(record["atMs"])) return undefined;
  const meta: PictureMeta = {
    id,
    mime,
    bytes: record["bytes"],
    name: record["name"],
    from: { world: from["world"], place: from["place"] },
    atMs: record["atMs"],
  };
  const file = join(dir, fileName(meta));
  if (!existsSync(file) || statSync(file).size !== meta.bytes) return undefined;
  return meta;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...Array.from(bytes.subarray(start, start + length)));
}
