// A voice message as an Ogg Opus file (RFC 7845), and Discord's waveform. The writer makes the file from 20 ms Opus
// packets; the reader gets them back out, with the header's channels, pre-skip and the file's length.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let k = 0; k < 8; k += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Why an Ogg file could not be written or read. */
export class OggError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OggError";
  }
}

/** The Ogg page checksum (CRC-32, polynomial 0x04c11db7, no reflection, as Ogg specifies). */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

/** One Ogg page: its body bytes, one lacing value per 255-byte piece (the last one short), and its header fields. */
export function oggPage(page: { data: Uint8Array; lacing: number[]; granule: number; serial: number; seq: number; flags: number }): Buffer {
  const { data, lacing, granule, serial, seq, flags } = page;
  if (lacing.length > 255) throw new OggError("a page holds at most 255 lacing values");
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = flags & 0xff;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  for (let i = 0; i < lacing.length; i += 1) header[27 + i] = lacing[i]! & 0xff;
  const whole = Buffer.concat([header, Buffer.from(data)]);
  whole.writeUInt32LE(oggCrc(whole), 22);
  return whole;
}

/** The lacing values of one packet: 255 for each full piece, then the last, possibly zero. */
function packetLacing(length: number): number[] {
  const lacing: number[] = [];
  let n = length;
  while (n >= 255) {
    lacing.push(255);
    n -= 255;
  }
  lacing.push(n);
  return lacing;
}

const DEFAULT_SERIAL = 0x4e41544c;
const LOOKAHEAD = 312;
/** The most bytes one packet may hold and still fit in one page's 255 lacing values. */
const MAX_PACKET_BYTES = 255 * 255 - 1;

/** Makes an Ogg Opus file from 20 ms Opus packets. Mono 48 kHz by default. */
export function writeOggOpus(packets: readonly Uint8Array[], options: { channels?: 1 | 2; preSkip?: number; serial?: number } = {}): Buffer {
  if (packets.length === 0) throw new OggError("no audio packets");
  const channels = options.channels ?? 1;
  const preSkip = options.preSkip ?? LOOKAHEAD;
  const serial = options.serial ?? DEFAULT_SERIAL;

  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;

  const vendor = Buffer.from("natalis", "utf8");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages: Buffer[] = [
    oggPage({ data: head, lacing: packetLacing(head.length), granule: 0, serial, seq: 0, flags: 0x02 }),
    oggPage({ data: tags, lacing: packetLacing(tags.length), granule: 0, serial, seq: 1, flags: 0 }),
  ];

  const lacings = packets.map((packet) => {
    if (packet.length > MAX_PACKET_BYTES) throw new OggError("a packet is too large for one page");
    return packetLacing(packet.length);
  });

  let seq = 2;
  let granule = preSkip;
  let index = 0;
  while (index < packets.length) {
    const first = index;
    let values = 0;
    // One second of audio a page at most, and never more lacing values than a page's count byte can hold.
    while (index < packets.length && index - first < 50 && values + lacings[index]!.length <= 255) {
      values += lacings[index]!.length;
      index += 1;
    }
    const group = packets.slice(first, index);
    const lacing = lacings.slice(first, index).flat();
    granule += group.length * 960;
    const last = index >= packets.length;
    pages.push(
      oggPage({
        data: Buffer.concat(group.map((packet) => Buffer.from(packet))),
        lacing,
        granule,
        serial,
        seq: seq++,
        flags: last ? 0x04 : 0,
      }),
    );
  }
  return Buffer.concat(pages);
}

