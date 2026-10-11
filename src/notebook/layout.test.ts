import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Notebook } from "../contracts.js";
import { openNotebook } from "./git-notebook.js";
import { ENTITY_LAYOUT, readmeText, seedNotebook } from "./layout.js";

let root: string;
let nb: Notebook;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "natalis-layout-"));
  nb = await openNotebook(path.join(root, "entity"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function commitCount(): number {
  return Number(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: path.join(root, "entity"),
      encoding: "utf8",
    }).trim(),
  );
}

describe("ENTITY_LAYOUT", () => {
  it("names the default folders, each once, with a purpose", () => {
    const folders = ENTITY_LAYOUT.map((e) => e.folder);
    expect(folders).toEqual([
      "self",
      "memory",
      "people",
      "places",
      "diary",
      "projects",
      "problems",
      "skills",
      "questions",
      "wants",
      "lessons",
      "calendar",
      "letters",
      "creations",
      "collection",
      "library",
      "world",
      "game",
      "accounts",
      "body",
      "inbox",
      "dreams",
      "private",
      "trash",
    ]);
    expect(new Set(folders).size).toBe(folders.length);
    for (const entry of ENTITY_LAYOUT) expect(entry.purpose.length).toBeGreaterThan(10);
  });
});

describe("seedNotebook", () => {
  it("writes a README.md into every folder, authored by body", async () => {
    await seedNotebook(nb);
    for (const entry of ENTITY_LAYOUT) {
      const text = nb.read(`${entry.folder}/README.md`);
      expect(text).toBe(readmeText(entry));
      expect(text).toContain(`# ${entry.folder}`);
      expect(text).toContain(entry.purpose);
    }
    const authors = execFileSync("git", ["log", "--format=%an", "--", "people/README.md"], {
      cwd: path.join(root, "entity"),
      encoding: "utf8",
    }).trim();
    expect(authors).toBe("body");
  });

  it("seeding again changes nothing and keeps a README the entity already wrote", async () => {
    await seedNotebook(nb);
    await nb.edit("self/README.md", "Who I am", "Who I am, in my words", "Make it mine", "self");
    const before = commitCount();
    await seedNotebook(nb);
    expect(commitCount()).toBe(before);
    expect(nb.read("self/README.md")).toContain("Who I am, in my words");
  });
});
