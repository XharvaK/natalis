"""The voice organ, spike version: speaking (tiny-voca) and hearing (Silero VAD) behind one framed pipe.

Silent by construction: it never opens an audio device. Node talks to it over stdin/stdout.
Frame: u32 header length, header JSON (utf-8), u32 body length, body bytes. One reply per request, in order.

Ops
  hello                                    -> ready
  speak   {utt, text, voice, speed, pitch_shift, pitch_range, pause_ms, channels, bitrate}
                                           -> spoken {utt, audio_ms, words, ms}; the PCM joins the utterance's queue
  frames  {utt, n, gain}                   -> packets {utt, lens, pos_ms, left_ms}; body: n Opus packets, then 48 kHz PCM16
  flush   {utt}                            -> flushed {utt, pos_ms, dropped_ms}
  encode_clip {path}                       -> clip {lens, onset_ms}; body: 20 ms stereo Opus packets (a speaker, for tests)
  hear    {stream}; body: u16-prefixed Opus packets -> heard {stream, probs, t_ms}
"""
import ctypes, json, os, queue, struct, sys, threading, time
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
TTS_DIR = os.environ.get("TINY_VOCA_DIR", os.path.expanduser("~/bench/tiny-voca"))
VAD_PATH = os.environ.get("SILERO_VAD", os.path.expanduser("~/bench/stt/models/silero_vad_v5.onnx"))
os.environ.setdefault("DIZIONE_DATA", os.path.join(TTS_DIR, "phonemizer"))
import dizione  # noqa: E402
from dizione.symbols import PHONE_SET  # noqa: E402

SR_TTS, SR_OUT, SR_VAD = 24000, 48000, 16000
FRAME = 960  # 20 ms at 48 kHz
HOP_S = 256 / SR_TTS  # one duration unit of tiny-voca

# ---------------------------------------------------------------- Opus through the system libopus (no pip package)
_op = ctypes.CDLL("libopus.so.0")
_op.opus_encoder_create.restype = ctypes.c_void_p
_op.opus_decoder_create.restype = ctypes.c_void_p
_op.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_char_p, ctypes.c_int32]
_op.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int]
OPUS_APPLICATION_AUDIO, OPUS_SET_BITRATE = 2049, 4002


class Encoder:
    def __init__(self, channels, bitrate):
        err = ctypes.c_int()
        self.h = _op.opus_encoder_create(SR_OUT, channels, OPUS_APPLICATION_AUDIO, ctypes.byref(err))
        if err.value != 0:
            raise RuntimeError(f"opus_encoder_create failed: {err.value}")
        _op.opus_encoder_ctl(ctypes.c_void_p(self.h), OPUS_SET_BITRATE, ctypes.c_int(bitrate))
        self.channels = channels
        self.out = ctypes.create_string_buffer(4000)

    def encode(self, mono_i16):
        pcm = np.repeat(mono_i16, self.channels) if self.channels == 2 else mono_i16
        pcm = np.ascontiguousarray(pcm, dtype=np.int16)
        n = _op.opus_encode(self.h, pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), FRAME, self.out, 4000)
        if n < 0:
            raise RuntimeError(f"opus_encode failed: {n}")
        return self.out.raw[:n]


class Decoder:
    def __init__(self, channels=2):
        err = ctypes.c_int()
        self.h = _op.opus_decoder_create(SR_OUT, channels, ctypes.byref(err))
        self.channels = channels
        self.buf = (ctypes.c_int16 * (5760 * channels))()

    def decode(self, packet):
        n = _op.opus_decode(self.h, packet, len(packet), self.buf, 5760, 0)
        if n < 0:
            raise RuntimeError(f"opus_decode failed: {n}")
        pcm = np.frombuffer(self.buf, dtype=np.int16, count=n * self.channels).astype(np.float32) / 32768
        return pcm.reshape(-1, self.channels).mean(axis=1)


# ---------------------------------------------------------------- resampling: 24k -> 48k and 48k -> 16k, windowed-sinc FIRs
def _lowpass(taps, cutoff):
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff * n) * np.kaiser(taps, 8.0)
    return (h / h.sum()).astype(np.float32)


UP2 = _lowpass(63, 0.25) * 2   # cutoff 12 kHz at 48 kHz, gain 2 for the zero-stuffing
DOWN3 = _lowpass(63, 0.15)     # cutoff 7.2 kHz at 48 kHz, before keeping every third sample


def up2(x):
    y = np.zeros(len(x) * 2, dtype=np.float32)
    y[::2] = x
    return np.convolve(y, UP2, mode="same")


class Down3:
    """48 kHz -> 16 kHz across packet boundaries (keeps its filter tail and phase)."""

    def __init__(self):
        self.tail = np.zeros(len(DOWN3) - 1, dtype=np.float32)
        self.phase = 0

    def push(self, x):
        z = np.concatenate([self.tail, x])
        y = np.convolve(z, DOWN3, mode="valid")
        self.tail = z[-(len(DOWN3) - 1):]
        out = y[self.phase::3]
        self.phase = (self.phase - len(y)) % 3
        return out


