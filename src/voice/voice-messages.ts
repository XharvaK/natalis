// Discord voice messages, both ways, over the voice organ. Making one: the whole say made speakable, cut into chunks,
// spoken into one utterance, encoded as Ogg Opus (mono, 48 kHz, 32 kbps) with its duration and waveform. Hearing one:
// the Ogg file read here, its packets decoded and transcribed by the organ. Audio is never kept.

import { OrganError, type OrganCaller, type OrganReply } from "./organ-client.js";
import { OggError, readOggOpus, waveform, writeOggOpus, type OggOpus } from "./ogg.js";
import { speechChunks } from "./speakable.js";

/** The longest voice message she may send, in seconds: two minutes of speech. */
export const VOICE_MESSAGE_MAX_S = 120;
/** The most words that fit in two minutes of speech. */
export const VOICE_MESSAGE_MAX_WORDS = 360;
/** The longest voice message the organ will hear, in seconds. */
export const HEAR_MAX_S = 300;

const BITRATE = 32000;
const FRAMES_PER_CALL = 250;
const DEFAULT_PRE_SKIP = 312;
/** Every packet is 20 ms of audio. */
const PACKET_SECONDS = 0.02;

/** How she sounds: the voice and its prosody, from voice.json. */
export type VoiceSettings = { voice: string; speed: number; pitchShift: number; pitchRange: number };

/** A voice message ready to send. */
export type MadeVoiceMessage = {
  /** The Ogg Opus file. */
  ogg: Uint8Array;
  /** Its length in seconds (packets x 20 ms). */
  seconds: number;
  /** Discord's waveform, base64. */
  waveform: string;
  /** What was left out of speech, in order, such as "an emoji" or "a code block (1 line)". */
  skipped: string[];
};

/** A voice message heard. */
export type HeardVoiceMessage = {
  /** The transcript; empty when nothing was heard. */
  text: string;
  /** The message's length in seconds, from the Ogg file. */
  seconds: number;
  /** How much of it was heard, in seconds: less than `seconds` only when it was longer than the organ hears. */
  heardSeconds: number;
  /** The model that heard it. */
  model: string;
};

/**
 * Why a voice message was not made or heard. "resting": the organ is not ready. "nothing_to_say": no word in the text
 * can be spoken. "too_long": over two minutes of speech. "bad_audio": the file is not an Ogg Opus file this can read.
 * "organ": the organ failed.
 */
export type VoiceErrorKind = "resting" | "nothing_to_say" | "too_long" | "bad_audio" | "organ";

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly kind: VoiceErrorKind,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

/** What the Discord world needs to hear and send voice messages. */
export interface VoiceMessages {
  /** Why voice messages cannot be made or heard now, in plain words; undefined while the organ is ready. */
  resting(): string | undefined;
  /** Speaks a whole say into a voice message. Rejects with a VoiceError. */
  make(text: string): Promise<MadeVoiceMessage>;
  /** Hears a voice message's Ogg file. Rejects with a VoiceError. */
  hear(ogg: Uint8Array): Promise<HeardVoiceMessage>;
}

function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A frames reply's packet lengths, checked; a reply without them is an organ fault. */
function packetLens(header: Record<string, unknown>): number[] {
  const lens = header["lens"];
  if (!Array.isArray(lens) || !lens.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    throw new VoiceError("your voice organ failed: a frames reply has no packet lengths", "organ");
  }
  return lens;
}

/** Splits a frames reply body into its packets, then its 16-bit little-endian samples. */
function framesBody(body: Uint8Array, lens: number[]): { packets: Uint8Array[]; samples: Int16Array } {
  let at = 0;
  const packets: Uint8Array[] = [];
  for (const len of lens) {
    if (at + len > body.length) throw new VoiceError("your voice organ failed: a frames reply is shorter than its packet lengths", "organ");
    packets.push(body.subarray(at, at + len));
    at += len;
  }
  const count = Math.floor((body.length - at) / 2);
  const samples = new Int16Array(count);
  const view = new DataView(body.buffer, body.byteOffset + at, count * 2);
  for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true);
  return { packets, samples };
}

function joinSamples(parts: readonly Int16Array[]): Int16Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const all = new Int16Array(length);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

