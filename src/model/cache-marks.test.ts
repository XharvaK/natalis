import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../contracts.js";
import { markCount, markedTextParts, markPlan } from "./cache-marks.js";

const SYSTEM = "## who\nA Lar.\n\n## nature\nA voice.";
const USER = "Recent here:\nrow one\n\nNew:\nrow two";

function turnMessages(): ChatMessage[] {
  return [
    {
      role: "system",
      content: SYSTEM,
      layout: [
        { name: "who", cls: "fixed", end: 9 },
        { name: "nature", cls: "notes", end: SYSTEM.length },
      ],
    },
    {
      role: "user",
      content: USER,
      layout: [
        { name: "recent", cls: "page", end: 22 },
        { name: "new", cls: "turn", end: USER.length },
      ],
    },
  ];
}

describe("markPlan", () => {
  it("marks the end of the system text and the end of the page part, and nothing else in the middle of a turn", () => {
    const plan = markPlan(turnMessages());

    expect(plan[0]).toEqual([SYSTEM.length]);
    // The user message is the last message, so its end is marked too; the page end is the other mark.
    expect(plan[1]).toEqual([22, USER.length]);
  });

  it("moves the last-message mark to the last message of the request", () => {
    const messages: ChatMessage[] = [
      ...turnMessages(),
      { role: "assistant", content: "Reading.", toolCalls: [{ id: "c1", name: "read_note", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "{\"ok\":true}" },
    ];
    const plan = markPlan(messages);

    expect(plan[1]).toEqual([22]);
    expect(plan[2]).toEqual([]);
    expect(plan[3]).toEqual(["{\"ok\":true}".length]);
  });

  it("gives no mark to an assistant message with no text, and never a mark at zero", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "", layout: [] },
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read_note", arguments: "{}" }] },
    ];

    expect(markPlan(messages)).toEqual([[], []]);
  });

  it("counts at most three marks for a turn's request", () => {
    expect(markCount(turnMessages())).toBe(3);
  });
});

describe("markedTextParts", () => {
  it("ends a part at each mark and puts the rest in a part of its own", () => {
    expect(markedTextParts("abcdef", [2, 4])).toEqual([
      { type: "text", text: "ab", cache_control: { type: "ephemeral" } },
      { type: "text", text: "cd", cache_control: { type: "ephemeral" } },
      { type: "text", text: "ef" },
    ]);
  });

  it("has no part for empty text, and no empty part after a mark at the end", () => {
    expect(markedTextParts("", [])).toEqual([]);
    expect(markedTextParts("abc", [3])).toEqual([{ type: "text", text: "abc", cache_control: { type: "ephemeral" } }]);
  });
});
