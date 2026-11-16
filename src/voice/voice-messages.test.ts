import { describe, expect, it, vi } from "vitest";
import { OrganError, type OrganCaller, type OrganReady, type OrganReply } from "./organ-client.js";
import { oggPage, readOggOpus, waveform, writeOggOpus } from "./ogg.js";
import {
  createVoiceMessages,
  VoiceError,
  VOICE_MESSAGE_MAX_S,
  VOICE_MESSAGE_MAX_WORDS,
  HEAR_MAX_S,
  type VoiceSettings,
} from "./voice-messages.js";

const READY: OrganReady = {
  protocol: 1,
  voices: ["F2", "M2"],
  sampleRate: 48000,
  frameMs: 20,
  lookahead: 288,
  phonemizer: "dizione-test",
  stt: "parakeet-test",
};

const SETTINGS: VoiceSettings = { voice: "F2", speed: 1.1, pitchShift: 0.058, pitchRange: 1.2 };

type RecordedCall = { header: Record<string, unknown>; body: Uint8Array; options?: { timeoutMs?: number } };
type FrameReply = { packets: Uint8Array[]; samples: Int16Array };

function framesReply(utt: unknown, reply: FrameReply): OrganReply {
  const sampleBytes = Buffer.alloc(reply.samples.length * 2);
  const view = new DataView(sampleBytes.buffer, sampleBytes.byteOffset, sampleBytes.byteLength);
  for (let i = 0; i < reply.samples.length; i += 1) view.setInt16(i * 2, reply.samples[i]!, true);
  return {
    header: { op: "packets", utt, lens: reply.packets.map((packet) => packet.length) },
    body: Buffer.concat([...reply.packets.map((packet) => Buffer.from(packet)), sampleBytes]),
  };
}

class FakeOrgan implements OrganCaller {
  readonly calls: RecordedCall[] = [];
  restingText: string | undefined;
  readyFrame: OrganReady | undefined;
  speakError: Error | undefined;
  flushError: Error | undefined;
  transcriptError: Error | undefined;
  transcriptHeader: Record<string, unknown> = { text: "", audio_ms: 0, heard_ms: 0, model: "parakeet-test" };
  framesReplies: FrameReply[] = [{ packets: [], samples: new Int16Array(0) }];
  private frameIndex = 0;

  resting(): string | undefined {
    return this.restingText;
  }

  ready(): OrganReady | undefined {
    return this.readyFrame;
  }

  async call(header: Record<string, unknown>, body: Uint8Array = new Uint8Array(), options?: { timeoutMs?: number }): Promise<OrganReply> {
    this.calls.push({ header, body, options });
    switch (header["op"]) {
      case "speak":
        if (this.speakError) throw this.speakError;
        return { header: { op: "spoken", utt: header["utt"], audio_ms: 1000 }, body: new Uint8Array() };
      case "frames": {
        const reply = this.framesReplies[this.frameIndex] ?? { packets: [], samples: new Int16Array(0) };
        this.frameIndex += 1;
        return framesReply(header["utt"], reply);
      }
      case "flush":
        if (this.flushError) throw this.flushError;
        return { header: { op: "flushed", utt: header["utt"] }, body: new Uint8Array() };
      case "transcribe":
        if (this.transcriptError) throw this.transcriptError;
        return { header: { op: "transcript", ...this.transcriptHeader }, body: new Uint8Array() };
      default:
        throw new Error(`the fake organ does not know ${String(header["op"])}`);
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("it did not reject");
}

function voiceError(error: unknown): VoiceError {
  expect(error).toBeInstanceOf(VoiceError);
  return error as VoiceError;
}

describe("voice message constants", () => {
  it("holds two minutes of speech", () => {
    expect(VOICE_MESSAGE_MAX_S).toBe(120);
    expect(VOICE_MESSAGE_MAX_WORDS).toBe(360);
    expect(HEAR_MAX_S).toBe(300);
  });
});

describe("make", () => {
  it("speaks each part, frames until empty, flushes, and returns the Ogg, its seconds and waveform", async () => {
    const fake = new FakeOrgan();
    fake.readyFrame = READY;
    const packets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6]), Buffer.from([7, 8, 9])];
    const samples = Int16Array.from({ length: 3 * 960 }, (_, i) => ((i % 200) - 100) * 137);
    fake.framesReplies = [{ packets, samples }, { packets: [], samples: new Int16Array(0) }];

    const voice = createVoiceMessages(fake, SETTINGS);
    const made = await voice.make("Hi there! 😊 How are you?");

    expect(fake.calls.map((entry) => entry.header["op"])).toEqual(["speak", "speak", "frames", "frames", "flush"]);
    const speaks = fake.calls.filter((entry) => entry.header["op"] === "speak");
    expect(speaks[0]!.header).toEqual({
      op: "speak",
      utt: "vm-1",
      text: "Hi there!",
      voice: "F2",
      speed: 1.1,
      pitch_shift: 0.058,
      pitch_range: 1.2,
      pause_ms: 320,
      channels: 1,
      bitrate: 32000,
    });
    expect(speaks[1]!.header["text"]).toBe("How are you?");
    expect(speaks[1]!.header["utt"]).toBe("vm-1");
    expect(speaks[1]!.header["pause_ms"]).toBe(0);

    for (const entry of fake.calls.filter((call) => call.header["op"] === "frames")) {
      expect(entry.header).toEqual({ op: "frames", utt: "vm-1", n: 250, final: true, pcm: true });
    }
    expect(fake.calls.at(-1)!.header).toEqual({ op: "flush", utt: "vm-1" });

    const read = readOggOpus(made.ogg);
    expect(read.channels).toBe(1);
    expect(read.preSkip).toBe(288);
    expect(read.packets).toHaveLength(packets.length);
    for (let i = 0; i < packets.length; i += 1) expect(Buffer.from(read.packets[i]!).toString("hex")).toBe(packets[i]!.toString("hex"));
    expect(made.seconds).toBeCloseTo(packets.length * 0.02, 10);
    expect(read.seconds).toBeCloseTo(made.seconds, 10);
    expect(made.waveform).toBe(waveform(samples));
    expect(made.skipped).toEqual(["an emoji"]);
  });

