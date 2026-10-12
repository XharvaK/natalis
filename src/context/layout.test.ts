import { describe, expect, it } from "vitest";
import type { ChatMessage, PromptLayoutEntry, PromptPartClass } from "../contracts.js";
import { createSecretScanner } from "../secrets/scanner.js";
import { changedBeyond, layoutRequest, partsOfMessage, type LayoutPart } from "./layout.js";

// Every credential-shaped literal is built from parts at runtime.
const OPENAI_PROJ = "s" + "k-" + "proj-" + "a".repeat(24);

/** The text each layout entry claims, sliced from the content by its offsets. */
function slices(content: string, layout: PromptLayoutEntry[]): string[] {
  let from = 0;
  return layout.map((entry) => {
    const text = content.slice(from, entry.end);
    from = entry.end;
    return text;
  });
}

const PARTS: LayoutPart[] = [
  { name: "who", cls: "fixed", text: "## who\nA Lar." },
  { name: "nature", cls: "notes", text: "## nature\nA voice." },
  { name: "recent", cls: "page", text: "Recent here:\n[10:00 owner] hi" },
  { name: "new", cls: "turn", text: "New:\n[10:01 owner] again" },
];

describe("layoutRequest", () => {
  it("puts fixed and notes parts in the system text, and page and turn parts in the user message", () => {
    const laid = layoutRequest(PARTS);

    expect(laid.system).toBe("## who\nA Lar.\n\n## nature\nA voice.");
    expect(laid.user).toBe("Recent here:\n[10:00 owner] hi\n\nNew:\n[10:01 owner] again");
    expect(laid.outOfOrder).toEqual([]);
  });

  it("records where each part ends, so each entry is exactly its own part of its message", () => {
    const laid = layoutRequest(PARTS);

    expect(laid.systemLayout.map((entry) => entry.name)).toEqual(["who", "nature"]);
    expect(laid.userLayout.map((entry) => entry.name)).toEqual(["recent", "new"]);
    expect(slices(laid.system, laid.systemLayout)).toEqual(["## who\nA Lar.", "\n\n## nature\nA voice."]);
    expect(slices(laid.user, laid.userLayout)).toEqual([
      "Recent here:\n[10:00 owner] hi",
      "\n\nNew:\n[10:01 owner] again",
    ]);
    expect(laid.systemLayout.at(-1)?.end).toBe(laid.system.length);
    expect(laid.userLayout.at(-1)?.end).toBe(laid.user.length);
  });

  it("moves a part declared after a part of a slower class into its place, and names it", () => {
    const laid = layoutRequest([
      { name: "nature", cls: "notes", text: "N" },
      { name: "who", cls: "fixed", text: "W" },
    ]);

    expect(laid.system).toBe("W\n\nN");
    expect(laid.outOfOrder).toEqual(["who"]);
  });

  it("moves a page part declared after a turn part into its place, and names it", () => {
    const laid = layoutRequest([
      { name: "new", cls: "turn", text: "New:" },
      { name: "recent", cls: "page", text: "Recent here:" },
    ]);

    expect(laid.user).toBe("Recent here:\n\nNew:");
    expect(laid.outOfOrder).toEqual(["recent"]);
  });

  it("keeps the declared order inside a class", () => {
    const laid = layoutRequest([
      { name: "b", cls: "notes", text: "B" },
      { name: "a", cls: "notes", text: "A" },
      { name: "c", cls: "fixed", text: "C" },
    ]);

    expect(laid.systemLayout.map((entry) => entry.name)).toEqual(["c", "b", "a"]);
    expect(laid.outOfOrder).toEqual(["c"]);
  });

  it("joins a part with the separator it names in place of the blank line", () => {
    const laid = layoutRequest([
      { name: "recent", cls: "page", text: "Recent here:\nrow" },
      { name: "since", cls: "turn", text: "row two", sep: "\n" },
      { name: "new", cls: "turn", text: "New:" },
    ]);

    expect(laid.user).toBe("Recent here:\nrow\nrow two\n\nNew:");
    expect(slices(laid.user, laid.userLayout)).toEqual(["Recent here:\nrow", "\nrow two", "\n\nNew:"]);
  });

  it("keeps every other part's offsets true when a secret inside one part is redacted", () => {
    const scanner = createSecretScanner();
    const parts = PARTS.map((part) =>
      part.name === "nature" ? { ...part, text: `## nature\nA voice, key ${OPENAI_PROJ}.` } : part,
    ).map((part) => ({ ...part, text: scanner.redact(part.text) }));

    const laid = layoutRequest(parts);
    const [who, nature] = slices(laid.system, laid.systemLayout);

    expect(laid.system).not.toContain(OPENAI_PROJ);
    expect(nature).toMatch(/^\n\n## nature\nA voice, key \[secret:[a-z_]+\]\.$/);
    expect(who).toBe("## who\nA Lar.");
    expect(slices(laid.user, laid.userLayout)).toEqual([
      "Recent here:\n[10:00 owner] hi",
      "\n\nNew:\n[10:01 owner] again",
    ]);
  });
});

describe("partsOfMessage", () => {
  it("gives a message with a layout its named parts, each its own slice of the content", () => {
    const message: ChatMessage = {
      role: "user",
      content: "Recent here:\nrow\n\nNew:",
      layout: [
        { name: "recent", cls: "page", end: 16 },
        { name: "new", cls: "turn", end: 22 },
      ],
    };

    expect(partsOfMessage(message)).toEqual([
      { name: "recent", cls: "page", text: "Recent here:\nrow" },
      { name: "new", cls: "turn", text: "\n\nNew:" },
    ]);
  });

  it("gives a message without a layout one part, named by its role, of class turn", () => {
    expect(partsOfMessage({ role: "user", content: "a picture note" })).toEqual([
      { name: "loop:user", cls: "turn", text: "a picture note" },
    ]);
    expect(partsOfMessage({ role: "tool", toolCallId: "c1", content: "{}" })).toEqual([
      { name: "loop:tool", cls: "turn", text: "{}" },
    ]);
    expect(
      partsOfMessage({ role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read_note", arguments: "{}" }] }),
    ).toEqual([{ name: "loop:assistant", cls: "turn", text: "\nread_note {}" }]);
  });
});

describe("changedBeyond (the class honesty check)", () => {
  it("names no part when a turn change touched only turn parts", () => {
    const second = PARTS.map((part) => (part.name === "new" ? { ...part, text: "New:\nother" } : part));

    expect(changedBeyond(toParts(PARTS), toParts(second), "turn")).toEqual([]);
  });

  it("names the slower part that a turn change touched", () => {
    const second = PARTS.map((part) => (part.name === "who" ? { ...part, text: "## who\nA different Lar." } : part));

    expect(changedBeyond(toParts(PARTS), toParts(second), "turn")).toEqual(["who"]);
  });

  it("names a part of a slower class that went missing, and only for the changes that are slower than it", () => {
    const second = PARTS.filter((part) => part.name !== "recent");

    expect(changedBeyond(toParts(PARTS), toParts(second), "page")).toEqual([]);
    expect(changedBeyond(toParts(PARTS), toParts(second), "turn")).toEqual(["recent"]);
  });
});

/** The parts of a laid-out request, as the honesty check reads them. */
function toParts(parts: LayoutPart[]): Array<{ name: string; cls: PromptPartClass; text: string }> {
  return parts.map((part) => ({ name: part.name, cls: part.cls, text: part.text }));
}
