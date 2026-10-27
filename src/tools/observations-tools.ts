// Her observation tool: record_observation writes one dated observation in her own words about a span of her river,
// keyed by the first and last row. The body never composes an observation. Every row in the span must exist, must not
// be forgotten, and must be shown in this thread.

import type { Receipt, RiverRow, Tool, ToolContext } from "../contracts.js";
import type { ObservationStore } from "../river/observations.js";

type Args = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; receipt: Receipt };

export type ObservationsToolOptions = {
  /** True when this row is shown in this thread (the runtime's hiddenHere rule). */
  visible(row: RiverRow, thread: string): boolean;
};

export function observationsTools(observations: ObservationStore, options: ObservationsToolOptions): Tool[] {
  return [recordObservation(observations, options)].map((tool) => ({ ...tool, settles: true }));
}

const recordObservation = (observations: ObservationStore, options: ObservationsToolOptions): Tool => ({
  spec: {
    name: "record_observation",
    description:
      "Write down an observation in your own words about a span of your river. Give the first and last row of the span. Only your words and those two row numbers are stored. This tool is offered in your quiet turns, not in a live turn.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The observation, in your own words." },
        start_seq: { type: "integer", minimum: 1, description: "The first row of the span." },
        end_seq: { type: "integer", minimum: 1, description: "The last row of the span." },
      },
      required: ["text", "start_seq", "end_seq"],
    },
  },
  async run(args: Args, context: ToolContext): Promise<Receipt> {
    const text = requireText(args, "text", "The observation");
    if (!text.ok) return text.receipt;
    const start = requireSeq(args["start_seq"], "start_seq", "The first row of the span");
    if (!start.ok) return start.receipt;
    const end = requireSeq(args["end_seq"], "end_seq", "The last row of the span");
    if (!end.ok) return end.receipt;
    if (start.value > end.value) {
      return refuse(
        "bad_arguments",
        "The first row of the span is after the last row, so nothing was written.",
        "start_seq is after end_seq",
      );
    }

    const spanLength = end.value - start.value + 1;
    const span = context.river.read({ sinceSeq: start.value - 1, untilSeq: end.value, limit: spanLength });
    if (span.length !== spanLength) {
      return refuse(
        "not_found",
        `The span from row ${start.value} to row ${end.value} is not complete, so nothing was written.`,
        "a row in the span is missing",
      );
    }
    for (const row of span) {
      if (isForgottenRow(row)) {
        return refuse(
          "forgotten",
          `Row ${row.seq} in the span was forgotten, so nothing was written.`,
          `river row ${row.seq} is forgotten`,
        );
      }
      if (!options.visible(row, context.thread)) {
        return refuse(
          "not_visible",
          `Row ${row.seq} in the span is not shown in this thread, so nothing was written.`,
          `river row ${row.seq} is hidden from this thread`,
        );
      }
    }

    const observation = observations.record({
      thread: context.thread,
      text: text.value,
      startSeq: start.value,
      endSeq: end.value,
      atMs: context.nowMs,
    });
    return {
      ok: true,
      summary: `Recorded observation ${observation.id}.`,
      data: { id: observation.id, start_seq: observation.startSeq, end_seq: observation.endSeq },
    };
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

function requireSeq(raw: unknown, key: string, label: string): Checked<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      receipt: refuse("bad_arguments", `${label} must be a whole number, starting at 1.`, `${key} must be a positive integer`),
    };
  }
  return { ok: true, value: raw };
}
