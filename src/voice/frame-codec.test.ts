import { describe, expect, it } from "vitest";
import { BODY_MAX, encodeFrame, type Frame, FrameDecoder, FrameError, HEADER_MAX } from "./frame-codec.js";

function frameBytes(header: unknown, body: Uint8Array = new Uint8Array(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frame = Buffer.alloc(8 + headerBytes.length + body.length);
  frame.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(frame, 4);
  frame.writeUInt32BE(body.length, 4 + headerBytes.length);
  frame.set(body, 8 + headerBytes.length);
  return frame;
}

describe("encodeFrame", () => {
  it("round trips an empty body and a 100 KB body", () => {
    for (const body of [new Uint8Array(0), Uint8Array.from({ length: 100 * 1024 }, (_, i) => i % 251)]) {
      const bytes = encodeFrame({ op: "echo", id: 3 }, body);
      const frames = new FrameDecoder().push(bytes);
      expect(frames).toHaveLength(1);
      expect(frames[0]?.header).toEqual({ op: "echo", id: 3 });
      expect(Buffer.from(frames[0]?.body ?? [])).toEqual(Buffer.from(body));
    }
  });

  it("refuses a header over 1 MiB", () => {
    expect(() => encodeFrame({ text: "x".repeat(HEADER_MAX) })).toThrow(FrameError);
    expect(() => encodeFrame({ text: "x".repeat(HEADER_MAX) })).toThrow(/a header of \d+ bytes is larger than 1 MiB/);
  });

  it("refuses a body over 64 MiB without allocating it", () => {
    const huge = { byteLength: BODY_MAX + 1, length: BODY_MAX + 1 } as unknown as Uint8Array;
    expect(() => encodeFrame({ op: "echo" }, huge)).toThrow(FrameError);
    expect(() => encodeFrame({ op: "echo" }, huge)).toThrow(
      `a body of ${BODY_MAX + 1} bytes is larger than 64 MiB`,
    );
  });
});

describe("FrameDecoder", () => {
  it("returns two frames that arrive in one chunk", () => {
    const one = encodeFrame({ op: "ping", id: 1 });
    const two = encodeFrame({ op: "pong", id: 2 }, Uint8Array.from([1, 2, 3]));
    const frames = new FrameDecoder().push(Buffer.concat([one, two]));
    expect(frames.map((frame) => frame.header)).toEqual([
      { op: "ping", id: 1 },
      { op: "pong", id: 2 },
    ]);
    expect(Buffer.from(frames[1]?.body ?? [])).toEqual(Buffer.from([1, 2, 3]));
  });

  it("accepts one frame pushed one byte at a time", () => {
    const bytes = encodeFrame({ op: "echo", id: 7 }, Uint8Array.from([9, 8, 7, 6, 5]));
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    for (const byte of bytes) frames.push(...decoder.push(Uint8Array.of(byte)));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header).toEqual({ op: "echo", id: 7 });
    expect(Buffer.from(frames[0]?.body ?? [])).toEqual(Buffer.from([9, 8, 7, 6, 5]));
  });

  it("keeps a partial frame's bytes for the next push", () => {
    const bytes = encodeFrame({ op: "echo", id: 1 }, Uint8Array.from([4, 5, 6]));
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
    expect(decoder.push(bytes.subarray(5, 10))).toEqual([]);
    const frames = decoder.push(bytes.subarray(10));
    expect(frames).toHaveLength(1);
    expect(Buffer.from(frames[0]?.body ?? [])).toEqual(Buffer.from([4, 5, 6]));
  });

  it("hands out a body that later pushes cannot overwrite", () => {
    const source = Buffer.from(encodeFrame({ op: "echo" }, Uint8Array.from([1, 2, 3, 4])));
    const decoder = new FrameDecoder();
    const frames = decoder.push(source);
    source.fill(0);
    decoder.push(encodeFrame({ op: "ping", id: 2 }));
    expect(Buffer.from(frames[0]?.body ?? [])).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects a header length over 1 MiB", () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(HEADER_MAX + 1, 0);
    expect(() => new FrameDecoder().push(bytes)).toThrow(
      `a header of ${HEADER_MAX + 1} bytes is larger than 1 MiB`,
    );
  });

  it("rejects a body length over 64 MiB", () => {
    const bytes = frameBytes({ op: "packets" });
    bytes.writeUInt32BE(BODY_MAX + 1, bytes.length - 4);
    expect(() => new FrameDecoder().push(bytes)).toThrow(
      `a body of ${BODY_MAX + 1} bytes is larger than 64 MiB`,
    );
  });

  it("rejects a header that is not JSON", () => {
    const header = Buffer.from("not json", "utf8");
    const bad = Buffer.alloc(8 + header.length);
    bad.writeUInt32BE(header.length, 0);
    header.copy(bad, 4);
    bad.writeUInt32BE(0, 4 + header.length);
    expect(() => new FrameDecoder().push(bad)).toThrow("a header is not JSON");
  });

  it("rejects a header that is JSON but not an object", () => {
    const header = Buffer.from("[]", "utf8");
    const bad = Buffer.alloc(8 + header.length);
    bad.writeUInt32BE(header.length, 0);
    header.copy(bad, 4);
    bad.writeUInt32BE(0, 4 + header.length);
    expect(() => new FrameDecoder().push(bad)).toThrow("a header is not a JSON object");
  });
});
