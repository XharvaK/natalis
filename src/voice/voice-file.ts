// voice.json: her voice, beside discord.json. It holds her starting voice and where the organ lives on this host. It
// holds no key. A bad file, or an organ that is not there, fails the start and names what is wrong.

export const VOICE_FILE = "voice.json";

export type VoiceFile = {
  /** "F2" or "M2", tiny-voca's two voices. */
  voice: string;
  /** 1.0 is the model as trained; larger is faster. */
  speed: number;
  /** Added to log F0; 0.058 is about one semitone. */
  pitchShift: number;
  /** Scales pitch movement; 1.0 as trained. */
  pitchRange: number;
  /** Silence that ends an utterance in a call, in ms (phase 2). */
  endpointMs: number;
  organ: {
    /** The venv's python, an absolute path. */
    python: string;
    /** The models folder (organ/PROTOCOL.md, "Models"), an absolute path. */
    models: string;
  };
};

/** F2's own settings: the model as trained. */
export const VOICE_DEFAULTS = { voice: "F2", speed: 1.0, pitchShift: 0, pitchRange: 1.0, endpointMs: 700 } as const;

/** Checks an already-parsed voice.json and fills the defaults. Throws a plain error naming the first wrong field. */
export function parseVoiceFile(_value: unknown): VoiceFile {
  throw new Error("parseVoiceFile is not built yet (N10 phase 1, pack voice-node).");
}

/** What is missing for the organ to start, one plain line each: the python, the script, each model file. */
export function organProblems(_file: VoiceFile, _exists?: (path: string) => boolean, _script?: string): string[] {
  throw new Error("organProblems is not built yet (N10 phase 1, pack voice-node).");
}
