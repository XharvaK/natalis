// Output from one command. It is capped while it is collected, so a huge output cannot eat memory, and cut to its
// head and tail for the receipt, so the Lar sees how it began and how it ended.

/** Characters of output a receipt shows for each of stdout and stderr (head and tail together). */
export const OUTPUT_CHARS = 16_000;

/** Bytes of output collected for each of stdout and stderr. Past this the command is stopped and the receipt says so. */
export const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Keeps the head and the tail of a text that is longer than `limit` characters, with the number of characters
 * left out in the middle. Never splits a surrogate pair.
 */
export function capText(text: string, limit: number = OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  let headEnd = half;
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  let tailStart = text.length - half;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const left = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n…${left} characters left out…\n${text.slice(tailStart)}`;
}

/** Collects the bytes of one output (stdout or stderr) up to a cap. */
export class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private readonly cap: number;

  constructor(cap: number = OUTPUT_CAP_BYTES) {
    this.cap = cap;
  }

  /** Adds one chunk. Returns false once the total is over the cap; the chunk that crosses it is not kept. */
  push(chunk: Buffer): boolean {
    this.total += chunk.length;
    if (this.total > this.cap) return false;
    this.chunks.push(chunk);
    return true;
  }

  /** The collected text, decoded as UTF-8 and capped for a receipt. */
  text(): string {
    return capText(Buffer.concat(this.chunks).toString("utf8"));
  }
}
