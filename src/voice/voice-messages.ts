// Discord voice messages, both ways, over the voice organ. Making one: the whole say made speakable, cut into chunks,
// spoken into one utterance, encoded as Ogg Opus (mono, 48 kHz, 32 kbps) with its duration and waveform. Hearing one:
// the Ogg file read here, its packets decoded and transcribed by the organ. Audio is never kept.

import type { OrganCaller } from "./organ-client.js";

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

export function createVoiceMessages(_organ: OrganCaller, _settings: VoiceSettings): VoiceMessages {
  throw new Error("createVoiceMessages is not built yet (N10 phase 1, pack voice-node).");
}