# ---------------------------------------------------------------- speaking
so = ort.SessionOptions()
so.intra_op_num_threads = 1
so.inter_op_num_threads = 1
so.add_session_config_entry("session.intra_op.allow_spinning", "0")
TTS = ort.InferenceSession(os.path.join(TTS_DIR, "onnx", "model.onnx"), so, providers=["CPUExecutionProvider"])
VAD = ort.InferenceSession(VAD_PATH, so, providers=["CPUExecutionProvider"])


def trim(audio, thresh=0.008, keep=int(0.015 * SR_TTS)):
    idx = np.flatnonzero(np.abs(audio) > thresh)
    if len(idx) == 0:
        return audio[:0], 0
    a, b = max(0, idx[0] - keep), min(len(audio), idx[-1] + keep)
    return audio[a:b], a


def synth(text, voice, speed, pitch_shift, pitch_range):
    t0 = time.perf_counter()
    p = dizione.phonemize(text)
    t1 = time.perf_counter()
    one = lambda v: np.array([v], dtype=np.float32)
    audio, durations = TTS.run(None, {
        "tokens": np.array([p.ids], dtype=np.int64), "stress": np.array([p.stress], dtype=np.int64),
        "voice": np.array([voice], dtype=np.int64), "speed": one(speed), "pitch_shift": one(pitch_shift), "pitch_range": one(pitch_range)})
    t2 = time.perf_counter()
    audio, cut = trim(audio[0])
    # Word timings from the model's own per-token durations: a word is the run of phones between spaces or marks.
    words, start, t = [], None, 0.0
    for sym, d in zip(p.symbols, durations[0]):
        dur = float(d) * HOP_S
        if sym in PHONE_SET or sym == "<unk>":
            start = t if start is None else start
        elif start is not None:
            words.append([round((start - cut / SR_TTS) * 1000), round((t - cut / SR_TTS) * 1000)])
            start = None
        t += dur
    if start is not None:
        words.append([round((start - cut / SR_TTS) * 1000), round((t - cut / SR_TTS) * 1000)])
    return audio, words, {"phonemize": round((t1 - t0) * 1000, 1), "synth": round((t2 - t1) * 1000, 1)}


class Utterance:
    def __init__(self, channels, bitrate):
        self.enc = Encoder(channels, bitrate)
        self.pcm = np.zeros(0, dtype=np.float32)  # 48 kHz, not yet encoded
        self.pos = 0  # samples already encoded


utts = {}
cancelled = set()  # utterances flushed by a barge-in: chunks still queued for them are dropped


def op_speak(h, body):
    t0 = time.perf_counter()
    with LOCK:
        if h["utt"] in cancelled:
            return {"op": "spoken", "utt": h["utt"], "skipped": True}, b""
        u = utts.get(h["utt"])
        if u is None:
            u = utts[h["utt"]] = Utterance(h.get("channels", 2), h.get("bitrate", 64000))
    audio, words, ms = synth(h["text"], h.get("voice", 0), h.get("speed", 1.0), h.get("pitch_shift", 0.0), h.get("pitch_range", 1.0))
    t1 = time.perf_counter()
    out = up2(audio)
    pause = np.zeros(int(SR_OUT * h.get("pause_ms", 0) / 1000), dtype=np.float32)
    with LOCK:
        offset_ms = (u.pos + len(u.pcm)) / SR_OUT * 1000  # where this chunk starts in the utterance
        u.pcm = np.concatenate([u.pcm, out, pause])
    ms["post"] = round((time.perf_counter() - t1) * 1000, 1)
    ms["total"] = round((time.perf_counter() - t0) * 1000, 1)
    return {"op": "spoken", "utt": h["utt"], "audio_ms": round(len(out) / SR_OUT * 1000), "offset_ms": round(offset_ms),
            "words": [[a + round(offset_ms), b + round(offset_ms)] for a, b in words], "ms": ms}, b""


def op_frames(h, body):
    u = utts[h["utt"]]
    gain = float(h.get("gain", 1.0))
    packets, pcm_out = [], []
    for _ in range(int(h.get("n", 1))):
        if len(u.pcm) == 0:
            break
        frame = u.pcm[:FRAME]
        if len(frame) < FRAME:
            if not h.get("final"):
                break  # wait for the next chunk rather than pad mid-utterance
            frame = np.pad(frame, (0, FRAME - len(frame)))
        u.pcm = u.pcm[FRAME:]
        u.pos += FRAME
        i16 = (np.clip(frame * gain, -1, 1) * 32767).astype(np.int16)
        packets.append(u.enc.encode(i16))
        pcm_out.append(i16)
    body = b"".join(packets) + (np.concatenate(pcm_out).tobytes() if pcm_out else b"")
    return {"op": "packets", "utt": h["utt"], "lens": [len(p) for p in packets], "pos_ms": round(u.pos / SR_OUT * 1000),
            "left_ms": round(len(u.pcm) / SR_OUT * 1000)}, body