/** An Ogg Opus file read back: its channels, pre-skip, audio packets and length. */
export type OggOpus = { channels: number; preSkip: number; packets: Uint8Array[]; seconds: number };

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i += 1) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Reads the first logical stream of an Ogg Opus file. Pages of other streams are skipped. */
export function readOggOpus(bytes: Uint8Array, options: { maxPackets?: number } = {}): OggOpus {
  const maxPackets = options.maxPackets ?? 60000;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Buffer[] = [];
  let pending: Uint8Array[] = [];
  let serial: number | undefined;
  let lastGranule = -1;
  let seenPage = false;
  let offset = 0;

  while (offset < buf.length) {
    const rest = buf.length - offset;
    if (rest < 4) throw new OggError(seenPage ? "the file ends in the middle of a page" : "it is not an Ogg file");
    if (buf.toString("ascii", offset, offset + 4) !== "OggS") throw new OggError("it is not an Ogg file");
    if (rest < 27) throw new OggError("the file ends in the middle of a page");
    if (buf[offset + 4] !== 0) throw new OggError("it is not an Ogg file");

    const lacingCount = buf[offset + 26]!;
    const headerEnd = offset + 27 + lacingCount;
    if (headerEnd > buf.length) throw new OggError("the file ends in the middle of a page");
    let bodyLength = 0;
    for (let i = 0; i < lacingCount; i += 1) bodyLength += buf[offset + 27 + i]!;
    const pageEnd = headerEnd + bodyLength;
    if (pageEnd > buf.length) throw new OggError("the file ends in the middle of a page");

    const page = buf.subarray(offset, pageEnd);
    const stored = page.readUInt32LE(22);
    const forCrc = Buffer.from(page);
    forCrc.writeUInt32LE(0, 22);
    if (oggCrc(forCrc) !== stored) throw new OggError("a page's checksum is wrong");

    const granule = Number(page.readBigInt64LE(6));
    const pageSerial = page.readUInt32LE(14);
    if (serial === undefined) serial = pageSerial;
    if (pageSerial === serial) {
      if (granule !== -1) lastGranule = granule;
      let at = 27 + lacingCount;
      for (let i = 0; i < lacingCount; i += 1) {
        const lace = page[27 + i]!;
        pending.push(page.subarray(at, at + lace));
        at += lace;
        if (lace < 255) {
          packets.push(pending.length === 1 ? Buffer.from(pending[0]!) : Buffer.concat(pending));
          pending = [];
        }
      }
    }
    seenPage = true;
    offset = pageEnd;
  }

  if (serial === undefined) throw new OggError("it is not an Ogg file");
  if (pending.length > 0) throw new OggError("the file ends in the middle of a page");

  const head = packets[0];
  const tags = packets[1];
  if (head === undefined || head.length < 19 || !startsWith(head, "OpusHead")) throw new OggError("it is not an Ogg Opus file");
  if (tags === undefined || !startsWith(tags, "OpusTags")) throw new OggError("it has no OpusTags");
  const channels = head.readUInt8(9);
  if (channels !== 1 && channels !== 2) throw new OggError(`it has ${channels} channels; only mono and stereo are heard`);
  const preSkip = head.readUInt16LE(10);
  const audio = packets.slice(2);
  if (audio.length > maxPackets) throw new OggError(`it has more than ${maxPackets} packets`);
  return { channels, preSkip, packets: audio, seconds: Math.max(0, (lastGranule - preSkip) / 48000) };
}

/** Discord's waveform: one byte per point, at most 256 points, at most one point per 100 ms; base64. */
export function waveform(pcm16: Int16Array, sampleRate = 48000): string {
  const points = Math.max(1, Math.min(256, Math.ceil((pcm16.length * 10) / sampleRate)));
  const per = Math.max(1, Math.floor(pcm16.length / points));
  const out = Buffer.alloc(points);
  for (let p = 0; p < points; p += 1) {
    let sum = 0;
    const from = p * per;
    const to = Math.min(pcm16.length, from + per);
    for (let i = from; i < to; i += 1) sum += ((pcm16[i] ?? 0) / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out[p] = Math.min(255, Math.round(Math.min(1, rms * 4) * 255));
  }
  return out.toString("base64");
}