  it("numbers utterances per instance", async () => {
    const fake = new FakeOrgan();
    const audio = { packets: [Buffer.from([1, 2, 3])], samples: new Int16Array(0) };
    const empty = { packets: [], samples: new Int16Array(0) };
    fake.framesReplies = [audio, empty, audio, empty];
    const voice = createVoiceMessages(fake, SETTINGS);
    await voice.make("Hello there.");
    await voice.make("Hello again.");
    const utts = fake.calls.filter((entry) => entry.header["op"] === "speak").map((entry) => entry.header["utt"]);
    expect(utts).toEqual(["vm-1", "vm-2"]);
  });

  it("refuses more than 360 words without calling the organ", async () => {
    const fake = new FakeOrgan();
    const voice = createVoiceMessages(fake, SETTINGS);
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const error = voiceError(await rejection(voice.make(text)));
    expect(error.kind).toBe("too_long");
    expect(error.message).toBe("it is about 400 words, more than two minutes of speech; a voice message holds at most 2 minutes");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses more than 120 s of packets and still flushes", async () => {
    const fake = new FakeOrgan();
    fake.framesReplies = [
      { packets: Array.from({ length: 6001 }, () => Buffer.from([1])), samples: new Int16Array(0) },
      { packets: [], samples: new Int16Array(0) },
    ];
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.make("Hello there.")));
    expect(error.kind).toBe("too_long");
    expect(error.message).toBe("it came to 120 s of speech; a voice message holds at most 2 minutes");
    expect(fake.calls.filter((entry) => entry.header["op"] === "flush")).toHaveLength(1);
  });

  it("says what it left out when nothing can be spoken", async () => {
    const fake = new FakeOrgan();
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.make("😊 ```\nx\n```")));
    expect(error.kind).toBe("nothing_to_say");
    expect(error.message).toBe("nothing in it can be spoken aloud (left out: an emoji; a code block (1 line))");
    expect(fake.calls).toHaveLength(0);
  });

  it("leaves out the parenthesis when nothing was skipped", async () => {
    const fake = new FakeOrgan();
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.make("   ")));
    expect(error.kind).toBe("nothing_to_say");
    expect(error.message).toBe("nothing in it can be spoken aloud");
    expect(fake.calls).toHaveLength(0);
  });

  it("is resting, in the organ's own words, without calling it", async () => {
    const fake = new FakeOrgan();
    fake.restingText = "the voice organ is catching its breath";
    const voice = createVoiceMessages(fake, SETTINGS);
    expect(voice.resting()).toBe("the voice organ is catching its breath");
    const error = voiceError(await rejection(voice.make("Hello there.")));
    expect(error.kind).toBe("resting");
    expect(error.message).toBe("the voice organ is catching its breath");
    expect(fake.calls).toHaveLength(0);
  });

  it("calls a failed speak an organ failure, and still flushes", async () => {
    const fake = new FakeOrgan();
    fake.speakError = new OrganError("no voice model", "failed");
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.make("Hello there.")));
    expect(error.kind).toBe("organ");
    expect(error.message).toBe("your voice organ failed");
    expect(fake.calls.map((entry) => entry.header["op"])).toEqual(["speak", "flush"]);
  });

  it("keeps an organ error's own words in the host log, not in the reason", async () => {
    const fake = new FakeOrgan();
    fake.speakError = new OrganError("Traceback: /home/x/organ.py line 9 secret-detail", "failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const voice = createVoiceMessages(fake, SETTINGS);
      const error = voiceError(await rejection(voice.make("Hello there.")));
      expect(error.kind).toBe("organ");
      expect(error.message).toBe("your voice organ failed");
      expect(error.message).not.toContain("Traceback");
      expect(error.message).not.toContain("secret-detail");
      expect(logged).toHaveBeenCalledWith("natalis: the voice organ failed: Traceback: /home/x/organ.py line 9 secret-detail");
    } finally {
      logged.mockRestore();
    }
  });

  it("takes a resting OrganError as resting", async () => {
    const fake = new FakeOrgan();
    fake.speakError = new OrganError("the organ is not ready", "resting");
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.make("Hello there.")));
    expect(error.kind).toBe("resting");
    expect(error.message).toBe("the organ is not ready");
    expect(fake.calls.map((entry) => entry.header["op"])).toEqual(["speak", "flush"]);
  });
});

