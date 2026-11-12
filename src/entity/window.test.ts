import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RiverRow } from "../contracts.js";
import { createWindow, WINDOW_ABOUT, WINDOW_FLUSH_MS } from "./window.js";

// Every row is built here, the way the body writes it. The window reads only what these fields hold.
function rowOf(partial: Partial<RiverRow> & Pick<RiverRow, "kind" | "source">): RiverRow {
  return { thread: "dm:owner", seq: 1, atMs: 0, text: "", ...partial } as RiverRow;
}

const turnStart = (turnId: string, thread = "dm:owner") =>
  rowOf({ kind: "turn", source: "body", thread, data: { phase: "start", turnId } });
const turnEnd = (turnId: string, endedBy = "end_turn", modelCalls = 2, toolCalls = 1) =>
  rowOf({ kind: "turn", source: "body", data: { phase: "end", turnId, endedBy, modelCalls, toolCalls } });
const thought = (turnId: string, text: string) =>
  rowOf({ kind: "note", source: "self", text, data: { thought: true, turnId } });
const toolCall = (turnId: string, callId: string, name: string, args: string) =>
  rowOf({ kind: "tool_call", source: "self", text: name, data: { args, turnId, callId } });
const receipt = (turnId: string, callId: string, text: string, refused?: { code: string; reason: string }) =>
  rowOf({
    kind: "receipt",
    source: "body",
    text,
    data: { tool: "x", ok: refused === undefined, turnId, callId, ...(refused === undefined ? {} : { refused }) },
  });

let now = 0;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** A window whose show records each batch it was given, and whose clock is `now`. */
function windowWith(overrides: Partial<Parameters<typeof createWindow>[0]> = {}) {
  const shown: string[] = [];
  const logged: string[] = [];
  const win = createWindow({
    show: async (text) => {
      shown.push(text);
    },
    redact: (text) => text,
    log: (line) => logged.push(line),
    nowMs: () => now,
    ...overrides,
  });
  return { win, shown, logged };
}

describe("the window's lines", () => {
  it("shows a thought of 1800 characters or fewer whole", async () => {
    const { win, shown } = windowWith();
    const text = "a".repeat(1800);
    win.row(thought("t1", text));
    await win.flush();
    expect(shown).toEqual([`thinks: ${text}`]);
  });

  it("cuts a thought of 3000 characters to its first 1200, a line naming the cut, and its last 500", async () => {
    const { win, shown } = windowWith();
    const head = "H".repeat(1200);
    const middle = "M".repeat(1300);
    const tail = "T".repeat(500);
    win.row(thought("t1", head + middle + tail));
    await win.flush();
    expect(shown).toEqual([`thinks: ${head}\n(cut: 1300 characters in the middle are in her river)\n${tail}`]);
  });

  it("gives a tool call its does line, and its receipt the arrow line, and names a refusal's code", async () => {
    const { win, shown } = windowWith();
    win.row(turnStart("t1"));
    win.row(toolCall("t1", "c1", "read_note", '{"path":"notes/a.md"}'));
    win.row(receipt("t1", "c1", "Read the note."));
    win.row(toolCall("t1", "c2", "write_note", "{}"));
    win.row(receipt("t1", "c2", "The note was not written.", { code: "bad_arguments", reason: "no path" }));
    win.row(turnEnd("t1"));
    await win.flush();
    const batch = shown.join("\n");
    expect(batch).toContain('does: read_note {"path":"notes/a.md"}');
    expect(batch).toContain("  -> Read the note.");
    expect(batch).toContain("does: write_note {}");
    expect(batch).toContain("  -> refused (bad_arguments): The note was not written.");
    expect(batch).toContain("Turn ended (end_turn): 2 model calls, 1 tool calls.");
  });

  it("hides a call that names private/, its receipt, and her later thoughts of that turn, and shows the next turn", async () => {
    const { win, shown } = windowWith();
    win.row(turnStart("t2"));
    win.row(thought("t2", "Before the diary."));
    win.row(toolCall("t2", "c9", "read_note", '{"path":"private/diary.md"}'));
    win.row(receipt("t2", "c9", "Dear diary, the secret words."));
    win.row(thought("t2", "Still thinking about the diary."));
    win.row(turnEnd("t2"));
    win.row(turnStart("t3"));
    win.row(thought("t3", "A thought of the next turn."));
    await win.flush();
    const batch = shown.join("\n");
    expect(batch).toContain("Before the diary.");
    expect(batch).toContain("does: read_note (in private/, not shown)");
    expect(batch).toContain("  -> (not shown)");
    expect(batch).toContain("thinks: (not shown: this turn opened private/)");
    expect(batch).toContain("thinks: A thought of the next turn.");
    expect(batch).not.toContain("diary.md");
    expect(batch).not.toContain("secret words");
    expect(batch).not.toContain("Still thinking");
  });

  it("gives a say its place and its count, and never its words", async () => {
    const { win, shown } = windowWith();
    const words = "Good morning, the quiet garden is open today.";
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: words }));
    await win.flush();
    expect(shown).toEqual([`says in discord:dm:owner (${words.length} characters).`]);
    expect(shown.join("\n")).not.toContain("garden");
  });

  it("gives an outside event its count and never its words, and a body event its clipped text", async () => {
    const { win, shown } = windowWith();
    const outside = "A guest wrote a long private-looking message about the kitchen.";
    win.row(rowOf({ kind: "event", source: "outside", actor: "mara", place: "discord:room:general", text: outside }));
    win.row(rowOf({ kind: "event", source: "body", text: "x".repeat(400) }));
    await win.flush();
    const batch = shown.join("\n");
    expect(batch).toContain(`hears from mara in discord:room:general (${outside.length} characters).`);
    expect(batch).not.toContain("kitchen");
    expect(batch).toContain(`body tells her: ${"x".repeat(300)}...`);
    expect(batch).not.toContain("x".repeat(301));
  });

  it("gives nothing for a body note, a tombstone or a self note without thought, and calls show for none of them", async () => {
    const show = vi.fn(async () => {});
    const { win } = windowWith({ show });
    win.row(rowOf({ kind: "note", source: "body", text: "A restart happened." }));
    win.row(rowOf({ kind: "tombstone", source: "body", text: "" }));
    win.row(rowOf({ kind: "note", source: "self", text: "A note for myself." }));
    await win.flush();
    expect(show).not.toHaveBeenCalled();
  });

  it("writes an empty line before each thinks line and each Turn began line inside a batch", async () => {
    const { win, shown } = windowWith();
    win.row(turnStart("t1"));
    win.row(thought("t1", "First."));
    win.row(turnStart("t2"));
    await win.flush();
    expect(shown).toEqual(["Turn began in dm:owner.\n\nthinks: First.\n\nTurn began in dm:owner."]);
  });
});

