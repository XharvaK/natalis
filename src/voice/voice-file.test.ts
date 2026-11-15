import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { organProblems, parseVoiceFile, VOICE_DEFAULTS } from "./voice-file.js";

const python = resolve("voice-test", "python");
const models = resolve("voice-test", "models");
const base = { organ: { python, models } };

function refuses(change: Record<string, unknown>, message: string): void {
  expect(() => parseVoiceFile({ ...base, ...change })).toThrow(message);
}

describe("parseVoiceFile", () => {
  it("fills every default and keeps the organ", () => {
    expect(parseVoiceFile({ organ: { python, models } })).toEqual({
      voice: VOICE_DEFAULTS.voice,
      speed: VOICE_DEFAULTS.speed,
      pitchShift: VOICE_DEFAULTS.pitchShift,
      pitchRange: VOICE_DEFAULTS.pitchRange,
      endpointMs: VOICE_DEFAULTS.endpointMs,
      organ: { python, models },
    });
  });

  it("keeps values that are in range", () => {
    expect(parseVoiceFile({ ...base, voice: "M2", speed: 0.5, pitchShift: -0.5, pitchRange: 3, endpointMs: 3000 })).toEqual(
      { voice: "M2", speed: 0.5, pitchShift: -0.5, pitchRange: 3, endpointMs: 3000, organ: { python, models } },
    );
  });

  it("refuses a value that is not an object", () => {
    for (const value of [null, undefined, "voice.json", 3, true, []]) {
      expect(() => parseVoiceFile(value)).toThrow("voice.json must be an object.");
    }
  });

  it("names an unknown top-level field", () => {
    refuses({ extra: 1 }, 'Unknown field "extra" in voice.json. Allowed: voice, speed, pitchShift, pitchRange, endpointMs, organ.');
  });

  it("refuses a voice that is not F2 or M2", () => {
    refuses({ voice: "F1" }, 'voice.json: voice must be "F2" or "M2".');
    refuses({ voice: 2 }, 'voice.json: voice must be "F2" or "M2".');
  });

  it("refuses a speed outside 0.5 to 2", () => {
    for (const speed of [0.49, 2.01, "1", true, Number.NaN, Number.POSITIVE_INFINITY]) {
      refuses({ speed }, "voice.json: speed must be a number from 0.5 to 2.");
    }
  });

  it("refuses a pitchShift outside -0.5 to 0.5", () => {
    for (const pitchShift of [-0.51, 0.51, "0", false, Number.NaN]) {
      refuses({ pitchShift }, "voice.json: pitchShift must be a number from -0.5 to 0.5.");
    }
  });

  it("refuses a pitchRange outside 0 to 3", () => {
    for (const pitchRange of [-0.01, 3.01, "1", Number.NaN]) {
      refuses({ pitchRange }, "voice.json: pitchRange must be a number from 0 to 3.");
    }
  });

  it("refuses an endpointMs that is not a whole number from 200 to 3000", () => {
    for (const endpointMs of [199, 3001, 200.5, "700", true, Number.NaN]) {
      refuses({ endpointMs }, "voice.json: endpointMs must be a whole number of milliseconds from 200 to 3000.");
    }
  });

  it("requires the organ object and its two fields", () => {
    for (const organ of [undefined, null, [], "organ", { python }, { models }]) {
      expect(() => parseVoiceFile({ ...base, organ })).toThrow(
        "voice.json: organ must be an object with python and models.",
      );
    }
  });

  it("names an unknown field in the organ", () => {
    expect(() => parseVoiceFile({ ...base, organ: { python, models, extra: "x" } })).toThrow(
      'Unknown field "extra" in voice.json\'s organ. Allowed: python, models.',
    );
  });

  it("refuses a relative or non-string python", () => {
    for (const bad of ["python", "", 7, null]) {
      expect(() => parseVoiceFile({ ...base, organ: { python: bad, models } })).toThrow(
        "voice.json: organ.python must be the absolute path of the organ's python.",
      );
    }
  });

  it("refuses a relative or non-string models folder", () => {
    for (const bad of ["models", "", 7, null]) {
      expect(() => parseVoiceFile({ ...base, organ: { python, models: bad } })).toThrow(
        "voice.json: organ.models must be the absolute path of the organ's models folder.",
      );
    }
  });
});

describe("organProblems", () => {
  const file = parseVoiceFile({ organ: { python, models } });
  const script = resolve("voice-test", "organ", "voice_organ.py");

  it("says nothing when the python, the script and every model file are there", () => {
    expect(organProblems(file, () => true, script)).toEqual([]);
  });

  it("names the python and each missing model file in order", () => {
    const missing = new Set([join(models, "tiny-voca/config.json"), join(models, "parakeet/model.int8.onnx")]);
    const exists = (path: string): boolean => path !== python && !missing.has(path);
    expect(organProblems(file, exists, script)).toEqual([
      `voice.json: organ.python is ${python}, and there is no such file.`,
      `voice.json: the models folder ${models} has no tiny-voca/config.json.`,
      `voice.json: the models folder ${models} has no parakeet/model.int8.onnx.`,
    ]);
  });

  it("names a missing organ script", () => {
    const exists = (path: string): boolean => path !== script;
    expect(organProblems(file, exists, script)).toEqual([
      `voice.json: the organ script ${script} is missing from this checkout.`,
    ]);
  });
});
