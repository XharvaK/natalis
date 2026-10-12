import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutwardHold, Receipt, ToolContext } from "../../contracts.js";
import { forgetText, openDomusDb } from "./store.js";
import { gameOverlaySayTool, OVERLAY_FEED_MAX, OVERLAY_KEEP, overlayItems, type OverlayContext } from "./overlay.js";

const T0 = 1_800_000_000_000;
const THREAD = "domus:slot3";
/** An invented word for the privacy list: the body holds any text that carries it. */
const HELD = "zorbquill";

let dir: string;
let db: DatabaseSync;
let clock: number;
let stopped: boolean;

function hold(texts: readonly string[]): OutwardHold | undefined {
  return texts.some((text) => text.toLowerCase().includes(HELD)) ? { kind: "term", term: HELD, category: "test" } : undefined;
}

function context(overrides: Partial<NonNullable<OverlayContext>> = {}): OverlayContext {
  return { db, nowMs: () => clock, stopped: () => stopped, outwardHold: hold, ...overrides };
}

function say(args: Record<string, unknown>, open: () => OverlayContext = () => context(), thread = THREAD): Promise<Receipt> {
  return gameOverlaySayTool(open).run(args, { thread, turnId: "t-overlay", nowMs: clock } as ToolContext);
}

function rowCount(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM overlay_lines").get() as { n: number }).n);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domus-overlay-"));
  db = openDomusDb(dir);
  clock = T0;
  stopped = false;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("game_overlay_say: her line on the overlay", () => {
  it("says in its description that the line shows in the game as a notification from her, and on the overlay viewers read", () => {
    const description = gameOverlaySayTool(() => context()).spec.description;
    expect(description).toContain("it shows in the game as a notification from you");
    expect(description).toContain("on the overlay panel viewers see");
    expect(description).toContain("Viewers read it.");
    expect(description).toContain("a short thought or feeling you want seen, one line.");
  });

  it("puts one trimmed line on the overlay and says so in its receipt", async () => {
    const receipt = await say({ text: "  Hello overlay.  " });
    expect(receipt).toMatchObject({ ok: true, summary: "Put your line on the game overlay. Viewers read it; clear removes it." });
    expect(db.prepare("SELECT line, thread, at_ms FROM overlay_lines").all()).toEqual([{ line: "Hello overlay.", thread: THREAD, at_ms: T0 }]);
  });

  it("refuses a line that is empty, too long, or not text, and a call with both or neither field", async () => {
    expect(await say({ text: "   " })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({ text: "x".repeat(201) })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({ text: 7 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({})).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({ text: "Hi", clear: true })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({ clear: false })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await say({ text: "Hi", colour: "red" })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(rowCount()).toBe(0);
  });

  it("holds a line that carries a word on the privacy list, with the same receipt words as the web and the sandbox", async () => {
    const receipt = await say({ text: `A line with ${HELD} in it` });
    expect(receipt).toMatchObject({
      ok: false,
      summary: "Held back: a word on your summoner's privacy list, so nothing was sent or run.",
      refused: { code: "held_privacy" },
    });
    expect(receipt.refused?.reason).toContain("(test)");
    expect(receipt.refused?.reason).not.toContain(HELD);
    expect(rowCount()).toBe(0);
  });

  it("is refused while the world is not running, and while the summoner's stop is on", async () => {
    expect(await say({ text: "Hi" }, () => null)).toMatchObject({ ok: false, refused: { code: "not_running" } });
    stopped = true;
    expect(await say({ text: "Hi" })).toMatchObject({ ok: false, refused: { code: "stopped" } });
    expect(await say({ clear: true })).toMatchObject({ ok: false, refused: { code: "stopped" } });
    expect(rowCount()).toBe(0);
  });

  it("clears her line with clear: true, and that is always allowed", async () => {
    await say({ text: "First." });
    const cleared = await say({ clear: true });
    expect(cleared).toMatchObject({ ok: true, summary: "Cleared your lines on the game overlay." });
    expect(db.prepare("SELECT line FROM overlay_lines ORDER BY rowid").all()).toEqual([{ line: "First." }, { line: null }]);
  });

  it("keeps the newest twenty rows and no more", async () => {
    for (let index = 0; index < OVERLAY_KEEP + 5; index++) {
      clock += 1000;
      await say({ text: `Line ${index}` });
    }
    expect(rowCount()).toBe(OVERLAY_KEEP);
    expect(db.prepare("SELECT line FROM overlay_lines ORDER BY rowid LIMIT 1").get()).toEqual({ line: "Line 5" });
  });
});

describe("the overlay feed: the lines since the last clear", () => {
  it("answers the newest lines since the last clear, at most six, oldest first, each stamped chosen", async () => {
    await say({ text: "Old, before a clear." });
    await say({ clear: true });
    for (let index = 1; index <= 8; index++) {
      clock += 1000;
      await say({ text: `Line ${index}` });
    }
    const items = overlayItems(db, false);
    expect(OVERLAY_FEED_MAX).toBe(6);
    expect(items.map((item) => item.line)).toEqual(["Line 3", "Line 4", "Line 5", "Line 6", "Line 7", "Line 8"]);
    expect(items[0]).toEqual({ inputs: "chosen", at_ms: T0 + 3000, pass: expect.any(String), line: "Line 3", regime: {} });
  });

  it("is empty after a clear, and while the summoner's stop is on", async () => {
    await say({ text: "Shown." });
    expect(overlayItems(db, false)).toHaveLength(1);
    expect(overlayItems(db, true)).toEqual([]);
    await say({ clear: true });
    expect(overlayItems(db, false)).toEqual([]);
  });
});

describe("forgetting the words of the overlay", () => {
  it("erases a forgotten line from the overlay's store, and the feed never carries the marker to the game", async () => {
    await say({ text: "Words to forget." });
    await say({ text: "Words to keep." });
    expect(forgetText(db, ["forget"])).toBe(1);
    expect(overlayItems(db, false).map((item) => item.line)).toEqual(["Words to keep."]);
  });
});