describe("sending", () => {
  it("sends three rows inside the flush time as one call, in order", async () => {
    const show = vi.fn(async () => {});
    const { win } = windowWith({ show });
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "one" }));
    win.row(rowOf({ kind: "event", source: "owner", actor: "xharv", place: "discord:dm:owner", text: "two" }));
    win.row(rowOf({ kind: "say", source: "self", place: "discord:room:general", text: "three" }));
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WINDOW_FLUSH_MS);
    await win.flush();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      "says in discord:dm:owner (3 characters).\nhears from xharv in discord:dm:owner (3 characters).\nsays in discord:room:general (5 characters).",
    );
  });

  it("sends a buffer over 1500 characters at once, without waiting for the timer", async () => {
    const show = vi.fn(async () => {});
    const { win } = windowWith({ show });
    win.row(thought("t1", "b".repeat(1800)));
    await win.flush();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("drops a batch that fails, sends the next, and logs two failures within the hour once", async () => {
    const attempts: string[] = [];
    const show = async (text: string) => {
      attempts.push(text);
      if (attempts.length <= 2) throw new Error(`cannot reach it ${attempts.length}`);
    };
    const { win, logged } = windowWith({ show });
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "A" }));
    await win.flush();
    now = 1000;
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "BB" }));
    await win.flush();
    now = 2000;
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "CCC" }));
    await win.flush();
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toBe("says in discord:dm:owner (3 characters).");
    expect(logged).toEqual(["[natalis] the window could not be shown: cannot reach it 1"]);
  });

  it("replaces a known value with redact before it reaches show", async () => {
    const { win, shown } = windowWith({ redact: (text) => text.split("hunter2").join("[secret]") });
    win.row(toolCall("t1", "c1", "login", '{"password":"hunter2"}'));
    win.row(thought("t1", "The password is hunter2."));
    await win.flush();
    const batch = shown.join("\n");
    expect(batch).toContain('does: login {"password":"[secret]"}');
    expect(batch).toContain("thinks: The password is [secret].");
    expect(batch).not.toContain("hunter2");
  });

  it("shows nothing after close, and close sends what waits first", async () => {
    const { win, shown } = windowWith();
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "before close" }));
    await win.close();
    expect(shown).toEqual(["says in discord:dm:owner (12 characters)."]);
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "after close" }));
    await win.flush();
    expect(shown).toHaveLength(1);
  });

  it("gives up a close that waits more than 5000 ms, and does not hold a row after it", async () => {
    const { win, shown } = windowWith({ show: () => new Promise<void>(() => {}) });
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "stuck" }));
    const closing = win.close();
    vi.advanceTimersByTime(5000);
    await closing;
    win.row(rowOf({ kind: "say", source: "self", place: "discord:dm:owner", text: "later" }));
    expect(shown).toEqual([]);
  });
});

describe("the text the summoner reads about the window", () => {
  it("is the exact sentence the Lar is told", () => {
    expect(WINDOW_ABOUT).toBe(
      "Your summoner's window: the body copies your thinking, your tool calls and what they returned to a channel your summoner reads, as they happen. It names where you say something, not the words. A call that names private/ is not shown, and neither is your thinking for the rest of that turn.",
    );
  });
});
