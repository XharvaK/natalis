// The core memory tools: your notebook (plain notes kept with git) and your river (what has happened to you).
// Each tool checks its own arguments and answers with a receipt in plain words. A refused act says why.
// Notebook writes are attributed to "thread:<thread>" with the reason you gave.

import { NotebookError, type Notebook, type Receipt, type Tool, type ToolContext } from "../contracts.js";
import { protectedNoteReason } from "../entity/commitments.js";

const READ_LIMIT = 20_000;
const RECALL_DEFAULT = 10;
const RECALL_MAX = 20;
const HIT_TEXT_LIMIT = 1_000;
const LIST_LIMIT = 200;
const FORGET_SEQS_MAX = 200;

type Args = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; receipt: Receipt };

export function notebookTools(): Tool[] {
  // Notebook calls are local and short: after a turn deadline they are let finish, so a retry never repeats a write.
  return [
    readNote,
    writeNote,
    editNote,
    appendNote,
    listNotes,
    trashNote,
    recall,
    forget,
  ].map((tool) => ({ ...tool, settles: true }));
}

const readNote: Tool = {
  spec: {
    name: "read_note",
    description: "Read one of your notes. Give the path it is kept at, for example \"people/mara.md\".",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path of the note inside your notebook." } },
      required: ["path"],
    },
  },
  async run(args, context) {
    const path = requireText(args, "path", "The note path", { trim: true });
    if (!path.ok) return path.receipt;
    return guarded(async () => {
      const body = context.notebook.read(path.value);
      if (body === null) return refuse("not_found", "There is no note at that path.");
      const truncated = body.length > READ_LIMIT;
      const text = truncated
        ? `${body.slice(0, READ_LIMIT)}\n\n[Truncated: the note has ${body.length} characters; the first ${READ_LIMIT} are shown.]`
        : body;
      return {
        ok: true,
        summary: `Read ${path.value}.`,
        data: { path: path.value, text, chars: body.length, truncated },
      };
    });
  },
};

const writeNote: Tool = {
  spec: {
    name: "write_note",
    description:
      "Write a whole note, creating it or replacing what is there. Say why in one short line; the reason is kept with the change. A note whose first line is \"triggers: word, word\" is shown to you whenever a new message uses one of those words.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the note inside your notebook." },
        text: { type: "string", description: "The whole text of the note." },
        why: { type: "string", description: "Why you are writing it, in one short line." },
      },
      required: ["path", "text", "why"],
    },
  },
  async run(args, context) {
    const path = requireText(args, "path", "The note path", { trim: true });
    if (!path.ok) return path.receipt;
    const held = protectedRefusal(path.value);
    if (held !== undefined) return held;
    const text = requireText(args, "text", "The note text", { allowEmpty: true });
    if (!text.ok) return text.receipt;
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;
    const full = capRefusal(path.value, context.notebook.read(path.value), text.value.length);
    if (full !== undefined) return full;
    return guarded(async () => {
      await context.notebook.write(path.value, text.value, why.value, authorOf(context));
      return { ok: true, summary: `Wrote ${path.value}.`, data: { path: path.value, chars: text.value.length } };
    });
  },
};

const editNote: Tool = {
  spec: {
    name: "edit_note",
    description:
      "Change one passage in a note. The text to find must appear exactly once in the note; if it appears more than once, use a longer piece.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the note inside your notebook." },
        find: { type: "string", description: "The exact text to replace." },
        replace: { type: "string", description: "What to put in its place. May be empty." },
        why: { type: "string", description: "Why you are changing it, in one short line." },
      },
      required: ["path", "find", "replace", "why"],
    },
  },
  async run(args, context) {
    const path = requireText(args, "path", "The note path", { trim: true });
    if (!path.ok) return path.receipt;
    const held = protectedRefusal(path.value);
    if (held !== undefined) return held;
    const find = requireText(args, "find", "The text to find");
    if (!find.ok) return find.receipt;
    const replace = requireText(args, "replace", "The replacement text", { allowEmpty: true });
    if (!replace.ok) return replace.receipt;
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;
    const current = CORE_NOTE_CAPS[path.value] === undefined ? null : context.notebook.read(path.value);
    if (current !== null && current.includes(find.value)) {
      const full = capRefusal(path.value, current, current.length - find.value.length + replace.value.length);
      if (full !== undefined) return full;
    }
    return guarded(
      async () => {
        await context.notebook.edit(path.value, find.value, replace.value, why.value, authorOf(context));
        return { ok: true, summary: `Changed one passage in ${path.value}.`, data: { path: path.value } };
      },
      {
        not_found: "I could not find that text in the note. Read the note again and copy the exact wording.",
        ambiguous: "That text appears more than once in the note. Use a longer piece so it is unique.",
      },
    );
  },
};

