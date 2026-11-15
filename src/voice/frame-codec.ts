// The organ's frame: a 4-byte big-endian header length, the header as one JSON object, a 4-byte big-endian body
// length, then the body. The organ's protocol is in organ/PROTOCOL.md.

/** A header is at most 1 MiB. */
export const HEADER_MAX = 1024 * 1024;
/** A body is at most 64 MiB. */
export const BODY_MAX = 64 * 1024 * 1024;

/** One frame: its parsed header and its raw body. */
export type Frame = { header: Record<string, unknown>; body: Uint8Array };

/** A frame that is too large or whose header is not a JSON object. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

function headerTooLarge(bytes: number): FrameError {
  return new FrameError(`a header of ${bytes} bytes is larger than 1 MiB`);
}

function bodyTooLarge(bytes: number): FrameError {
  return new FrameError(`a body of ${bytes} bytes is larger than 64 MiB`);
}

/** Makes one frame. Throws FrameError when the header or the body is too large. */
export function encodeFrame(header: Record<string, unknown>, body?: Uint8Array): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(header);
  } catch {
    throw new FrameError("a header is not JSON");
  }
  if (json === undefined) throw new FrameError("a header is not JSON");

  const headerLength = Buffer.byteLength(json, "utf8");
  if (headerLength > HEADER_MAX) throw headerTooLarge(headerLength);

  // A length check first, so an object that only reports a huge byteLength is refused without allocating it.
  const bodyLength = Math.max(body?.byteLength ?? 0, body?.length ?? 0);
  if (bodyLength > BODY_MAX) throw bodyTooLarge(bodyLength);

  const headerBytes = Buffer.from(json, "utf8");
  const bytes = body ?? new Uint8Array(0);
  const frame = Buffer.allocUnsafe(8 + headerLength + bodyLength);
  frame.writeUInt32BE(headerLength, 0);
  headerBytes.copy(frame, 4);
  frame.writeUInt32BE(bodyLength, 4 + headerLength);
  frame.set(bytes, 8 + headerLength);
  return frame;
}

/**
 * Accepts stdout in chunks and returns the frames they complete. Bytes that do not yet make a whole frame stay
 * buffered. The buffer is kept as a list of chunks and only joined when a whole frame is present, so a large body
 * arriving in small pieces is not copied on every push.
 */
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private total = 0;

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    }

    const frames: Frame[] = [];
    for (;;) {
      if (this.total < 4) break;
      const headerLength = this.readUInt32BE(0);
      if (headerLength > HEADER_MAX) throw headerTooLarge(headerLength);
      // The header, then the body's 4-byte length.
      if (this.total < 8 + headerLength) break;
      const bodyLength = this.readUInt32BE(4 + headerLength);
      if (bodyLength > BODY_MAX) throw bodyTooLarge(bodyLength);
      const frameLength = 8 + headerLength + bodyLength;
      if (this.total < frameLength) break;

      const bytes = this.join();
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes.subarray(4, 4 + headerLength)).toString("utf8"));
      } catch {
        throw new FrameError("a header is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FrameError("a header is not a JSON object");
      }

      // The body is copied: later pushes must never rewrite memory a caller already holds.
      const body = Uint8Array.from(bytes.subarray(8 + headerLength, frameLength));
      frames.push({ header: parsed as Record<string, unknown>, body });

      const rest = bytes.subarray(frameLength);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
    }
    return frames;
  }

  /** Joins the buffered chunks once a whole frame is present. */
  private join(): Uint8Array {
    const first = this.chunks[0];
    if (this.chunks.length === 1 && first !== undefined) return first;
    const joined = new Uint8Array(this.total);
    let at = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [joined];
    return joined;
  }

  private readUInt32BE(offset: number): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) value = value * 256 + this.byteAt(offset + i);
    return value;
  }

  private byteAt(offset: number): number {
    let at = offset;
    for (const chunk of this.chunks) {
      if (at < chunk.length) return chunk[at] ?? 0;
      at -= chunk.length;
    }
    throw new Error("the frame decoder read past its buffer");
  }
}
