// The voice spike, silent: a simulated model streams a `say` into a voice place; the body speaks it sentence by sentence
// through the organ; the summoner's recorded voice barges in; a noise burst tries to. Everything lands in files; nothing
// is played. Usage: node spike.mjs <python> <organ.py> <out dir> <summoner clip.wav> <noise clip.wav>

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createArgsReader } from "./say-stream.mjs";
import { createChunker } from "./speech-text.mjs";
import { oggOpus, waveform } from "./ogg.mjs";

const [python, organPath, outDir, summonerClip, noiseClip] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------------------------------- the organ, over a pipe
function startOrgan() {
  const child = spawn(python, ["-I", organPath], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  const waiting = new Map();
  let nextId = 1;
  let onReady;
  const ready = new Promise((resolve) => { onReady = resolve; });
  child.stdout.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 4) return;
      const hl = buf.readUInt32BE(0);
      if (buf.length < 8 + hl) return;
      const bl = buf.readUInt32BE(4 + hl);
      if (buf.length < 8 + hl + bl) return;
      const header = JSON.parse(buf.subarray(4, 4 + hl).toString("utf8"));
      const body = Buffer.from(buf.subarray(8 + hl, 8 + hl + bl));
      buf = buf.subarray(8 + hl + bl);
      if (header.op === "ready") { onReady(header); continue; }
      const w = waiting.get(header.id);
      waiting.delete(header.id);
      if (header.op === "error") w?.reject(new Error(`organ ${header.for}: ${header.error}`));
      else w?.resolve({ header, body });
    }
  });
  child.on("exit", (code) => { for (const w of waiting.values()) w.reject(new Error(`organ exited with ${code}`)); });
  function call(header, body = Buffer.alloc(0)) {
    const id = nextId++;
    const hb = Buffer.from(JSON.stringify({ ...header, id }));
    const frame = Buffer.alloc(8 + hb.length + body.length);
    frame.writeUInt32BE(hb.length, 0);
    hb.copy(frame, 4);
    frame.writeUInt32BE(body.length, 4 + hb.length);
    body.copy(frame, 8 + hb.length);
    child.stdin.write(frame);
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }
  return { ready, call, close: () => child.stdin.end() };
}

function splitPackets(lens, body) {
  const packets = [];
  let at = 0;
  for (const n of lens) { packets.push(body.subarray(at, at + n)); at += n; }
  return { packets, pcm: new Int16Array(body.buffer.slice(body.byteOffset + at, body.byteOffset + body.length)) };
}

function wav(path, pcm16, rate = 48000) {
  const data = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// A seeded generator, so every run streams the same pieces at the same pace.
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

// ------------------------------------------------------------------------------------------- what the model "writes"
const SAY_TEXT =
  "Oh, nice, you're back! \u{1F60A} So, about the server: the backup took 12.5 minutes last night, which is about twice the usual. " +
  "I checked the logs at https://status.example.com/jobs/backup and nothing looked wrong. **Honestly**, I'd just keep an eye on it tonight.\n\n" +
  "```bash\njournalctl --user -u backup\n```\n" +
  "If it happens again, I can look into it tomorrow at 9:30.";
// Escape the emoji the way some models do (😊), so the reader has to join a surrogate pair split across pieces.
const ARGS_JSON = JSON.stringify({ place: "voice:discord:living-room", text: SAY_TEXT }).replace(/\u{1F60A}/u, "\\ud83d\\ude0a");

function pieces(json, seed) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < json.length;) { const n = 1 + Math.floor(r() * 6); out.push(json.slice(i, i + n)); i += n; }
  return out;
}

