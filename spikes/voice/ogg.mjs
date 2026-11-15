// A Discord voice message from Opus packets: an Ogg Opus file (RFC 7845), its duration and its waveform.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let k = 0; k < 8; k += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function page({ packets, granule, serial, seq, flags }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const whole = Buffer.concat([header, ...packets]);
  whole.writeUInt32LE(crc32(whole), 22);
  return whole;
}

/** Mono 48 kHz Opus packets of 20 ms each, as an Ogg Opus file. */
export function oggOpus(packets, { channels = 1, preSkip = 312, serial = 0x4e41544c } = {}) {
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

  const pages = [page({ packets: [head], granule: 0, serial, seq: 0, flags: 0x02 }), page({ packets: [tags], granule: 0, serial, seq: 1, flags: 0 })];
  let seq = 2;
  let granule = preSkip;
  for (let i = 0; i < packets.length; i += 50) { // one second of audio a page
    const group = packets.slice(i, i + 50);
    granule += group.length * 960;
    const last = i + 50 >= packets.length;
    pages.push(page({ packets: group, granule, serial, seq: seq++, flags: last ? 0x04 : 0 }));
  }
  return Buffer.concat(pages);
}

/** Discord's waveform: one byte per point, at most 256 points, at most one point per 100 ms; base64. */
export function waveform(pcm16, sampleRate = 48000) {
  const seconds = pcm16.length / sampleRate;
  const points = Math.max(1, Math.min(256, Math.ceil(seconds / 0.1)));
  const per = Math.max(1, Math.floor(pcm16.length / points));
  const out = Buffer.alloc(points);
  for (let p = 0; p < points; p += 1) {
    let sum = 0;
    const from = p * per;
    const to = Math.min(pcm16.length, from + per);
    for (let i = from; i < to; i += 1) sum += (pcm16[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out[p] = Math.min(255, Math.round(Math.min(1, rms * 4) * 255));
  }
  return out.toString("base64");
}
