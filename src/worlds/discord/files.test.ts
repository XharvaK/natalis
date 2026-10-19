import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_BYTES_MAX, plainFileName, saveFile } from "./files.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const home = () => ({ dir: join(dir, "home"), shownAs: "/home/lar" });
const bytes = (text: string) => new TextEncoder().encode(text);

/** A link, or undefined where this system will not make one (Windows without the right). */
function tryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "junction");
    return true;
  } catch {
    return false;
  }
}

describe("plainFileName", () => {
  it("keeps a plain name as it is, with its extension in lower case", () => {
    expect(plainFileName("first_edition.HTML")).toEqual({ stem: "first_edition", extension: ".html" });
  });

  it("drops folders, leading dots and characters a shell would trip on", () => {
    expect(plainFileName("../../.bashrc")).toEqual({ stem: "bashrc", extension: "" });
    expect(plainFileName("my notes (final).txt")).toEqual({ stem: "my_notes_final", extension: ".txt" });
    expect(plainFileName("C:\\Users\\x\\a.pdf")).toEqual({ stem: "a", extension: ".pdf" });
  });

  it("names a file with no usable name 'file'", () => {
    expect(plainFileName("...")).toEqual({ stem: "file", extension: "" });
    expect(plainFileName("").stem).toBe("file");
  });
});

describe("saveFile", () => {
  it("writes into home/files and says where she finds it", () => {
    const saved = saveFile(home(), "book.html", bytes("<p>hi</p>"));
    expect(saved).toEqual({ shownAt: "/home/lar/files/book.html", name: "book.html" });
    expect(readFileSync(join(dir, "home", "files", "book.html"), "utf8")).toBe("<p>hi</p>");
  });

  it("never replaces a file: the next one with the name gets -2, then -3", () => {
    saveFile(home(), "a.txt", bytes("one"));
    expect(saveFile(home(), "a.txt", bytes("two")).name).toBe("a-2.txt");
    expect(saveFile(home(), "a.txt", bytes("three")).name).toBe("a-3.txt");
    expect(readFileSync(join(dir, "home", "files", "a.txt"), "utf8")).toBe("one");
  });

  it("refuses more than the cap", () => {
    expect(() => saveFile(home(), "big.bin", new Uint8Array(FILE_BYTES_MAX + 1))).toThrow("larger than 25 MiB");
  });

  it("refuses when files in her home is a file, not a folder", () => {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "files"), "not a folder");
    expect(() => saveFile(home(), "a.txt", bytes("x"))).toThrow("not a plain folder");
  });

  it("never writes through a link she made where the files folder should be", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(dir, "home"));
    if (!tryLink(elsewhere, join(dir, "home", "files"))) return;
    expect(() => saveFile(home(), "a.txt", bytes("x"))).toThrow("not a plain folder");
    expect(() => readFileSync(join(elsewhere, "a.txt"))).toThrow();
  });
});