export function createVoiceMessages(organ: OrganCaller, settings: VoiceSettings): VoiceMessages {
  let nextUtterance = 0;

  /** One organ call, with its OrganError said in the words this module's callers use. */
  async function call(header: Record<string, unknown>, body?: Uint8Array, options?: { timeoutMs?: number }): Promise<OrganReply> {
    try {
      return await organ.call(header, body, options);
    } catch (error) {
      if (error instanceof OrganError) {
        if (error.kind === "resting") throw new VoiceError(error.message, "resting");
        console.error(`natalis: the voice organ failed: ${error.message}`);
        throw new VoiceError("your voice organ failed", "organ");
      }
      throw error;
    }
  }

  async function make(text: string): Promise<MadeVoiceMessage> {
    const chunks = speechChunks(text);
    const skipped = chunks.flatMap((chunk) => chunk.skipped);
    const speaking = chunks.filter((chunk) => chunk.say.length > 0);
    if (speaking.length === 0) {
      const leftOut = skipped.length > 0 ? ` (left out: ${skipped.join("; ")})` : "";
      throw new VoiceError(`nothing in it can be spoken aloud${leftOut}`, "nothing_to_say");
    }

    const words = speaking.reduce((sum, chunk) => sum + wordsIn(chunk.say), 0);
    if (words > VOICE_MESSAGE_MAX_WORDS) {
      throw new VoiceError(
        `it is about ${words} words, more than two minutes of speech; a voice message holds at most 2 minutes`,
        "too_long",
      );
    }

    const resting = organ.resting();
    if (resting !== undefined) throw new VoiceError(resting, "resting");

    const utt = `vm-${++nextUtterance}`;
    const packets: Uint8Array[] = [];
    const sampleParts: Int16Array[] = [];
    let failure: unknown;
    try {
      for (let i = 0; i < speaking.length; i += 1) {
        const chunk = speaking[i]!;
        await call({
          op: "speak",
          utt,
          text: chunk.say,
          voice: settings.voice,
          speed: settings.speed,
          pitch_shift: settings.pitchShift,
          pitch_range: settings.pitchRange,
          pause_ms: i === speaking.length - 1 ? 0 : chunk.pauseMs,
          channels: 1,
          bitrate: BITRATE,
        });
      }
      for (;;) {
        const reply = await call({ op: "frames", utt, n: FRAMES_PER_CALL, final: true, pcm: true });
        const lens = packetLens(reply.header);
        if (lens.length === 0) break;
        const frames = framesBody(reply.body, lens);
        packets.push(...frames.packets);
        sampleParts.push(frames.samples);
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await call({ op: "flush", utt });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;

    const seconds = packets.length * PACKET_SECONDS;
    if (seconds > VOICE_MESSAGE_MAX_S) {
      throw new VoiceError(`it came to ${Math.round(seconds)} s of speech; a voice message holds at most 2 minutes`, "too_long");
    }

    return {
      ogg: writeOggOpus(packets, { channels: 1, preSkip: organ.ready()?.lookahead ?? DEFAULT_PRE_SKIP }),
      seconds,
      waveform: waveform(joinSamples(sampleParts)),
      skipped,
    };
  }

  async function hear(ogg: Uint8Array): Promise<HeardVoiceMessage> {
    let file: OggOpus;
    try {
      file = readOggOpus(ogg);
    } catch (error) {
      if (error instanceof OggError) throw new VoiceError(`the voice message could not be read: ${error.message}`, "bad_audio");
      throw error;
    }

    const resting = organ.resting();
    if (resting !== undefined) throw new VoiceError(resting, "resting");

    let length = 0;
    for (const packet of file.packets) {
      if (packet.length > 0xffff) throw new VoiceError("a packet is too large", "bad_audio");
      length += 2 + packet.length;
    }
    const body = Buffer.alloc(length);
    let at = 0;
    for (const packet of file.packets) {
      body.writeUInt16BE(packet.length, at);
      at += 2;
      body.set(packet, at);
      at += packet.length;
    }

    const reply = await call({ op: "transcribe", channels: file.channels, max_s: HEAR_MAX_S }, body, { timeoutMs: 300000 });
    const audioMs = Number(reply.header["audio_ms"]);
    return {
      text: String(reply.header["text"]),
      seconds: file.seconds !== 0 ? file.seconds : audioMs / 1000,
      heardSeconds: Number(reply.header["heard_ms"]) / 1000,
      model: String(reply.header["model"]),
    };
  }

  return {
    resting() {
      return organ.resting();
    },
    make,
    hear,
  };
}