describe("hear", () => {
  it("sends the file's channels and length-prefixed packets, and reports what was heard", async () => {
    const packets = [Buffer.from([1, 2, 3]), Buffer.from([4, 5]), Buffer.from([6, 7, 8, 9])];
    const file = writeOggOpus(packets, { channels: 2, preSkip: 100 });
    const fake = new FakeOrgan();
    fake.transcriptHeader = { text: "Hello there.", audio_ms: 60, heard_ms: 40, model: "parakeet-test" };

    const heard = await createVoiceMessages(fake, SETTINGS).hear(file);

    expect(heard.text).toBe("Hello there.");
    expect(heard.seconds).toBeCloseTo(0.06, 10);
    expect(heard.heardSeconds).toBeCloseTo(0.04, 10);
    expect(heard.model).toBe("parakeet-test");

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.header).toEqual({ op: "transcribe", channels: 2, max_s: 300 });
    expect(call.options).toEqual({ timeoutMs: 300000 });
    const expected: number[] = [];
    for (const packet of packets) expected.push(packet.length >> 8, packet.length & 0xff, ...packet);
    expect(Array.from(call.body)).toEqual(expected);
  });

  it("uses audio_ms when the file itself says nothing about its length", async () => {
    const packet = Buffer.alloc(50, 4);
    const base = writeOggOpus([packet], { preSkip: 312 });
    const pages: Buffer[] = [];
    let at = 0;
    while (at < base.length) {
      const count = base[at + 26]!;
      let body = 0;
      for (let i = 0; i < count; i += 1) body += base[at + 27 + i]!;
      const end = at + 27 + count + body;
      pages.push(Buffer.from(base.subarray(at, end)));
      at = end;
    }
    // A granule equal to the pre-skip says zero seconds; the organ's audio_ms is then the length.
    const audio = pages[2]!;
    const audioData = audio.subarray(27 + audio[26]!);
    const rebuilt = oggPage({ data: audioData, lacing: [packet.length], granule: 312, serial: pages[0]!.readUInt32LE(14), seq: 2, flags: 0x04 });
    const file = Buffer.concat([pages[0]!, pages[1]!, rebuilt]);

    const fake = new FakeOrgan();
    fake.transcriptHeader = { text: "", audio_ms: 30, heard_ms: 30, model: "parakeet-test" };
    expect(readOggOpus(file).seconds).toBe(0);
    const heard = await createVoiceMessages(fake, SETTINGS).hear(file);
    expect(heard.seconds).toBeCloseTo(0.03, 10);
  });

  it("names bytes that are not an Ogg file as bad audio, without calling the organ", async () => {
    const fake = new FakeOrgan();
    const voice = createVoiceMessages(fake, SETTINGS);
    const error = voiceError(await rejection(voice.hear(Buffer.from("this is not audio at all"))));
    expect(error.kind).toBe("bad_audio");
    expect(error.message).toBe("the voice message could not be read: it is not an Ogg file");
    expect(fake.calls).toHaveLength(0);
  });
});
