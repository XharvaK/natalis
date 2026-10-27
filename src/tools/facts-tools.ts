// Her facts tools: record_fact writes one fact in her own words with the river rows she cites; close_fact adds the row
// that ends a fact. Neither tool has a candidate field, and neither writes model-made text. Every cited row must exist,
// must not be forgotten, and must be visible from the thread where she records the fact (C3, the recall visibility rule).

import type { Receipt, RiverRow, Tool, ToolContext } from "../contracts.js";
import type { FactStore } from "../river/facts.js";

const FACTS_SEQS_MAX = 20;

type Args = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; receipt: Receipt };

export type FactsToolOptions = {
  /** True when this row is shown in this thread (the runtime's hiddenHere rule). */
  visible(row: RiverRow, thread: string): boolean;
  /** True when this thread sees private/ (her own thread or the summoner's place). */
  privateView(thread: string): boolean;
};

export function factsTools(facts: FactStore, options: FactsToolOptions): Tool[] {
  return [recordFact(facts, options), closeFact(facts)].map((tool) => ({ ...tool, settles: true }));
}

const recordFact = (facts: FactStore, options: FactsToolOptions): Tool => ({
  spec: {
    name: "record_fact",
    description:
      "Record a fact in your own words, and cite the river rows it came from. Only your words and those row numbers are stored. The rows must exist, must not be forgotten, and must be shown in this thread. Closing an old fact is close_fact's job; a fact you record is not edited later.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, in your own words." },
        seqs: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 1,
          maxItems: FACTS_SEQS_MAX,
          description: `The river row numbers this fact comes from, from 1 to ${FACTS_SEQS_MAX} of them.`,
        },
      },
      required: ["text", "seqs"],
    },
  },
  async run(args: Args, context: ToolContext): Promise<Receipt> {
    const text = requireText(args, "text", "The fact");
    if (!text.ok) return text.receipt;
    const seqs = requireSeqs(args["seqs"]);
    if (!seqs.ok) return seqs.receipt;

    for (const seq of seqs.value) {
      const [row] = context.river.read({ sinceSeq: seq - 1, untilSeq: seq, limit: 1 });
      if (row === undefined) {
        return refuse("not_found", `There is no row ${seq}, so nothing was recorded.`, `no river row ${seq}`);
      }
      if (isForgottenRow(row)) {
        return refuse("forgotten", `Row ${seq} was forgotten, so nothing was recorded.`, `river row ${seq} is forgotten`);
      }
      if (!options.visible(row, context.thread)) {
        return refuse(
          "not_visible",
          `Row ${seq} is not shown in this thread, so nothing was recorded.`,
          `river row ${seq} is hidden from this thread`,
        );
      }
    }

    const fact = facts.record({
      thread: context.thread,
      text: text.value,
      seqs: seqs.value,
      private: options.privateView(context.thread),
      validFromSeq: context.river.lastSeq(),
      atMs: context.nowMs,
    });
    return { ok: true, summary: `Recorded fact ${fact.id}.`, data: { id: fact.id, seqs: fact.sourceSeqs } };
  },
});

const closeFact = (facts: FactStore): Tool => ({
  spec: {
    name: "close_fact",
    description:
      "Close a fact you recorded, because it is no longer true or no longer yours to keep. Give its id from your facts section. Closing writes a new row; the old fact is not edited.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "The id of the fact to close." },
      },
      required: ["id"],
    },
  },
  async run(args: Args, context: ToolContext): Promise<Receipt> {
    const id = requireId(args["id"]);
    if (!id.ok) return id.receipt;
    const existing = facts.get(id.value);
    if (existing === undefined || existing.closed) {
      return refuse("not_found", `There is no open fact ${id.value}, so nothing was closed.`, `no open fact ${id.value}`);
    }
    if (existing.forgotten) {
      return refuse("forgotten", `Fact ${id.value} was forgotten, so nothing was closed.`, `fact ${id.value} is forgotten`);
    }
    facts.closeFact(id.value, { thread: context.thread, atMs: context.nowMs, validToSeq: context.river.lastSeq() });
    return { ok: true, summary: `Closed fact ${id.value}.`, data: { id: id.value } };
  },
});

function isForgottenRow(row: RiverRow): boolean {
  if (row.kind === "tombstone") return true;
  const forgotten = (row as { forgotten?: unknown }).forgotten;
  if (typeof forgotten === "boolean") return forgotten;
  return row.text === undefined && row.data === undefined;
}

function refuse(code: string, summary: string, reason: string = summary): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

function requireText(args: Args, key: string, label: string): Checked<string> {
  const raw = args[key];
  if (typeof raw !== "string") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} is missing or is not text.`, `${key} must be text`) };
  }
  if (raw.trim() === "") {
    return { ok: false, receipt: refuse("bad_arguments", `${label} cannot be empty.`, `${key} is empty`) };
  }
  return { ok: true, value: raw };
}

function requireSeqs(raw: unknown): Checked<number[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", "Give at least one row number the fact comes from.", "seqs must be a non-empty list"),
    };
  }
  if (raw.length > FACTS_SEQS_MAX) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", `Give at most ${FACTS_SEQS_MAX} row numbers at a time.`, "seqs too long"),
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
    if (!seqs.includes(item)) seqs.push(item);
  }
  return { ok: true, value: seqs };
}

function requireId(raw: unknown): Checked<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", "The fact id must be a whole number, starting at 1.", "id must be a positive integer"),
    };
  }
  return { ok: true, value: raw };
}