def op_flush(h, body):
    cancelled.add(h["utt"])
    u = utts.pop(h["utt"], None)
    if u is None:
        return {"op": "flushed", "utt": h["utt"], "pos_ms": 0, "dropped_ms": 0}, b""
    return {"op": "flushed", "utt": h["utt"], "pos_ms": round(u.pos / SR_OUT * 1000), "dropped_ms": round(len(u.pcm) / SR_OUT * 1000)}, b""


# ---------------------------------------------------------------- hearing
class Ear:
    def __init__(self):
        self.dec = Decoder(2)
        self.down = Down3()
        self.buf = np.zeros(0, dtype=np.float32)
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)
        self.t = 0  # 16 kHz samples given to the VAD


ears = {}


def op_hear(h, body):
    ear = ears.setdefault(h["stream"], Ear())
    i = 0
    while i < len(body):
        (n,) = struct.unpack(">H", body[i:i + 2])
        ear.buf = np.concatenate([ear.buf, ear.down.push(ear.dec.decode(body[i + 2:i + 2 + n]))])
        i += 2 + n
    probs, t_ms = [], round(ear.t / SR_VAD * 1000)
    while len(ear.buf) >= 512:
        win, ear.buf = ear.buf[:512], ear.buf[512:]
        x = np.concatenate([ear.context, win])[None, :]  # v5 wants 64 samples of context before each window
        out, ear.state = VAD.run(None, {"input": x, "state": ear.state, "sr": np.array(SR_VAD, dtype=np.int64)})
        ear.context = win[-64:]
        ear.t += 512
        probs.append(round(float(out[0][0]), 3))
    return {"op": "heard", "stream": h["stream"], "probs": probs, "t_ms": t_ms}, b""


def op_encode_clip(h, body):
    """A stand-in for the summoner's Discord client: a WAV file as 20 ms stereo Opus packets, and where speech starts."""
    import wave
    with wave.open(h["path"]) as w:
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    x = x.reshape(-1, ch).mean(axis=1)
    if sr != SR_OUT:
        x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * SR_OUT / sr)), np.arange(len(x)), x).astype(np.float32)
    rms = np.sqrt(np.convolve(x * x, np.ones(480) / 480, mode="same"))
    loud = np.flatnonzero(rms > 10 ** (-35 / 20))
    onset_ms = round(loud[0] / SR_OUT * 1000) if len(loud) else 0
    enc = Encoder(2, 64000)
    packets = []
    for i in range(0, len(x) - FRAME + 1, FRAME):
        packets.append(enc.encode((np.clip(x[i:i + FRAME], -1, 1) * 32767).astype(np.int16)))
    return {"op": "clip", "lens": [len(p) for p in packets], "onset_ms": onset_ms}, b"".join(packets)


OPS = {"speak": op_speak, "frames": op_frames, "flush": op_flush, "hear": op_hear, "encode_clip": op_encode_clip}


def read_exact(f, n):
    data = b""
    while len(data) < n:
        chunk = f.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


LOCK = threading.Lock()  # guards the utterance queues and the pipe


def main():
    fin, fout = sys.stdin.buffer, sys.stdout.buffer

    def send(header, body=b""):
        hb = json.dumps(header).encode()
        fout.write(struct.pack(">I", len(hb)) + hb + struct.pack(">I", len(body)) + body)
        fout.flush()

    def run(header, body):
        try:
            if header["op"] == "speak":
                reply, out = op_speak(header, body)  # synthesis runs outside the lock; ORT releases the GIL
            else:
                with LOCK:
                    reply, out = OPS[header["op"]](header, body)
        except Exception as e:  # fail loudly: the error goes back as a reply, never swallowed
            reply, out = {"op": "error", "for": header.get("op"), "error": f"{type(e).__name__}: {e}"}, b""
        reply["id"] = header.get("id")
        with LOCK:
            send(reply, out)

    # Speaking runs on its own thread, in order, so frames keep flowing while the next sentence is made.
    jobs = queue.Queue()

    def speaker():
        while True:
            job = jobs.get()
            if job is None:
                return
            run(*job)

    threading.Thread(target=speaker, daemon=True).start()
    synth("Warm up.", 0, 1.0, 0.0, 1.0)
    with LOCK:
        send({"op": "ready", "voices": ["F2", "M2"], "sample_rate": SR_OUT, "frame_ms": 20, "phonemizer": dizione.VERSION})
    while True:
        raw = read_exact(fin, 4)
        if raw is None:
            jobs.put(None)
            return
        header = json.loads(read_exact(fin, struct.unpack(">I", raw)[0]))
        body = read_exact(fin, struct.unpack(">I", read_exact(fin, 4))[0]) or b""
        if header["op"] == "speak":
            jobs.put((header, body))
        else:
            run(header, body)


if __name__ == "__main__":
    main()
