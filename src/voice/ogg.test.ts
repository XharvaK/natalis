import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OggError, oggCrc, oggPage, readOggOpus, waveform, writeOggOpus } from "./ogg.js";

function splitPages(file: Uint8Array): Buffer[] {
  const buf = Buffer.from(file);
  const pages: Buffer[] = [];
  let at = 0;
  while (at < buf.length) {
    const count = buf[at + 26]!;
    let body = 0;
    for (let i = 0; i < count; i += 1) body += buf[at + 27 + i]!;
    const end = at + 27 + count + body;
    pages.push(buf.subarray(at, end));
    at = end;
  }
  return pages;
}

function lacingOf(page: Buffer): number[] {
  const count = page[26]!;
  return Array.from(page.subarray(27, 27 + count));
}

function granuleOf(page: Buffer): number {
  return Number(page.readBigInt64LE(6));
}

function digest(file: Buffer): string {
  return createHash("sha256").update(file).digest("hex");
}

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OggError);
    return (error as Error).message;
  }
  throw new Error("it did not throw");
}

describe("oggCrc", () => {
  it("matches Ogg's own check value", () => {
    expect(oggCrc(Buffer.from("123456789"))).toBe(0x89a1897f);
  });
});

describe("writeOggOpus", () => {
  it("writes the fixed bytes the host's libsndfile read", () => {
    const small = writeOggOpus([Buffer.from([1, 2, 3]), Buffer.alloc(255, 7), Buffer.alloc(600, 9)]);
    expect(small.length).toBe(989);
    expect(digest(small)).toBe("e848ac0849bfd62ef0ff5b583e77fdcf8a85ebff815d090adb20b195a38367af");

    const hundredTwenty = Array.from({ length: 120 }, (_, i) => Buffer.from([i, i ^ 0x55, 3]));
    const file = writeOggOpus(hundredTwenty);
    expect(file.length).toBe(659);
    expect(digest(file)).toBe("40ee4bedcdef0119dd8889a803c3a9f39a85f022e30a7913bf896c27ff3a0b78");
  });

  it("laces a 255-byte packet as [255, 0] and a 600-byte one as [255, 255, 90]", () => {
    const pages = splitPages(writeOggOpus([Buffer.alloc(255, 1), Buffer.alloc(600, 2)]));
    expect(lacingOf(pages[2]!)).toEqual([255, 0, 255, 255, 90]);
  });

  it("puts 120 packets on pages of 50, with running granules and end flags", () => {
    const pages = splitPages(writeOggOpus(Array.from({ length: 120 }, () => Buffer.from([1, 2, 3]))));
    expect(pages).toHaveLength(5);
    expect(pages[0]![5]).toBe(0x02);
    expect(granuleOf(pages[2]!)).toBe(312 + 50 * 960);
    expect(granuleOf(pages[3]!)).toBe(312 + 100 * 960);
    expect(granuleOf(pages[4]!)).toBe(312 + 120 * 960);
    expect(pages[2]![5]).toBe(0);
    expect(pages[3]![5]).toBe(0);
    expect(pages[4]![5]).toBe(0x04);
  });

  it("keeps every page at or below 255 lacing values", () => {
    const pages = splitPages(writeOggOpus(Array.from({ length: 60 }, () => Buffer.alloc(1000, 3))));
    const audio = pages.slice(2);
    expect(audio).toHaveLength(2);
    for (const page of audio) expect(lacingOf(page).length).toBeLessThanOrEqual(255);
    expect(audio.map((page) => lacingOf(page).length)).toEqual([200, 40]);
  });

  it("refuses no packets and a packet too large for one page", () => {
    expect(errorOf(() => writeOggOpus([]))).toBe("no audio packets");
    expect(errorOf(() => writeOggOpus([Buffer.alloc(65025, 1)]))).toBe("a packet is too large for one page");
  });
});