// ------------------------------------------------------------------------------------------- one spoken say
async function speakSay(organ, { name, tokensPerSecond, bargeIn }) {
  const T0 = performance.now();
  const now = () => performance.now() - T0;
  const utt = `${name}-${Date.now()}`;
  const log = { name, tokensPerSecond, chunks: [], events: [] };
  const ev = (what, extra = {}) => log.events.push({ t: Math.round(now()), what, ...extra });

  let place = null;
  let gainNow = 1.0;
  let stopped = false;
  let textDone = false;
  let pendingSpeaks = 0;
  const words = []; // {text, start, end} in utterance ms
  const skipped = [];
  let rawSoFar = "";
  let rawSpokenUpTo = 0; // characters of the say text whose chunks went to the organ

  const chunker = createChunker({
    onChunk(chunk) {
      skipped.push(...chunk.skipped);
      if (stopped || chunk.say.length === 0) return;
      const sentAt = now();
      pendingSpeaks += 1;
      organ.call({ op: "speak", utt, text: chunk.say, pause_ms: chunk.pauseMs, channels: 2, bitrate: 64000 }).then(({ header }) => {
        pendingSpeaks -= 1;
        if (header.skipped) return;
        const sayWords = chunk.say.split(/\s+/);
        header.words.forEach(([start, end], k) => {
          const idx = header.words.length === sayWords.length ? k : Math.min(sayWords.length - 1, Math.round(((k + 1) / header.words.length) * sayWords.length) - 1);
          const prev = words[words.length - 1];
          if (prev && prev.chunk === log.chunks.length && prev.idx === idx) prev.end = end;
          else words.push({ text: sayWords[idx], start, end, idx, chunk: log.chunks.length });
        });
        log.chunks.push({ say: chunk.say, end: chunk.end, sentAt: Math.round(sentAt), readyAt: Math.round(now()), audioMs: header.audio_ms, organMs: header.ms });
      });
    },
  });

  const reader = createArgsReader((key, fragment, done) => {
    if (key === "place" && done) { place = fragment || place; ev("place known", { place }); }
    if (key === "place" && !done) place = (place ?? "") + fragment;
    if (key !== "text") return;
    rawSoFar += fragment;
    if (!stopped) { chunker.push(fragment); rawSpokenUpTo = rawSoFar.length; }
    if (done) { textDone = true; if (!stopped) chunker.finish(); ev("text complete"); }
  });

  // The model's stream, piece by piece, at its pace.
  const streamDone = (async () => {
    const r = rng(7);
    ev("first token");
    for (const piece of pieces(ARGS_JSON, 11)) {
      reader.push(piece);
      await sleep((1000 / tokensPerSecond) * (0.6 + r() * 0.8));
    }
  })();

  // The player: one 20 ms frame per tick, a lookahead of three frames pulled from the organ.
  const played = [];
  const lookahead = [];
  let asking = false;
  let firstFrameAt = null;
  let underruns = 0;
  let underrunMs = 0;
  let framesSent = 0;
  let finalAsked = false;
  const playerDone = (async () => {
    while (log.chunks.length === 0 && !stopped) await sleep(2);
    const start = performance.now();
    for (let tick = 0; ; tick += 1) {
      await sleep(start + tick * 20 - performance.now());
      if (stopped) return;
      if (lookahead.length < 3 && !asking) {
        asking = true;
        const final = textDone && pendingSpeaks === 0;
        finalAsked = final;
        organ.call({ op: "frames", utt, n: 3 - lookahead.length, gain: gainNow, final }).then(({ header, body }) => {
          asking = false;
          if (stopped) return;
          const { packets, pcm } = splitPackets(header.lens, body);
          packets.forEach((p, i) => lookahead.push({ packet: p, pcm: pcm.subarray(i * 960, (i + 1) * 960) }));
          if (final && packets.length === 0 && header.left_ms === 0) lookahead.push(null);
        }).catch(() => { asking = false; });
      }
      const frame = lookahead.shift();
      if (frame === null) { ev("speech finished"); return; }
      if (frame === undefined) {
        if (firstFrameAt !== null && !finalAsked) { underruns += 1; underrunMs += 20; }
        continue;
      }
      if (firstFrameAt === null) { firstFrameAt = now(); ev("first frame sent"); }
      framesSent += 1;
      played.push(frame.pcm);
    }
  })();

  // The summoner's voice (or a noise) arrives as 20 ms Opus packets, through the ear.
  let bargeResult = null;
  const ear = bargeIn ? (async () => {
    while (firstFrameAt === null) await sleep(5);
    await sleep(bargeIn.afterMs);
    const { header, body } = await organ.call({ op: "encode_clip", path: bargeIn.clip });
    const { packets } = splitPackets(header.lens, Buffer.concat([body, Buffer.alloc(0)]));
    // A Discord client sends nothing until its own voice gate opens: start the packets 60 ms before the speech onset.
    const firstPacket = Math.max(0, Math.floor((header.onset_ms - 60) / 20));
    const stream = `${bargeIn.kind}-${Date.now()}`;
    let duckAt = null;
    let duckFrame = null;
    const history = [];
    const startAt = performance.now();
    for (let i = firstPacket; i < packets.length && !stopped; i += 1) {
      await sleep(startAt + (i - firstPacket) * 20 - performance.now());
      if (duckAt === null) { // the first packet after quiet: the summoner's client opened its gate
        duckAt = now(); duckFrame = framesSent; gainNow = 0.3; ev("duck", { kind: bargeIn.kind });
      }
      const n = Buffer.alloc(2); n.writeUInt16BE(packets[i].length);
      const { header: heard } = await organ.call({ op: "hear", stream }, Buffer.concat([n, packets[i]]));
      for (const p of heard.probs) history.push(p);
      const recent = history.slice(-4);
      if (recent.filter((p) => p >= 0.5).length >= 3) { // about 100 ms of speech: it is the summoner talking
        stopped = true;
        const flushed = await organ.call({ op: "flush", utt });
        const stopAt = now();
        ev("stop", { kind: bargeIn.kind });
        bargeResult = {
          kind: bargeIn.kind, duckAfterFirstPacketMs: 0, stopAfterFirstPacketMs: Math.round(stopAt - duckAt),
          stopAfterOnsetMs: Math.round(stopAt - duckAt - 60), framesSentBeforeDuck: duckFrame, framesSent,
          utteranceMsAtDuck: duckFrame * 20, organPosMs: flushed.header.pos_ms, droppedMs: flushed.header.dropped_ms,
        };
        return;
      }
      if (now() - duckAt > 600) { gainNow = 1.0; ev("unduck", { kind: bargeIn.kind }); bargeResult = { kind: bargeIn.kind, stopped: false, unduckedAfterMs: Math.round(now() - duckAt) }; return; }
    }
    if (!stopped && duckAt !== null && gainNow !== 1.0) { gainNow = 1.0; ev("unduck at end of noise"); bargeResult = { kind: bargeIn.kind, stopped: false }; }
  })() : Promise.resolve();

  await Promise.all([streamDone, playerDone, ear]);
  while (pendingSpeaks > 0) await sleep(5);

  // What she is told.
  const spokenUpToMs = bargeResult?.utteranceMsAtDuck ?? Infinity;
  const spokenWords = words.filter((w) => w.end <= spokenUpToMs).map((w) => w.text);
  const lastWords = spokenWords.slice(-4).join(" ");
  const notSpoken = stopped ? SAY_TEXT.slice(0, rawSoFar.length) : "";
  const leftOut = [...new Set(skipped)];
  if (stopped && bargeResult) {
    const spokenText = spokenWords.join(" ");
    log.receipt = `Said in part to ${place}. Your summoner started speaking ${(bargeResult.utteranceMsAtDuck / 1000).toFixed(1)} s in, and you stopped after "${lastWords}". ` +
      `Spoken: "${spokenText}". The rest was not spoken.` + (leftOut.length ? ` Left out of speech: ${leftOut.join("; ")}.` : "");
    log.notSpokenChars = Math.max(0, SAY_TEXT.length - spokenText.length);
  } else {
    log.receipt = `Said to ${place}.` + (leftOut.length ? ` Left out of speech: ${leftOut.join("; ")}.` : "");
  }
  void notSpoken;
  void rawSpokenUpTo;
  log.firstFrameAfterFirstTokenMs = firstFrameAt === null ? null : Math.round(firstFrameAt);
  log.firstChunkReadyAfterFirstTokenMs = log.chunks[0]?.readyAt ?? null;
  log.firstChunkTextAfterFirstTokenMs = log.chunks[0]?.sentAt ?? null;
  log.underruns = underruns;
  log.underrunMs = underrunMs;
  log.framesSent = framesSent;
  log.barge = bargeResult;
  const total = played.reduce((n, p) => n + p.length, 0);
  const all = new Int16Array(total);
  let at = 0;
  for (const p of played) { all.set(p, at); at += p.length; }
  wav(join(outDir, `${name}.wav`), all);
  return log;
}

