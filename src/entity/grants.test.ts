import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNotebook } from "../notebook/index.js";
import { openRiver } from "../river/index.js";
import { notebookTools } from "../tools/notebook-tools.js";
import { ANYWHERE, grantsPath, openGrants } from "./grants.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 5 })));

function larFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "natalis-grants-"));
  roots.push(root);
  return join(root, "lar");
}

const NOW = 1_760_000_000_000;

describe("grants.db (B4 Q1)", () => {
  it("grants.db holds no argument text, only the HMAC and the site or place scope", () => {
    const dir = larFolder();
    const marker = "quill-feather-marker";
    const grants = openGrants(dir);
    try {
      const hash = grants.hmac({ url: "https://forum.example.org/t/1", method: "POST", body: marker, why: marker });
      grants.request({
        tool: "web_request",
        scopeKey: "forum.example.org",
        argsHmac: hash,
        postedSeq: 7,
        place: "cli:summoner",
        askingThread: "cli:summoner",
        nowMs: NOW,
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(grants.openRequests()).toEqual([
        expect.objectContaining({
          tool: "web_request",
          scopeKey: "forum.example.org",
          argsHmac: hash,
          postedSeq: 7,
          place: "cli:summoner",
          askingThread: "cli:summoner",
          status: "open",
        }),
      ]);
    } finally {
      grants.close();
    }
    expect(readFileSync(grantsPath(dir)).includes(Buffer.from(marker))).toBe(false);
  });

  it("the request HMAC is keyed to this Lar, not a bare hash of the arguments", () => {
    const one = openGrants(larFolder());
    const two = openGrants(larFolder());
    try {
      const args = { url: "https://forum.example.org/t/1", method: "POST" };
      const first = one.hmac(args);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(two.hmac(args));
    } finally {
      one.close();
      two.close();
    }
  });

  it("a refusal wins over a standing grant", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    try {
      const args = { url: "https://forum.example.org/t/1", method: "POST" };
      const hash = grants.hmac(args);
      const refused = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "never",
        createdBy: "owner",
        nowMs: NOW,
      });
      grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "always",
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: NOW })).toEqual({
        outcome: "refuse",
        grantId: refused,
        scope: "forum.example.org",
      });
    } finally {
      grants.close();
    }
  });

  it("a standing grant allows every call on its scope", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    try {
      const id = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "always",
        createdBy: "owner",
        nowMs: NOW,
      });
      const check = { tool: "web_request", scope: "forum.example.org", argsHmac: grants.hmac({ url: "https://forum.example.org/a" }), nowMs: NOW };
      expect(grants.check(check)).toEqual({ outcome: "allow", grantId: id, scope: "forum.example.org", kind: "always" });
      expect(grants.check(check)).toEqual({ outcome: "allow", grantId: id, scope: "forum.example.org", kind: "always" });
      expect(grants.listGrants()[0]?.lastUsedAt).toBe(NOW);
    } finally {
      grants.close();
    }
  });

  it("a once grant allows one call whose arguments match the HMAC, then asks again", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    try {
      const args = { url: "https://forum.example.org/t/1", method: "POST", body: "one post" };
      const id = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        argsHmac: grants.hmac(args),
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: grants.hmac(args), nowMs: NOW })).toEqual({
        outcome: "allow",
        grantId: id,
        scope: "forum.example.org",
        kind: "once",
      });
      expect(grants.listGrants()[0]?.usedAt).toBe(NOW);
      expect(grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: grants.hmac(args), nowMs: NOW })).toEqual({
        outcome: "ask",
      });
    } finally {
      grants.close();
    }
  });

  it("a once grant with a different HMAC asks and is left unused", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    try {
      const granted = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        argsHmac: grants.hmac({ url: "https://forum.example.org/t/1", method: "POST" }),
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(
        grants.check({
          tool: "web_request",
          scope: "forum.example.org",
          argsHmac: grants.hmac({ url: "https://forum.example.org/t/2", method: "POST" }),
          nowMs: NOW,
        }),
      ).toEqual({ outcome: "ask" });
      const [row] = grants.listGrants();
      expect(row?.id).toBe(granted);
      expect(row?.usedAt).toBeUndefined();
    } finally {
      grants.close();
    }
  });

  it("grant_log UPDATE and DELETE fail", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    grants.addGrant({ tool: "web_request", scope: "forum.example.org", kind: "always", createdBy: "owner", nowMs: NOW });
    grants.close();
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(() => db.prepare("UPDATE grant_log SET event = 'dropped'").run()).toThrow(/append-only/i);
      expect(() => db.prepare("DELETE FROM grant_log").run()).toThrow(/append-only/i);
      const count = db.prepare("SELECT COUNT(*) AS n FROM grant_log").get() as { n: number };
      expect(Number(count.n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("no notebook tool can open grants.db", async () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    grants.request({
      tool: "write_note",
      scopeKey: ANYWHERE,
      argsHmac: grants.hmac({ path: "notes/a.md" }),
      postedSeq: 1,
      place: "cli:summoner",
      askingThread: "cli:summoner",
      nowMs: NOW,
    });
    grants.close();

    const notebook = await openNotebook(join(dir, "notebook"));
    const river = openRiver(join(dir, "river.db"));
    try {
      const context = { thread: "self", turnId: "turn-1", nowMs: NOW, river, notebook };
      const write = notebookTools().find((tool) => tool.spec.name === "write_note");
      expect(write).toBeDefined();
      await expect(write!.run({ path: "../grants.db", text: "overwritten", why: "test" }, context)).rejects.toThrow(
        /leave the notebook/,
      );

      const read = notebookTools().find((tool) => tool.spec.name === "read_note");
      expect(read).toBeDefined();
      const readBack = await read!.run({ path: "../grants.db" }, context);
      expect(readBack.ok).toBe(false);
      expect(readBack.refused?.code).toBe("bad_path");
    } finally {
      river.close();
    }

    const reopened = openGrants(dir);
    try {
      expect(reopened.openRequests()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