describe("readOggOpus", () => {
  it("round trips packets, channels and pre-skip", () => {
    const packets = [Buffer.from([1]), Buffer.alloc(255, 2), Buffer.alloc(600, 3), Buffer.from([4, 5])];
    const read = readOggOpus(writeOggOpus(packets, { channels: 2, preSkip: 100 }));
    expect(read.channels).toBe(2);
    expect(read.preSkip).toBe(100);
    expect(read.packets).toHaveLength(packets.length);
    for (let i = 0; i < packets.length; i += 1) expect(Buffer.from(read.packets[i]!).toString("hex")).toBe(packets[i]!.toString("hex"));
    expect(read.seconds).toBeCloseTo(packets.length * 0.02, 10);
  });

  it("joins a packet split across two pages", () => {
    const packet = Buffer.alloc(300, 5);
    const base = splitPages(writeOggOpus([packet]));
    const serial = base[0]!.readUInt32LE(14);
    const first = oggPage({ data: packet.subarray(0, 255), lacing: [255], granule: -1, serial, seq: 2, flags: 0 });
    const second = oggPage({ data: packet.subarray(255), lacing: [45], granule: 312 + 960, serial, seq: 3, flags: 0x01 | 0x04 });
    const read = readOggOpus(Buffer.concat([base[0]!, base[1]!, first, second]));
    expect(read.packets).toHaveLength(1);
    expect(Buffer.from(read.packets[0]!).toString("hex")).toBe(packet.toString("hex"));
    expect(read.seconds).toBeCloseTo(0.02, 10);
  });

  it("names each read fault", () => {
    const valid = writeOggOpus([Buffer.alloc(100, 1)]);

    const flipped = Buffer.from(valid);
    const last = flipped.length - 1;
    flipped[last] = (flipped[last] ?? 0) ^ 0xff;
    expect(errorOf(() => readOggOpus(flipped))).toBe("a page's checksum is wrong");

    expect(errorOf(() => readOggOpus(valid.subarray(0, valid.length - 5)))).toBe("the file ends in the middle of a page");
    expect(errorOf(() => readOggOpus(Buffer.from("this is just a line of plain text, not audio")))).toBe("it is not an Ogg file");

    const base = splitPages(valid);
    const serial = base[0]!.readUInt32LE(14);
    const notHead = Buffer.from("NopeNopeNopeNopeNope");
    const notHeadPage = oggPage({ data: notHead, lacing: [notHead.length], granule: 0, serial, seq: 0, flags: 0x02 });
    expect(errorOf(() => readOggOpus(Buffer.concat([notHeadPage, ...base.slice(1)])))).toBe("it is not an Ogg Opus file");

    const headCount = base[0]![26]!;
    const headData = Buffer.from(base[0]!.subarray(27 + headCount));
    headData[9] = 6;
    const sixPage = oggPage({ data: headData, lacing: [headData.length], granule: 0, serial, seq: 0, flags: 0x02 });
    expect(errorOf(() => readOggOpus(Buffer.concat([sixPage, ...base.slice(1)])))).toBe(
      "it has 6 channels; only mono and stereo are heard",
    );

    const many = writeOggOpus(Array.from({ length: 120 }, () => Buffer.from([1, 2, 3])));
    expect(errorOf(() => readOggOpus(many, { maxPackets: 10 }))).toBe("it has more than 10 packets");
  });
});

describe("waveform", () => {
  it("uses one point per 100 ms, whole numbers, and clamps at 256", () => {
    const points = (seconds: number) => Buffer.from(waveform(new Int16Array(Math.round(seconds * 48000))), "base64").length;
    expect(points(0.05)).toBe(1);
    expect(points(10)).toBe(100);
    expect(points(10.01)).toBe(101);
    expect(points(25.6)).toBe(256);
    expect(points(60)).toBe(256);
  });

  it("reads silence as zeros and a full-scale square wave as all 255", () => {
    const silence = Buffer.from(waveform(new Int16Array(48000)), "base64");
    expect(silence.length).toBe(10);
    expect(silence.every((b) => b === 0)).toBe(true);

    const square = Int16Array.from({ length: 48000 }, (_, i) => (i % 2 === 0 ? 32767 : -32767));
    const loud = Buffer.from(waveform(square), "base64");
    expect(loud.every((b) => b === 255)).toBe(true);
  });
});
