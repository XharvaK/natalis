// Provider cache marks: where a request's text ends a part the provider should keep. The marks are the end of the system
// text, the end of the page part of the user message, and the end of the request's last message, which moves with each
// call of a turn so the turn's own tool loop is cached. That is three at most (a provider allows four). The adapter
// sends them when cacheMarks is on, and the witness counts the same ones, so both read this one plan.

import type { ChatMessage } from "../contracts.js";

/** For each message of a request, the content offsets where a mark ends: ascending, unique, and never zero. */
export function markPlan(messages: readonly ChatMessage[]): number[][] {
  return messages.map((message, index) => {
    const marks = new Set<number>();
    if (message.role === "system") marks.add(message.content.length);
    if (message.role === "user" && message.layout !== undefined) {
      const page = message.layout.filter((entry) => entry.cls === "page").at(-1);
      if (page !== undefined) marks.add(page.end);
    }
    if (index === messages.length - 1 && hasText(message)) marks.add(textOf(message).length);
    return [...marks].filter((end) => end > 0).sort((a, b) => a - b);
  });
}

/** How many marks a request carries in all. */
export function markCount(messages: readonly ChatMessage[]): number {
  return markPlan(messages).reduce((total, marks) => total + marks.length, 0);
}

/**
 * The text as wire text parts: each mark ends a part with cache_control, and whatever follows the last mark is a part of
 * its own without one. Empty text has no parts, so the caller sends it as a plain empty string.
 */
export function markedTextParts(text: string, marks: readonly number[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  let from = 0;
  for (const end of marks) {
    if (end <= from || end > text.length) continue;
    parts.push({ type: "text", text: text.slice(from, end), cache_control: { type: "ephemeral" } });
    from = end;
  }
  if (from < text.length) parts.push({ type: "text", text: text.slice(from) });
  return parts;
}

function hasText(message: ChatMessage): boolean {
  return textOf(message).length > 0;
}

/** The text a message puts on the wire as its content (an assistant's tool calls are not text and are not counted). */
function textOf(message: ChatMessage): string {
  if (message.role === "assistant") return message.content ?? "";
  return message.content;
}
