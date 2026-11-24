import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../contracts.js";
import { openLinks, type LinkRelation, type LinkStore } from "../river/links.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { linksTools } from "./links-tools.js";

// Every name and place here is invented. Nothing reads a real Lar folder.
const NOW = Date.UTC(2026, 10, 20, 14, 0, 0);

let dir: string;
let links: LinkStore;
let context: ToolContext;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-links-tools-"));
  links = openLinks(join(dir, "river.db"));
  context = {
    thread: "self",
    turnId: "t-links-tools",
    nowMs: NOW,
    river: new MemoryRiver({ nowMs: () => NOW }),
    notebook: new MemoryNotebook({ nowMs: () => NOW }),
  };
  seq = 1;
});

afterEach(() => {
  links.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function tool(privateView: (thread: string) => boolean = () => false): Tool {
  const found = linksTools(links, { privateView }).find((candidate) => candidate.spec.name === "list_links");
  if (found === undefined) throw new Error("no list_links tool");
  return found;
}

function addLink(from: string, to: string, atMs: number, options: { private?: boolean; relation?: LinkRelation } = {}): void {
  links.record({
    thread: "self",
    from,
    to,
    relation: options.relation ?? "supports",
    reason: "They belong together.",
    private: options.private ?? false,
    seq: seq++,
    atMs,
    author: "self",
  });
}

describe("list_links", () => {
  it("lists a note's links on either side, newest first, and settles", async () => {
    addLink("notes/a.md", "notes/target.md", NOW - 1_000);
    addLink("notes/target.md", "notes/b.md", NOW, { relation: "elaborates" });
    addLink("notes/c.md", "notes/d.md", NOW + 1_000);

    const list = tool();
    const receipt: Receipt = await list.run({ path: "notes/target.md" }, context);

    expect(list.settles).toBe(true);
    expect(receipt).toEqual({
      ok: true,
      summary: "2 link(s).",
      data: {
        links: [
          {
            from: "notes/target.md",
            to: "notes/b.md",
            relation: "elaborates",
            reason: "They belong together.",
            atMs: NOW,
          },
          {
            from: "notes/a.md",
            to: "notes/target.md",
            relation: "supports",
            reason: "They belong together.",
            atMs: NOW - 1_000,
          },
        ],
      },
    });
  });

  it("lists the newest links when no path is given", async () => {
    addLink("notes/a.md", "notes/b.md", NOW - 2_000);
    addLink("notes/b.md", "notes/c.md", NOW - 1_000);
    addLink("notes/c.md", "notes/d.md", NOW);

    const receipt = await tool().run({}, context);

    expect(receipt.summary).toBe("3 link(s).");
    const shown = receipt.data?.["links"] as Array<Record<string, unknown>>;
    expect(shown.map((link) => link["atMs"])).toEqual([NOW, NOW - 1_000, NOW - 2_000]);
  });

  it("says plainly when there are no links", async () => {
    expect(await tool().run({}, context)).toMatchObject({ ok: true, summary: "No links.", data: { links: [] } });
    expect(await tool().run({ path: "notes/quiet.md" }, context)).toMatchObject({
      ok: true,
      summary: "No links for notes/quiet.md.",
      data: { links: [] },
    });
  });

  it("hides private links from a thread that cannot see private/", async () => {
    addLink("notes/secret.md", "notes/target.md", NOW, { private: true });

    expect(await tool(() => false).run({ path: "notes/target.md" }, context)).toMatchObject({
      summary: "No links for notes/target.md.",
    });
    expect(await tool(() => false).run({}, context)).toMatchObject({ summary: "No links." });

    let seen = "";
    const open = await tool((thread) => {
      seen = thread;
      return true;
    }).run({ path: "notes/target.md" }, context);
    expect(open.summary).toBe("1 link(s).");
    expect(seen).toBe("self");
  });

  it("refuses a path that is not a notebook path", async () => {
    expect(await tool().run({ path: "../outside.md" }, context)).toMatchObject({
      ok: false,
      refused: { code: "bad_path" },
    });
  });
});
