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
const DAY = 24 * 60 * 60_000;

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

  it("a once grant at one scope does not allow the same arguments at another scope", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    try {
      const args = { url: "https://forum.example.org/t/1", method: "POST" };
      const id = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        argsHmac: grants.hmac(args),
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(grants.check({ tool: "web_request", scope: "example.net", argsHmac: grants.hmac(args), nowMs: NOW })).toEqual({
        outcome: "ask",
      });
      expect(grants.listGrants().find((grant) => grant.id === id)?.usedAt).toBeUndefined();
      expect(grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: grants.hmac(args), nowMs: NOW })).toEqual({
        outcome: "allow",
        grantId: id,
        scope: "forum.example.org",
        kind: "once",
      });
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

describe("grants.db lifetime, restore and forget (B4 Q3)", () => {
  it("a request and an unused once grant close after a day, and the drop is logged", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    let requestId = 0;
    let onceId = 0;
    let alwaysId = 0;
    const args = { url: "https://forum.example.org/t/1", method: "POST" };
    const hash = grants.hmac(args);
    try {
      requestId = grants.request({
        tool: "web_request",
        scopeKey: "forum.example.org",
        argsHmac: hash,
        postedSeq: 3,
        place: "cli:summoner",
        askingThread: "discord:room:garden",
        nowMs: NOW,
      });
      onceId = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        requestSeq: requestId,
        argsHmac: hash,
        createdBy: "owner",
        nowMs: NOW,
      });
      alwaysId = grants.addGrant({
        tool: "web_request",
        scope: "example.net",
        kind: "always",
        createdBy: "owner",
        nowMs: NOW,
      });

      const closed = grants.closeExpired(NOW + DAY);
      expect(closed.requests.map((request) => request.id)).toEqual([requestId]);
      expect(closed.onceGrants.map((grant) => grant.id)).toEqual([onceId]);
      expect(grants.getRequest(requestId)?.status).toBe("expired");
      expect(grants.getRequest(requestId)?.closedAt).toBe(NOW + DAY);
      expect(grants.listGrants().find((grant) => grant.id === onceId)?.revokedAt).toBe(NOW + DAY);
      expect(
        grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: NOW + DAY }),
      ).toEqual({ outcome: "ask" });
      expect(
        grants.check({
          tool: "web_request",
          scope: "example.net",
          argsHmac: grants.hmac({ url: "https://example.net/" }),
          nowMs: NOW + DAY,
        }),
      ).toMatchObject({ outcome: "allow", grantId: alwaysId, kind: "always" });
      expect(grants.closeExpired(NOW + DAY + 1)).toEqual({ requests: [], onceGrants: [] });
    } finally {
      grants.close();
    }
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(db.prepare("SELECT grant_id, event FROM grant_log WHERE event = 'dropped'").all()).toEqual([
        { grant_id: onceId, event: "dropped" },
      ]);
    } finally {
      db.close();
    }
  });

  it("a once grant older than a day asks even when no sweep ran", () => {
    const grants = openGrants(larFolder());
    try {
      const hash = grants.hmac({ url: "https://forum.example.org/t/1" });
      grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        argsHmac: hash,
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(
        grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: NOW + DAY - 1 }),
      ).toMatchObject({ outcome: "allow", kind: "once" });
      // A second unused once grant from the same day: at exactly a day it is closed, not used.
      grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        argsHmac: hash,
        createdBy: "owner",
        nowMs: NOW,
      });
      expect(
        grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: NOW + DAY }),
      ).toEqual({ outcome: "ask" });
    } finally {
      grants.close();
    }
  });

  it("dropping unused once grants on a restore leaves standing grants and logs each drop", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    let onceId = 0;
    try {
      onceId = grants.addGrant({
        tool: "write_note",
        scope: ANYWHERE,
        kind: "once",
        argsHmac: grants.hmac({ path: "notes/a.md" }),
        createdBy: "owner",
        nowMs: NOW,
      });
      grants.addGrant({ tool: "web_request", scope: "forum.example.org", kind: "always", createdBy: "owner", nowMs: NOW });
      grants.addGrant({ tool: "say", scope: "discord:room:garden", kind: "never", createdBy: "owner", nowMs: NOW });

      const dropped = grants.dropUnusedOnce(NOW + 5_000);
      expect(dropped.map((grant) => grant.id)).toEqual([onceId]);
      expect(grants.listGrants().find((grant) => grant.id === onceId)?.revokedAt).toBe(NOW + 5_000);
      expect(grants.listGrants().filter((grant) => grant.kind !== "once")).toHaveLength(2);
    } finally {
      grants.close();
    }
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(db.prepare("SELECT grant_id, event FROM grant_log WHERE event = 'dropped'").all()).toEqual([
        { grant_id: onceId, event: "dropped" },
      ]);
    } finally {
      db.close();
    }
  });

  it("a schema re-open keeps the append-only trigger", () => {
    const dir = larFolder();
    const first = openGrants(dir);
    first.addGrant({ tool: "web_request", scope: "forum.example.org", kind: "always", createdBy: "owner", nowMs: NOW });
    first.close();
    // A migration that drops the table's triggers is repaired by the next open, before any row can be changed.
    const raw = new DatabaseSync(grantsPath(dir));
    try {
      raw.exec("DROP TRIGGER grant_log_update; DROP TRIGGER grant_log_delete;");
    } finally {
      raw.close();
    }
    const reopened = openGrants(dir);
    reopened.addGrant({ tool: "web_request", scope: "forum.example.org", kind: "always", createdBy: "owner", nowMs: NOW });
    reopened.close();
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('grant_log_update', 'grant_log_delete') ORDER BY name").all(),
      ).toEqual([{ name: "grant_log_delete" }, { name: "grant_log_update" }]);
      expect(() => db.prepare("UPDATE grant_log SET event = 'used'").run()).toThrow(/append-only/i);
      expect(() => db.prepare("DELETE FROM grant_log").run()).toThrow(/append-only/i);
    } finally {
      db.close();
    }
  });

  it("a forgotten request clears its hash and scope, and its grant asks again", () => {
    const dir = larFolder();
    const grants = openGrants(dir);
    let requestId = 0;
    let onceId = 0;
    let otherRequestId = 0;
    let otherGrantId = 0;
    const hash = grants.hmac({ url: "https://forum.example.org/lantern-yard" });
    const otherHash = grants.hmac({ url: "https://example.net/quiet" });
    try {
      requestId = grants.request({
        tool: "web_request",
        scopeKey: "forum.example.org",
        argsHmac: hash,
        postedSeq: 9,
        place: "cli:summoner",
        askingThread: "cli:summoner",
        nowMs: NOW,
      });
      onceId = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        requestSeq: requestId,
        argsHmac: hash,
        createdBy: "owner",
        nowMs: NOW,
      });
      otherRequestId = grants.request({
        tool: "web_request",
        scopeKey: "example.net",
        argsHmac: otherHash,
        postedSeq: 10,
        place: "cli:summoner",
        askingThread: "cli:summoner",
        nowMs: NOW,
      });
      otherGrantId = grants.addGrant({
        tool: "web_request",
        scope: "example.net",
        kind: "once",
        requestSeq: otherRequestId,
        argsHmac: otherHash,
        createdBy: "owner",
        nowMs: NOW,
      });

      expect(grants.clearForgottenRequests([9], NOW + 1_000)).toBe(1);
      expect(grants.getRequest(requestId)).toMatchObject({ scopeKey: "cleared", argsHmac: "", status: "cleared" });
      const once = grants.listGrants().find((grant) => grant.id === onceId);
      expect(once?.scope).toBe("cleared");
      expect(once?.argsHmac).toBeUndefined();
      expect(
        grants.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: NOW + 1_000 }),
      ).toEqual({ outcome: "ask" });

      expect(grants.getRequest(otherRequestId)).toMatchObject({ scopeKey: "example.net", argsHmac: otherHash });
      const other = grants.listGrants().find((grant) => grant.id === otherGrantId);
      expect(other?.scope).toBe("example.net");
      expect(other?.argsHmac).toBe(otherHash);
    } finally {
      grants.close();
    }
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(db.prepare("SELECT grant_id, event FROM grant_log WHERE event = 'cleared by forget'").all()).toEqual([
        { grant_id: onceId, event: "cleared by forget" },
      ]);
    } finally {
      db.close();
    }
  });
});
