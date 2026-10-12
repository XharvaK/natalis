// The parts of one turn's prompt, each with the class that says how often it changes. The provider reuses the start of a
// prompt it has seen, so the slow parts must come first: layoutRequest puts the parts in class order and builds the
// system text (fixed and notes) and the user message (page and turn), recording the offset where each part ends. A
// part declared after a part of a slower class is moved into place, and its name is returned so the caller can say so.

import type { ChatMessage, PromptLayoutEntry, PromptPartClass } from "../contracts.js";

export type LayoutPart = {
  name: string;
  cls: PromptPartClass;
  text: string;
  /** The text placed before this part when it is not the first of its message. Default: a blank line. */
  sep?: string;
};

export type LaidOutRequest = {
  system: string;
  systemLayout: PromptLayoutEntry[];
  user: string;
  userLayout: PromptLayoutEntry[];
  /** Parts that were declared after a part of a slower class and moved into place. Empty when the declaration is in order. */
  outOfOrder: string[];
};

/** A part of a message's text, as the cache witness and the honesty check read it. */
export type MessagePart = { name: string; cls: PromptPartClass; text: string };

/** The rank of each class: the slower a class changes, the lower its rank, and the earlier its parts come. */
export const CLASS_RANK: Readonly<Record<PromptPartClass, number>> = { fixed: 0, notes: 1, page: 2, turn: 3 };

const SYSTEM_CLASSES: ReadonlySet<PromptPartClass> = new Set<PromptPartClass>(["fixed", "notes"]);
const DEFAULT_SEP = "\n\n";

/** Builds the system text and the user message from the declared parts, in class order. */
export function layoutRequest(parts: readonly LayoutPart[]): LaidOutRequest {
  const outOfOrder: string[] = [];
  let highest = -1;
  for (const part of parts) {
    const rank = CLASS_RANK[part.cls];
    if (rank < highest) outOfOrder.push(part.name);
    highest = Math.max(highest, rank);
  }
  // A stable sort: parts of one class keep the order they were declared in.
  const ordered = [...parts].sort((a, b) => CLASS_RANK[a.cls] - CLASS_RANK[b.cls]);
  const system = join(ordered.filter((part) => SYSTEM_CLASSES.has(part.cls)));
  const user = join(ordered.filter((part) => !SYSTEM_CLASSES.has(part.cls)));
  return {
    system: system.text,
    systemLayout: system.layout,
    user: user.text,
    userLayout: user.layout,
    outOfOrder,
  };
}

function join(list: readonly LayoutPart[]): { text: string; layout: PromptLayoutEntry[] } {
  let text = "";
  const layout: PromptLayoutEntry[] = [];
  list.forEach((part, i) => {
    if (i > 0) text += part.sep ?? DEFAULT_SEP;
    text += part.text;
    layout.push({ name: part.name, cls: part.cls, end: text.length });
  });
  return { text, layout };
}

/**
 * The parts of one message. A system or user message with a layout gives its named parts: each runs from the end of the
 * part before it to its own end. Any other message is one part, named by its role, of class turn.
 */
export function partsOfMessage(message: ChatMessage): MessagePart[] {
  if ((message.role === "system" || message.role === "user") && message.layout !== undefined && message.layout.length > 0) {
    const parts: MessagePart[] = [];
    let from = 0;
    for (const entry of message.layout) {
      const end = Math.min(Math.max(entry.end, from), message.content.length);
      parts.push({ name: entry.name, cls: entry.cls, text: message.content.slice(from, end) });
      from = end;
    }
    if (from < message.content.length) parts.push({ name: "unlabelled", cls: "turn", text: message.content.slice(from) });
    return parts;
  }
  return [{ name: `loop:${message.role}`, cls: "turn", text: textOf(message) }];
}

function textOf(message: ChatMessage): string {
  switch (message.role) {
    case "system":
    case "user":
      return message.content;
    case "tool":
      return message.content;
    case "assistant": {
      const calls = (message.toolCalls ?? []).map((call) => `\n${call.name} ${call.arguments}`);
      return `${message.content ?? ""}${calls.join("")}`;
    }
  }
}

/**
 * The honesty check. For a change of class `change` between two renders, the names of the parts of a slower class that
 * changed anyway (or went missing). An empty list means the change touched only parts of its own class or faster ones.
 */
export function changedBeyond(
  before: readonly MessagePart[],
  after: readonly MessagePart[],
  change: PromptPartClass,
): string[] {
  const later = new Map(after.map((part) => [part.name, part]));
  const broken: string[] = [];
  for (const part of before) {
    if (CLASS_RANK[part.cls] >= CLASS_RANK[change]) continue;
    const now = later.get(part.name);
    if (now === undefined || now.cls !== part.cls || now.text !== part.text) broken.push(part.name);
  }
  return broken;
}
