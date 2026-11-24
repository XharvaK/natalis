// Her links tool: one of her notes to another, with the relation she chose. Only her own tool call writes a link; the
// body never writes one, and a supersedes link is hers alone. Both notes must exist and be visible from this thread.

import type { Receipt, Tool } from "../contracts.js";
import { notebookPathOf } from "../notebook/git-notebook.js";
import { LINK_RELATIONS, type LinkRelation, type LinkStore } from "../river/links.js";

type Args = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; receipt: Receipt };

export type LinksToolOptions = {
  /** True when this thread sees private/ (her own thread or the summoner's place), mirroring notebookFor. */
  privateView(thread: string): boolean;
};

export function linksTools(links: LinkStore, options: LinksToolOptions): Tool[] {
  return [linkNotes(links, options), listLinks(links, options)].map((tool) => ({ ...tool, settles: true }));
}

const LIST_RECENT_LIMIT = 30;

const listLinks = (links: LinkStore, options: LinksToolOptions): Tool => ({
  spec: {
    name: "list_links",
    description:
      "List the links you made between your notes. Give a path to see only that note's links; leave it out to see your newest links.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional: the note whose links you want. Leave it out for your newest links." },
      },
    },
  },
  async run(args, context) {
    let note: string | undefined;
    if (args["path"] !== undefined) {
      const path = requireNotePath(args, "path", "The note path");
      if (!path.ok) return path.receipt;
      note = path.value;
    }
    const includePrivate = options.privateView(context.thread);
    const found = note === undefined ? links.recent(includePrivate, LIST_RECENT_LIMIT) : links.forNote(note, includePrivate);
    const summary =
      found.length === 0 ? (note === undefined ? "No links." : `No links for ${note}.`) : `${found.length} link(s).`;
    return {
      ok: true,
      summary,
      data: {
        links: found.map((link) => ({
          from: link.from,
          to: link.to,
          relation: link.relation,
          reason: link.reason,
          atMs: link.atMs,
        })),
      },
    };
  },
});

const linkNotes = (links: LinkStore, options: LinksToolOptions): Tool => ({
  spec: {
    name: "link_notes",
    description:
      "Link one of your notes to another. Say which relation you mean: supports, contradicts, supersedes or elaborates. Say why in one short line. Only you can make a link, and only you may say that one note replaces another.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Path of the first note inside your notebook." },
        to: { type: "string", description: "Path of the second note inside your notebook." },
        relation: {
          type: "string",
          enum: [...LINK_RELATIONS],
          description: "supports, contradicts, supersedes or elaborates.",
        },
        why: { type: "string", description: "Why you are linking them, in one short line." },
      },
      required: ["from", "to", "relation", "why"],
    },
  },
  async run(args: Args, context): Promise<Receipt> {
    const from = requireNotePath(args, "from", "The first note path");
    if (!from.ok) return from.receipt;
    const to = requireNotePath(args, "to", "The second note path");
    if (!to.ok) return to.receipt;
    if (from.value === to.value) {
      return refuse("bad_arguments", "A note cannot link to itself, so nothing was written.", "from and to are the same note");
    }
    for (const path of [from.value, to.value]) {
      if (path === "trash" || path.startsWith("trash/")) {
        return refuse("bad_path", "A note in the trash cannot be linked, so nothing was written.", `${path} is in the trash`);
      }
    }
    const relation = requireRelation(args["relation"]);
    if (!relation.ok) return relation.receipt;
    const why = requireText(args, "why", "The reason");
    if (!why.ok) return why.receipt;

    for (const path of [from.value, to.value]) {
      if (context.notebook.read(path) === null) {
        return refuse("not_found", `There is no note at ${path}, so nothing was written.`, `no note at ${path}`);
      }
    }

    const link = links.record({
      thread: context.thread,
      from: from.value,
      to: to.value,
      relation: relation.value,
      reason: why.value,
      private: options.privateView(context.thread),
      seq: context.river.lastSeq(),
      atMs: context.nowMs,
      author: "self",
    });
    return {
      ok: true,
      summary: `Linked ${link.from} to ${link.to} (${link.relation}).`,
      data: { id: link.id, from: link.from, to: link.to, relation: link.relation, seq: link.seq },
    };
  },
});

function requireNotePath(args: Args, key: string, label: string): Checked<string> {
  const text = requireText(args, key, label, { trim: true });
  if (!text.ok) return text;
  const path = notebookPathOf(text.value);
  if (path === undefined) {
    return {
      ok: false,
      receipt: refuse(
        "bad_path",
        "That path is not allowed in your notebook. Use a relative path such as \"people/mara.md\".",
        "path is not a notebook path",
      ),
    };
  }
  return { ok: true, value: path };
}

function requireRelation(raw: unknown): Checked<LinkRelation> {
  if (typeof raw !== "string" || !(LINK_RELATIONS as readonly string[]).includes(raw)) {
    return {
      ok: false,
      receipt: refuse(
        "bad_arguments",
        `The relation must be one of ${LINK_RELATIONS.join(", ")}, so nothing was written.`,
        "relation is not one of the four",
      ),
    };
  }
  return { ok: true, value: raw as LinkRelation };
}

function refuse(code: string, summary: string, reason: string = summary): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

function requireText(
  args: Args,
  key: string,
  label: string,
  options: { trim?: boolean } = {},
): Checked<string> {
  const raw = args[key];
  if (typeof raw !== "string") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} is missing or is not text.`, `${key} must be text`) };
  }
  const value = options.trim === true ? raw.trim() : raw;
  if (value.trim() === "") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} cannot be empty.`, `${key} is empty`) };
  }
  return { ok: true, value };
}
