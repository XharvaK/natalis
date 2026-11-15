// voice.json: her voice, beside discord.json. It holds her starting voice and where the organ lives on this host. It
// holds no key. A bad file, or an organ that is not there, fails the start and names what is wrong.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ORGAN_SCRIPT } from "./organ-client.js";

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

const TOP_FIELDS = ["voice", "speed", "pitchShift", "pitchRange", "endpointMs", "organ"] as const;
const ORGAN_FIELDS = ["python", "models"] as const;
const MODEL_FILES = [
  "tiny-voca/config.json",
  "tiny-voca/onnx/model.onnx",
  "tiny-voca/phonemizer",
  "parakeet/model.int8.onnx",
  "parakeet/tokens.txt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Checks an already-parsed voice.json and fills the defaults. Throws a plain error naming the first wrong field. */
export function parseVoiceFile(value: unknown): VoiceFile {
  if (!isRecord(value)) throw new Error("voice.json must be an object.");

  for (const key of Object.keys(value)) {
    if (!(TOP_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Unknown field "${key}" in voice.json. Allowed: ${TOP_FIELDS.join(", ")}.`);
    }
  }

  const voice = value.voice === undefined ? VOICE_DEFAULTS.voice : value.voice;
  if (voice !== "F2" && voice !== "M2") throw new Error('voice.json: voice must be "F2" or "M2".');

  const speed = value.speed === undefined ? VOICE_DEFAULTS.speed : value.speed;
  if (!isNumber(speed, 0.5, 2)) throw new Error("voice.json: speed must be a number from 0.5 to 2.");

  const pitchShift = value.pitchShift === undefined ? VOICE_DEFAULTS.pitchShift : value.pitchShift;
  if (!isNumber(pitchShift, -0.5, 0.5)) {
    throw new Error("voice.json: pitchShift must be a number from -0.5 to 0.5.");
  }

  const pitchRange = value.pitchRange === undefined ? VOICE_DEFAULTS.pitchRange : value.pitchRange;
  if (!isNumber(pitchRange, 0, 3)) throw new Error("voice.json: pitchRange must be a number from 0 to 3.");

  const endpointMs = value.endpointMs === undefined ? VOICE_DEFAULTS.endpointMs : value.endpointMs;
  if (typeof endpointMs !== "number" || !Number.isInteger(endpointMs) || endpointMs < 200 || endpointMs > 3000) {
    throw new Error("voice.json: endpointMs must be a whole number of milliseconds from 200 to 3000.");
  }

  const organ = value.organ;
  if (!isRecord(organ)) {
    throw new Error("voice.json: organ must be an object with python and models.");
  }
  for (const key of Object.keys(organ)) {
    if (!(ORGAN_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Unknown field "${key}" in voice.json's organ. Allowed: ${ORGAN_FIELDS.join(", ")}.`);
    }
  }
  if (!("python" in organ) || !("models" in organ)) {
    throw new Error("voice.json: organ must be an object with python and models.");
  }

  const python = organ.python;
  if (typeof python !== "string" || !isAbsolute(python)) {
    throw new Error("voice.json: organ.python must be the absolute path of the organ's python.");
  }
  const models = organ.models;
  if (typeof models !== "string" || !isAbsolute(models)) {
    throw new Error("voice.json: organ.models must be the absolute path of the organ's models folder.");
  }

  return { voice, speed, pitchShift, pitchRange, endpointMs, organ: { python, models } };
}

/** What is missing for the organ to start, one plain line each: the python, the script, each model file. */
export function organProblems(
  file: VoiceFile,
  exists: (path: string) => boolean = existsSync,
  script: string = ORGAN_SCRIPT,
): string[] {
  const problems: string[] = [];
  if (!exists(file.organ.python)) {
    problems.push(`voice.json: organ.python is ${file.organ.python}, and there is no such file.`);
  }
  if (!exists(script)) {
    problems.push(`voice.json: the organ script ${script} is missing from this checkout.`);
  }
  for (const relative of MODEL_FILES) {
    if (!exists(join(file.organ.models, relative))) {
      problems.push(`voice.json: the models folder ${file.organ.models} has no ${relative}.`);
    }
  }
  return problems;
}