const appendNote: Tool = {
  spec: {
    name: "append_note",
    description: "Add text to the end of a note. The note is created if it does not exist yet.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the note inside your notebook." },
        text: { type: "string", description: "The text to add at the end." },
        why: { type: "string", description: "Why you are adding it, in one short line." },
      },
      required: ["path", "text", "why"],
    },
  },
  async run(args, context) {
    const path = requireText(args, "path", "The note path", { trim: true });
    if (!path.ok) return path.receipt;
    const held = protectedRefusal(path.value);
    if (held !== undefined) return held;
    const text = requireText(args, "text", "The text to add", { allowEmpty: true });
    if (!text.ok) return text.receipt;
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;
    if (CORE_NOTE_CAPS[path.value] !== undefined) {
      const current = context.notebook.read(path.value);
      // An append may add one line break before the text.
      const full = capRefusal(path.value, current, (current?.length ?? 0) + text.value.length + 1);
      if (full !== undefined) return full;
    }
    return guarded(async () => {
      await context.notebook.append(path.value, text.value, why.value, authorOf(context));
      return { ok: true, summary: `Added to ${path.value}.`, data: { path: path.value, chars: text.value.length } };
    });
  },
};

const listNotes: Tool = {
  spec: {
    name: "list_notes",
    description: "List the notes in your notebook, or only those inside one folder such as \"people\".",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "Optional folder inside your notebook." } },
    },
  },
  async run(args, context) {
    const dir = optionalText(args, "dir", "The folder", { trim: true });
    if (!dir.ok) return dir.receipt;
    const folder = dir.value === undefined || dir.value === "" ? undefined : dir.value;
    return guarded(async () => {
      const entries = context.notebook.list(folder);
      const shown = entries.slice(0, LIST_LIMIT).map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        modified: new Date(entry.modifiedMs).toISOString(),
        firstLine: entry.firstLine,
      }));
      const where = folder === undefined ? "" : ` in ${folder}`;
      const summary =
        entries.length === 0 ? `There are no notes${where}.` : `Found ${entries.length} note(s)${where}.`;
      return {
        ok: true,
        summary,
        data: { entries: shown, truncated: entries.length > LIST_LIMIT },
      };
    });
  },
};

const trashNote: Tool = {
  spec: {
    name: "trash_note",
    description:
      "Move a note to your trash. Nothing is deleted for good, so the note can be brought back later. Say why in one short line.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the note inside your notebook." },
        why: { type: "string", description: "Why you are moving it, in one short line." },
      },
      required: ["path", "why"],
    },
  },
  async run(args, context) {
    const path = requireText(args, "path", "The note path", { trim: true });
    if (!path.ok) return path.receipt;
    const held = protectedRefusal(path.value);
    if (held !== undefined) return held;
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;
    return guarded(async () => {
      await context.notebook.remove(path.value, why.value, authorOf(context));
      return { ok: true, summary: `Moved ${path.value} to the trash.`, data: { path: path.value } };
    });
  },
};