// ------------------------------------------------------------------------------------------- a voice message
async function voiceMessage(organ) {
  const T0 = performance.now();
  const utt = `msg-${Date.now()}`;
  const chunks = [];
  const chunker = createChunker({ onChunk: (c) => { if (c.say) chunks.push(c); } });
  chunker.push(SAY_TEXT);
  chunker.finish();
  for (const c of chunks) await organ.call({ op: "speak", utt, text: c.say, pause_ms: c.pauseMs, channels: 1, bitrate: 32000 });
  const packets = [];
  const pcm = [];
  for (;;) {
    const { header, body } = await organ.call({ op: "frames", utt, n: 50, gain: 1.0, final: true });
    const split = splitPackets(header.lens, body);
    packets.push(...split.packets);
    pcm.push(split.pcm);
    if (header.lens.length === 0 || header.left_ms === 0) break;
  }
  const allPcm = new Int16Array(pcm.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pcm) { allPcm.set(p, at); at += p.length; }
  const ogg = oggOpus(packets, { channels: 1 });
  writeFileSync(join(outDir, "voice-message.ogg"), ogg);
  return { chunks: chunks.length, packets: packets.length, durationSecs: +(packets.length * 0.02).toFixed(2), bytes: ogg.length,
    waveform: waveform(allPcm), madeInMs: Math.round(performance.now() - T0) };
}

const organ = startOrgan();
const hello = await organ.ready;
const results = { organ: hello };
results.calm50 = await speakSay(organ, { name: "calm-50tps", tokensPerSecond: 50 });
results.calm25 = await speakSay(organ, { name: "calm-25tps", tokensPerSecond: 25 });
results.bargeIn = await speakSay(organ, { name: "barge-in", tokensPerSecond: 50, bargeIn: { kind: "summoner", clip: summonerClip, afterMs: 3000 } });
results.noise = await speakSay(organ, { name: "noise-burst", tokensPerSecond: 50, bargeIn: { kind: "noise", clip: noiseClip, afterMs: 2500 } });
results.voiceMessage = await voiceMessage(organ);
organ.close();
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, (k, v) => (k === "events" || k === "words" ? undefined : v), 1));
