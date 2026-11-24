import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLinks, type LinkRecord, type LinkRelation, type LinkStore } from "./links.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);

let dir: string;
let links: LinkStore;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-links-store-"));
  links = openLinks(join(dir, "river.db"));
  seq = 1;
});

afterEach(() => {
  links.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function addLink(options: {
  from: string;
  to: string;
  atMs: number;
  private?: boolean;
  relation?: LinkRelation;
}): LinkRecord {
  return links.record({
    thread: "self",
    from: options.from,
    to: options.to,
    relation: options.relation ?? "supports",
    reason: "They belong together.",
    private: options.private ?? false,
    seq: seq++,
    atMs: options.atMs,
    author: "self",
  });
}

describe("forNote", () => {
  it("returns the links that name the note on either side, newest first", () => {
    addLink({ from: "notes/a.md", to: "notes/target.md", atMs: NOW - 2_000 });
    addLink({ from: "notes/target.md", to: "notes/b.md", atMs: NOW });
    addLink({ from: "notes/c.md", to: "notes/d.md", atMs: NOW + 2_000 });

    const found = links.forNote("notes/target.md", false);

    expect(found.map((link) => [link.from, link.to])).toEqual([
      ["notes/target.md", "notes/b.md"],
      ["notes/a.md", "notes/target.md"],
    ]);
  });

  it("hides private links unless they are asked for", () => {
    addLink({ from: "notes/a.md", to: "notes/target.md", atMs: NOW });
    addLink({ from: "notes/b.md", to: "notes/target.md", atMs: NOW + 1_000, private: true });

    expect(links.forNote("notes/target.md", false)).toHaveLength(1);
    expect(links.forNote("notes/target.md", true)).toHaveLength(2);
  });

  it("skips links a trash has dropped", () => {
    addLink({ from: "notes/target.md", to: "notes/b.md", atMs: NOW });
    links.dropForNote("notes/target.md");

    expect(links.forNote("notes/target.md", false)).toEqual([]);
  });

  it("returns at most the 20 newest links", () => {
    for (let n = 1; n <= 25; n += 1) {
      addLink({ from: "notes/a.md", to: "notes/target.md", atMs: NOW + n });
    }

    const found = links.forNote("notes/target.md", false);

    expect(found).toHaveLength(20);
    expect(found[0]?.atMs).toBe(NOW + 25);
    expect(found.at(-1)?.atMs).toBe(NOW + 6);
  });
});

describe("recent", () => {
  it("returns the newest links up to the limit, hiding private ones unless asked", () => {
    for (let n = 1; n <= 5; n += 1) {
      addLink({ from: "notes/a.md", to: `notes/n${n}.md`, atMs: NOW + n });
    }
    addLink({ from: "notes/a.md", to: "notes/secret.md", atMs: NOW + 6, private: true });

    expect(links.recent(false, 3).map((link) => link.atMs)).toEqual([NOW + 5, NOW + 4, NOW + 3]);
    expect(links.recent(true, 10).map((link) => link.atMs)).toEqual([
      NOW + 6,
      NOW + 5,
      NOW + 4,
      NOW + 3,
      NOW + 2,
      NOW + 1,
    ]);
  });

  it("skips links a forget has dropped", () => {
    addLink({ from: "notes/a.md", to: "notes/b.md", atMs: NOW });
    links.dropForNote("notes/b.md");

    expect(links.recent(false, 10)).toEqual([]);
  });
});
