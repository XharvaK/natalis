import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext } from "../../contracts.js";
import { gameLookTool, type LookContext } from "./look.js";
import { LOOK_ASK_KEEP_MS, lookOwed, openDomusDb, takeLook, takeLookAskers } from "./store.js";

const T0 = Date.UTC(2026, 9, 12, 8, 0);
const THREAD = "domus:slot3";

let dir: string;
let db: DatabaseSync;
let attached: string | undefined;
let lastAttached: number | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-look-"));
  db = openDomusDb(dir);
  attached = "helper-1";
  lastAttached = T0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function context(): LookContext {
  return {
    db,
    nowMs: () => T0,
    attachedSession: () => attached,
    lastAttachedMs: () => lastAttached,
  };
}

function look(thread = THREAD, args: Record<string, unknown> = {}, open: () => LookContext = context): Promise<Receipt> {
  const tool: Tool = gameLookTool(open);
  return tool.run(args, { thread, turnId: "t-look", nowMs: T0 } as ToolContext);
}

describe("game_look", () => {
  it("is refused with not_attached while the game is not attached, and says when it was", async () => {
    attached = undefined;
    const receipt = await look();
    expect(receipt).toMatchObject({ ok: false, refused: { code: "not_attached" } });
    expect(receipt.refused?.reason).toContain(`It was last attached at ${new Date(T0).toISOString()}.`);
    expect(lookOwed(db, "helper-1")).toBe(false);
  });

  it("says it has not been attached since the world started when it never was", async () => {
    attached = undefined;
    lastAttached = undefined;
    expect(await look()).toMatchObject({
      ok: false, refused: { code: "not_attached", reason: "The game is not attached, so nothing was requested. It has not been attached since this world started." },
    });
  });

  it("is refused while the world is not running", async () => {
    expect(await look(THREAD, {}, () => null)).toMatchObject({ ok: false, refused: { code: "not_running" } });
  });

  it("works from any thread, and keeps the thread that asked, so its look view can come to that thread too", async () => {
    expect(await look("discord:dm:owner")).toMatchObject({ ok: true });
    expect(await look(THREAD)).toMatchObject({ ok: true });
    expect(takeLookAskers(db, "helper-1", T0)).toEqual(["discord:dm:owner", THREAD]);
    expect(takeLookAskers(db, "helper-1", T0)).toEqual([]);
  });

  it("does not hand a look view to a thread that asked long ago", async () => {
    await look("discord:dm:owner");
    expect(takeLookAskers(db, "helper-1", T0 + LOOK_ASK_KEEP_MS + 1)).toEqual([]);
  });

  it("owes one look to the attached helper session, and says so", async () => {
    const receipt = await look();
    expect(receipt).toMatchObject({ ok: true });
    expect(receipt.summary).toContain("Asked the game for a fresh view of now.");
    expect(lookOwed(db, "helper-1")).toBe(true);
  });

  it("keeps one flag: asking again while one is owed changes nothing", async () => {
    await look();
    const again = await look();
    expect(again).toMatchObject({ ok: true });
    expect(again.summary).toContain("already asked for");
    expect(takeLook(db, "helper-1", T0)).toBe(true);
    expect(takeLook(db, "helper-1", T0)).toBe(false);
  });

  it("refuses any field: it takes none", async () => {
    expect(await look(THREAD, { now: true })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
  });
});