const recall: Tool = {
  spec: {
    name: "recall",
    description: `Search what has happened to you (your river) and your notebook for some words. You get up to ${RECALL_MAX} matches, mixed from both.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The words to look for. Not case-sensitive." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: RECALL_MAX,
          description: `How many matches to return, from 1 to ${RECALL_MAX}. Default ${RECALL_DEFAULT}.`,
        },
      },
      required: ["query"],
    },
  },
  async run(args, context) {
    const query = requireText(args, "query", "The words to look for", { trim: true });
    if (!query.ok) return query.receipt;
    const limit = optionalInteger(args, "limit", RECALL_DEFAULT, 1, RECALL_MAX);
    if (!limit.ok) return limit.receipt;
    return guarded(async () => {
      const riverRows = context.river
        .search(query.value, { limit: RECALL_MAX })
        .map((hit) => hit.row)
        .sort((a, b) => b.seq - a.seq);
      const noteLines = searchNotebookWords(context.notebook, query.value);

      // Round-robin: newest river rows and notebook lines take turns, so neither crowds out the other.
      const hits: Array<Record<string, unknown>> = [];
      let r = 0;
      let n = 0;
      while (hits.length < limit.value && (r < riverRows.length || n < noteLines.length)) {
        const row = riverRows[r];
        if (row !== undefined) {
          hits.push({
            from: "river",
            seq: row.seq,
            when: new Date(row.atMs).toISOString(),
            thread: row.thread,
            text: clip(row.text ?? ""),
          });
          r += 1;
        }
        const line = noteLines[n];
        if (hits.length < limit.value && line !== undefined) {
          hits.push({ from: "notebook", path: line.path, line: line.line, text: clip(line.text) });
          n += 1;
        }
      }

      const summary =
        hits.length === 0
          ? `Nothing matched "${query.value}".`
          : `Found ${hits.length} match(es) for "${query.value}".`;
      return { ok: true, summary, data: { query: query.value, hits } };
    });
  },
};

// A query is usually a few words, not a phrase that sits on one line. Lines are ranked by how many of the words
// they hold; the whole phrase, when a line has it, counts as every word.
function searchNotebookWords(notebook: Notebook, query: string): Array<{ path: string; line: number; text: string }> {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter((word) => word.length > 0))];
  const scored = new Map<string, { hit: { path: string; line: number; text: string }; score: number }>();
  const add = (hits: Array<{ path: string; line: number; text: string }>, points: number) => {
    for (const hit of hits) {
      const key = `${hit.path}:${hit.line}`;
      const seen = scored.get(key);
      if (seen === undefined) scored.set(key, { hit, score: points });
      else seen.score += points;
    }
  };
  add(notebook.search(query, RECALL_MAX), words.length);
  if (words.length > 1) for (const word of words) add(notebook.search(word, RECALL_MAX * 4), 1);
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_MAX)
    .map((entry) => entry.hit);
}

const forget: Tool = {
  spec: {
    name: "forget",
    description:
      "Erase rows from your river: either the rows that contain some words, or the rows with the given numbers (seqs). Erased rows are gone for good; a tombstone marks where they were. Say why in one short line.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words; every row whose text contains them is erased." },
        seqs: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "The row numbers to erase.",
        },
        why: { type: "string", description: "Why you are erasing them, in one short line." },
      },
      required: ["why"],
    },
  },
  async run(args, context) {
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;
    const hasQuery = args["query"] !== undefined;
    const hasSeqs = args["seqs"] !== undefined;
    if (hasQuery === hasSeqs) {
      return refuse(
        "bad_arguments",
        "Give either some words to forget or a list of row numbers, not both and not neither.",
      );
    }

    let match: { text: string } | { seqs: number[] };
    if (hasQuery) {
      const query = requireText(args, "query", "The words to forget", { trim: true });
      if (!query.ok) return query.receipt;
      match = { text: query.value };
    } else {
      const seqs = requireSeqs(args["seqs"]);
      if (!seqs.ok) return seqs.receipt;
      match = { seqs: seqs.value };
    }

    return guarded(async () => {
      const erased = context.river.forget(match, "self", why.value);
      if (erased === 0) {
        return { ok: true, summary: "Nothing matched, so nothing was forgotten.", data: { erased: 0 } };
      }
      return {
        ok: true,
        summary: `Forgot ${erased} row(s) from your river.`,
        data: { erased },
      };
    });
  },
};

// ---------------------------------------------------------------------------------------------------
// Helpers

function authorOf(context: ToolContext): string {
  return `thread:${context.thread}`;
}

/** The refusal for a note only the body may change, or undefined when the Lar may change it. */
/**
 * Size caps on the core self notes that are always in her context. A change that would make one longer than its cap is
 * refused; a change that leaves it no longer is allowed, so a note already over the cap can still be trimmed.
 */
export const CORE_NOTE_CAPS: Readonly<Record<string, number>> = { "self/character.md": 8000, "self/life.md": 8000 };

function capRefusal(path: string, before: string | null, after: number): Receipt | undefined {
  const cap = CORE_NOTE_CAPS[path];
  if (cap === undefined || after <= cap || after <= (before?.length ?? 0)) return undefined;
  return refuse(
    "core_note_full",
    `${path} would be ${after} characters, over its cap of ${cap}, so nothing was changed.`,
    `${path} is always in your context and is capped at ${cap} characters. Shorten it, or move detail into another note.`,
  );
}

function protectedRefusal(path: string): Receipt | undefined {
  const reason = protectedNoteReason(path);
  return reason === undefined ? undefined : refuse("protected", reason, reason);
}

function refuse(code: string, summary: string, reason: string = summary): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

/** Runs a notebook act; a NotebookError becomes a plain refusal. Other errors go to the loop as tool errors. */
async function guarded(
  act: () => Promise<Receipt>,
  overrides: Partial<Record<NotebookError["kind"], string>> = {},
): Promise<Receipt> {
  try {
    return await act();
  } catch (err) {
    if (!(err instanceof NotebookError)) throw err;
    const summary = overrides[err.kind] ?? NOTEBOOK_SUMMARY[err.kind];
    return refuse(err.kind, summary, err.message);
  }
}

const NOTEBOOK_SUMMARY: Record<NotebookError["kind"], string> = {
  bad_path: "That path is not allowed in your notebook. Use a relative path such as \"people/mara.md\".",
  not_found: "There is no note at that path.",
  ambiguous: "That text appears more than once in the note.",
  private: "That note is private, so it cannot be changed here.",
  io: "The notebook could not save that. Try again.",
};

function requireText(
  args: Args,
  key: string,
  label: string,
  options: { trim?: boolean; allowEmpty?: boolean } = {},
): Checked<string> {
  const raw = args[key];
  if (typeof raw !== "string") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} is missing or is not text.`, `${key} must be text`) };
  }
  const value = options.trim === true ? raw.trim() : raw;
  if (!options.allowEmpty && value.trim() === "") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} cannot be empty.`, `${key} is empty`) };
  }
  return { ok: true, value };
}

function optionalText(
  args: Args,
  key: string,
  label: string,
  options: { trim?: boolean } = {},
): Checked<string | undefined> {
  if (args[key] === undefined) return { ok: true, value: undefined };
  const checked = requireText(args, key, label, { ...options, allowEmpty: true });
  return checked.ok ? { ok: true, value: checked.value } : checked;
}

function optionalInteger(args: Args, key: string, fallback: number, min: number, max: number): Checked<number> {
  const raw = args[key];
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", `The limit must be a whole number from ${min} to ${max}.`, `limit out of range`),
    };
  }
  return { ok: true, value: raw };
}

function requireSeqs(raw: unknown): Checked<number[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, receipt: refuse("bad_arguments", "Give at least one row number.", "seqs must be a non-empty list") };
  }
  if (raw.length > FORGET_SEQS_MAX) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", `Give at most ${FORGET_SEQS_MAX} row numbers at a time.`, "seqs too long"),
    };
  }
  const seqs: number[] = [];
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1) {
      return {
        ok: false,
        receipt: refuse("bad_arguments", "Row numbers must be whole numbers, starting at 1.", "seqs must be positive integers"),
      };
    }
    seqs.push(item);
  }
  return { ok: true, value: seqs };
}

function clip(text: string): string {
  return text.length > HIT_TEXT_LIMIT ? `${text.slice(0, HIT_TEXT_LIMIT)}...` : text;
}
