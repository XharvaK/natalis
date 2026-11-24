"""The voice organ: speaking (tiny-voca), hearing (Parakeet) and Opus, behind one framed pipe.

Silent by construction: it never opens an audio device. Node talks to it over stdin/stdout.
Frame: u32 header length, header JSON (utf-8), u32 body length, body bytes.
The protocol is organ/PROTOCOL.md.
"""

import collections
import ctypes
import ctypes.util
import json
import math
import os
import queue
import struct
import sys
import threading
import time

import numpy as np

SR_TTS = 24000
SR_OUT = 48000
SR_HEAR = 16000
FRAME = 960  # 20 ms at 48 kHz
HOP_S = 256 / SR_TTS  # one duration unit of tiny-voca
BLOCK = 320  # 20 ms at 16 kHz
MODEL_NAME = "parakeet-tdt-ctc-110m-int8"
MAX_HEADER = 1 << 20
MAX_BODY = 64 << 20
OPUS_APPLICATION_AUDIO = 2049
OPUS_SET_BITRATE = 4002
OPUS_GET_LOOKAHEAD = 4027


# ---------------------------------------------------------------- Opus through the system libopus (no pip package)
_opus_lib = None


def _opus():
    """Load libopus once, on first use."""
    global _opus_lib
    if _opus_lib is None:
        name = ctypes.util.find_library("opus") or "libopus.so.0"
        lib = ctypes.CDLL(name)
        lib.opus_encoder_create.restype = ctypes.c_void_p
        lib.opus_encoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.opus_decoder_create.restype = ctypes.c_void_p
        lib.opus_decoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.opus_encode.restype = ctypes.c_int
        lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int,
                                    ctypes.c_char_p, ctypes.c_int32]
        lib.opus_decode.restype = ctypes.c_int
        lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32,
                                    ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int]
        lib.opus_encoder_ctl.restype = ctypes.c_int
        lib.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.opus_encoder_destroy.restype = None
        lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
        lib.opus_decoder_destroy.restype = None
        lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
        _opus_lib = lib
    return _opus_lib


class Encoder:
    def __init__(self, channels, bitrate):
        op = _opus()
        self.op = op
        self.h = None
        err = ctypes.c_int()
        self.h = op.opus_encoder_create(SR_OUT, channels, OPUS_APPLICATION_AUDIO, ctypes.byref(err))
        if not self.h or err.value != 0:
            self.h = None
            raise RuntimeError(f"opus_encoder_create failed: {err.value}")
        result = op.opus_encoder_ctl(ctypes.c_void_p(self.h), OPUS_SET_BITRATE, ctypes.c_int(int(bitrate)))
        if result != 0:
            raise RuntimeError(f"opus_encoder_ctl failed: {result}")
        self.channels = channels
        self.out = ctypes.create_string_buffer(4000)

    def encode(self, mono_int16):
        if self.h is None:
            raise RuntimeError("encoder is closed")
        pcm = np.repeat(mono_int16, self.channels) if self.channels == 2 else mono_int16
        pcm = np.ascontiguousarray(pcm, dtype=np.int16)
        n = self.op.opus_encode(self.h, pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), FRAME, self.out, 4000)
        if n < 0:
            raise RuntimeError(f"opus_encode failed: {n}")
        return self.out.raw[:n]

    def close(self):
        if self.h is not None:
            h, self.h = self.h, None
            self.op.opus_encoder_destroy(h)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


class Decoder:
    def __init__(self, channels=2):
        op = _opus()
        self.op = op
        self.h = None
        err = ctypes.c_int()
        self.h = op.opus_decoder_create(SR_OUT, channels, ctypes.byref(err))
        if not self.h or err.value != 0:
            self.h = None
            raise RuntimeError(f"opus_decoder_create failed: {err.value}")
        self.channels = channels
        self.buf = (ctypes.c_int16 * (5760 * channels))()

    def decode(self, packet):
        if self.h is None:
            raise RuntimeError("decoder is closed")
        n = self.op.opus_decode(self.h, packet, len(packet), self.buf, 5760, 0)
        if n < 0:
            raise RuntimeError(f"opus_decode failed: {n}")
        pcm = np.frombuffer(self.buf, dtype=np.int16, count=n * self.channels).astype(np.float32) / 32768
        return pcm.reshape(-1, self.channels).mean(axis=1)

    def close(self):
        if self.h is not None:
            h, self.h = self.h, None
            self.op.opus_decoder_destroy(h)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def lookahead():
    """The Opus encoder's lookahead in samples at 48 kHz (OPUS_GET_LOOKAHEAD)."""
    op = _opus()
    err = ctypes.c_int()
    enc = op.opus_encoder_create(SR_OUT, 1, OPUS_APPLICATION_AUDIO, ctypes.byref(err))
    if not enc or err.value != 0:
        raise RuntimeError(f"opus_encoder_create failed: {err.value}")
    try:
        value = ctypes.c_int()
        result = op.opus_encoder_ctl(ctypes.c_void_p(enc), OPUS_GET_LOOKAHEAD, ctypes.byref(value))
        if result != 0:
            raise RuntimeError(f"opus_encoder_ctl failed: {result}")
        return int(value.value)
    finally:
        op.opus_encoder_destroy(ctypes.c_void_p(enc))


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


def cut_pieces(audio16k, max_s=30, look_s=5):
    """Cut 16 kHz audio into pieces of at most max_s seconds, at the quietest 20 ms near each mark."""
    audio = np.asarray(audio16k)
    max_n = int(round(max_s * SR_HEAR))
    look_n = int(round(look_s * SR_HEAR))
    pieces = []
    pos = 0
    while len(audio) - pos > max_n:
        start = max(pos, pos + max_n - look_n)
        end = pos + max_n
        window = audio[start:end]
        best_i, best_e = 0, None
        for i in range(0, len(window) - BLOCK + 1, BLOCK):
            block = window[i:i + BLOCK].astype(np.float64)
            e = float(np.sum(block * block))
            if best_e is None or e < best_e:
                best_i, best_e = i, e
        cut = start + best_i
        pieces.append(audio[pos:cut])
        pos = cut
    pieces.append(audio[pos:])
    return pieces


def split_packets(body):
    """Read u16 big-endian length before each Opus packet."""
    body = bytes(body)
    packets = []
    i = 0
    while i < len(body):
        if i + 2 > len(body):
            raise ValueError("the packets end in the middle of one")
        (n,) = struct.unpack(">H", body[i:i + 2])
        i += 2
        if i + n > len(body):
            raise ValueError("the packets end in the middle of one")
        packets.append(body[i:i + n])
        i += n
    return packets


# ---------------------------------------------------------------- models (loaded only by main, so the pure parts import without them)
TTS = None
RECOGNIZER = None
DIZIONE = None
PHONE_SET = frozenset()
VOICES = []


def load_models(models):
    global TTS, RECOGNIZER, DIZIONE, PHONE_SET, VOICES
    with open(os.path.join(models, "tiny-voca", "config.json"), encoding="utf-8") as f:
        config = json.load(f)
    voices = config["voices"]
    trained_on = config["phonemizer"]["version"]

    os.environ["DIZIONE_DATA"] = os.path.join(models, "tiny-voca", "phonemizer")
    import onnxruntime as ort
    import sherpa_onnx
    import dizione
    from dizione.symbols import PHONE_SET as phone_set

    if str(trained_on) != str(dizione.VERSION):
        raise RuntimeError(f"the speaking model was trained on dizione {trained_on}, "
                           f"but dizione {dizione.VERSION} is installed")

    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    tts = ort.InferenceSession(os.path.join(models, "tiny-voca", "onnx", "model.onnx"), so,
                               providers=["CPUExecutionProvider"])
    recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=os.path.join(models, "parakeet", "model.int8.onnx"),
        tokens=os.path.join(models, "parakeet", "tokens.txt"),
        num_threads=1,
    )

    VOICES = list(voices)
    TTS = tts
    RECOGNIZER = recognizer
    DIZIONE = dizione
    PHONE_SET = phone_set


# ---------------------------------------------------------------- speaking
def trim(audio, thresh=0.008, keep=int(0.015 * SR_TTS)):
    idx = np.flatnonzero(np.abs(audio) > thresh)
    if len(idx) == 0:
        return audio[:0], 0
    a, b = max(0, idx[0] - keep), min(len(audio), idx[-1] + keep)
    return audio[a:b], a


def synth(text, voice, speed, pitch_shift, pitch_range):
    t0 = time.perf_counter()
    p = DIZIONE.phonemize(text)
    t1 = time.perf_counter()
    if len(p.ids) == 0:
        raise ValueError("the text has nothing to speak")
    one = lambda v: np.array([v], dtype=np.float32)
    audio, durations = TTS.run(None, {
        "tokens": np.array([p.ids], dtype=np.int64), "stress": np.array([p.stress], dtype=np.int64),
        "voice": np.array([voice], dtype=np.int64), "speed": one(speed), "pitch_shift": one(pitch_shift),
        "pitch_range": one(pitch_range)})
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


CANCELLED_MAX = 256
utts = {}
cancelled = collections.OrderedDict()  # the newest utterances flushed by a barge-in

LOCK = threading.Lock()  # guards the utterance queues and the pipe


# ---------------------------------------------------------------- field rules (PROTOCOL.md's tables)
_MISSING = object()


def _is_number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _is_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _str_field(header, name, low=None, high=None):
    value = header.get(name)
    if not isinstance(value, str):
        if low is None:
            raise ValueError(f"{name} must be a string")
        raise ValueError(f"{name} must be a string of {low} to {high} characters")
    if low is not None and not low <= len(value) <= high:
        raise ValueError(f"{name} must be a string of {low} to {high} characters")
    return value


def _number_field(header, name, low, high, default=_MISSING):
    if name not in header:
        if default is _MISSING:
            raise ValueError(f"{name} must be a number from {low} to {high}")
        return default
    value = header[name]
    if not _is_number(value) or value < low or value > high:
        raise ValueError(f"{name} must be a number from {low} to {high}")
    return value


def _integer_field(header, name, low, high, default=_MISSING):
    if name not in header:
        if default is _MISSING:
            raise ValueError(f"{name} must be an integer from {low} to {high}")
        return default
    value = header[name]
    if not _is_integer(value) or value < low or value > high:
        raise ValueError(f"{name} must be an integer from {low} to {high}")
    return value


def _bool_field(header, name, default):
    if name not in header:
        return default
    value = header[name]
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false")
    return value


def _channels_field(header):
    value = header.get("channels", _MISSING)
    if value is _MISSING or not _is_integer(value) or value not in (1, 2):
        raise ValueError("channels must be 1 or 2")
    return value


def _voice_index(header):
    value = header.get("voice")
    if not isinstance(value, str) or value not in VOICES:
        raise ValueError("voice must be one of " + ", ".join(VOICES))
    return VOICES.index(value)


# ---------------------------------------------------------------- ops
def op_speak(header, body):
    t0 = time.perf_counter()
    utt = _str_field(header, "utt", 1, 64)
    text = _str_field(header, "text", 1, 2000)
    voice = _voice_index(header)
    speed = _number_field(header, "speed", 0.5, 2.0)
    pitch_shift = _number_field(header, "pitch_shift", -0.5, 0.5)
    pitch_range = _number_field(header, "pitch_range", 0, 3)
    pause_ms = _integer_field(header, "pause_ms", 0, 5000)
    channels = _channels_field(header)
    bitrate = _integer_field(header, "bitrate", 6000, 510000)

    with LOCK:
        if utt in cancelled:
            return {"op": "spoken", "utt": utt, "skipped": True}, b""
        u = utts.get(utt)
        if u is None:
            u = utts[utt] = Utterance(channels, bitrate)
    audio, words, ms = synth(text, voice, speed, pitch_shift, pitch_range)
    t1 = time.perf_counter()
    out = up2(audio)
    pause = np.zeros(int(SR_OUT * pause_ms / 1000), dtype=np.float32)
    with LOCK:
        offset_ms = (u.pos + len(u.pcm)) / SR_OUT * 1000  # where this chunk starts in the utterance
        u.pcm = np.concatenate([u.pcm, out, pause])
    ms["post"] = round((time.perf_counter() - t1) * 1000, 1)
    ms["total"] = round((time.perf_counter() - t0) * 1000, 1)
    return {"op": "spoken", "utt": utt, "audio_ms": round(len(out) / SR_OUT * 1000),
            "offset_ms": round(offset_ms),
            "words": [[a + round(offset_ms), b + round(offset_ms)] for a, b in words], "ms": ms}, b""


def op_frames(header, body):
    utt = _str_field(header, "utt")
    n = _integer_field(header, "n", 1, 3000)
    gain = _number_field(header, "gain", 0, 1, 1)
    final = _bool_field(header, "final", False)
    pcm = _bool_field(header, "pcm", False)
    u = utts.get(utt)
    if u is None:
        raise KeyError(f"no utterance {utt}")
    packets, pcm_out = [], []
    for _ in range(n):
        if len(u.pcm) == 0:
            break
        frame = u.pcm[:FRAME]
        if len(frame) < FRAME:
            if not final:
                break  # wait for the next chunk rather than pad mid-utterance
            frame = np.pad(frame, (0, FRAME - len(frame)))
        u.pcm = u.pcm[FRAME:]
        u.pos += FRAME
        i16 = (np.clip(frame * gain, -1, 1) * 32767).astype(np.int16)
        packets.append(u.enc.encode(i16))
        pcm_out.append(i16)
    out = b"".join(packets)
    if pcm and pcm_out:
        out += np.concatenate(pcm_out).tobytes()
    return {"op": "packets", "utt": utt, "lens": [len(p) for p in packets],
            "pos_ms": round(u.pos / SR_OUT * 1000),
            "left_ms": round(len(u.pcm) / SR_OUT * 1000)}, out


def op_flush(header, body):
    utt = _str_field(header, "utt")
    cancelled[utt] = None
    cancelled.move_to_end(utt)
    while len(cancelled) > CANCELLED_MAX:
        cancelled.popitem(last=False)
    u = utts.pop(utt, None)
    if u is None:
        return {"op": "flushed", "utt": utt, "pos_ms": 0, "dropped_ms": 0}, b""
    reply = {"op": "flushed", "utt": utt, "pos_ms": round(u.pos / SR_OUT * 1000),
             "dropped_ms": round(len(u.pcm) / SR_OUT * 1000)}
    u.enc.close()
    return reply, b""


def op_transcribe(header, body):
    channels = _channels_field(header)
    max_s = _number_field(header, "max_s", 1, 600, 300)
    t0 = time.perf_counter()
    if not body:
        return {"op": "transcript", "text": "", "audio_ms": 0, "heard_ms": 0, "model": MODEL_NAME,
                "ms": {"decode": 0.0, "recognize": 0.0}}, b""
    packets = split_packets(body)
    # One decoder for the whole message: Opus carries state from packet to packet. Only the first max_s seconds are
    # kept in memory; the rest is decoded to count the message's length, then dropped.
    decoder = Decoder(channels)
    try:
        keep = int(max_s * SR_OUT)
        parts, kept, total = [], 0, 0
        for packet in packets:
            pcm = decoder.decode(packet)
            total += len(pcm)
            if kept < keep:
                parts.append(pcm[:keep - kept])
                kept += len(parts[-1])
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        audio16 = Down3().push(audio) if len(audio) else np.zeros(0, dtype=np.float32)
        audio16 = audio16[:int(max_s * SR_HEAR)]
        t1 = time.perf_counter()
        texts = []
        for piece in cut_pieces(audio16):
            s = RECOGNIZER.create_stream()
            s.accept_waveform(SR_HEAR, np.asarray(piece, dtype=np.float32))
            RECOGNIZER.decode_stream(s)
            text = s.result.text.strip()
            if text:
                texts.append(text)
        t2 = time.perf_counter()
        return {"op": "transcript", "text": " ".join(texts), "audio_ms": round(total / 48),
                "heard_ms": round(len(audio16) / 16), "model": MODEL_NAME,
                "ms": {"decode": round((t1 - t0) * 1000, 1), "recognize": round((t2 - t1) * 1000, 1)}}, b""
    finally:
        decoder.close()


# ---------------------------------------------------------------- the pipe
def read_exact(f, n):
    data = b""
    while len(data) < n:
        chunk = f.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def _models_arg(argv):
    for i, arg in enumerate(argv):
        if arg == "--models" and i + 1 < len(argv) and argv[i + 1]:
            return argv[i + 1]
        if arg.startswith("--models=") and len(arg) > len("--models="):
            return arg.split("=", 1)[1]
    print("usage: voice_organ.py --models <folder>", file=sys.stderr, flush=True)
    raise SystemExit(2)


def main(argv):
    models = _models_arg(argv)
    if hasattr(os, "nice"):
        os.nice(10)

    fin, fout = sys.stdin.buffer, sys.stdout.buffer

    def send(header, body=b""):
        hb = json.dumps(header).encode()
        with LOCK:
            fout.write(struct.pack(">I", len(hb)) + hb + struct.pack(">I", len(body)) + body)
            fout.flush()

    def run(header, body):
        try:
            op = header.get("op")
            if op == "speak":
                reply, out = op_speak(header, body)  # synthesis runs outside the lock; ORT releases the GIL
            elif op == "transcribe":
                reply, out = op_transcribe(header, body)  # recognition runs outside the lock
            else:
                with LOCK:
                    if op == "ping":
                        reply, out = {"op": "pong"}, b""
                    elif op == "frames":
                        reply, out = op_frames(header, body)
                    elif op == "flush":
                        reply, out = op_flush(header, body)
                    else:
                        raise ValueError(f"unknown op {op}")
        except Exception as e:  # fail loudly: the error goes back as a reply, never swallowed
            # PROTOCOL.md shows a KeyError's own message without Python's added quotes.
            message = e.args[0] if isinstance(e, KeyError) and e.args else e
            reply, out = {"op": "error", "for": header.get("op"), "error": f"{type(e).__name__}: {message}"}, b""
        reply["id"] = header.get("id")
        send(reply, out)

    try:
        load_models(models)
        synth("Warm up.", 0, 1.0, 0.0, 1.0)
        ready_lookahead = lookahead()
    except Exception as e:
        print(f"voice organ: could not start: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return 2

    # Speaking and hearing each run on their own thread, in order, so frames keep flowing while a sentence is made.
    speak_jobs = queue.Queue()
    hear_jobs = queue.Queue()

    def worker(jobs):
        while True:
            job = jobs.get()
            if job is None:
                return
            run(*job)

    threading.Thread(target=worker, args=(speak_jobs,), daemon=True).start()
    threading.Thread(target=worker, args=(hear_jobs,), daemon=True).start()

    send({"op": "ready", "protocol": 1, "voices": VOICES, "sample_rate": SR_OUT, "frame_ms": 20,
          "lookahead": ready_lookahead, "phonemizer": str(DIZIONE.VERSION), "stt": MODEL_NAME}, b"")

    def stop():
        speak_jobs.put(None)
        hear_jobs.put(None)

    while True:
        raw = read_exact(fin, 4)
        if raw is None:
            stop()
            return 0
        header_len = struct.unpack(">I", raw)[0]
        if header_len > MAX_HEADER:
            print("voice organ: frame too large", file=sys.stderr, flush=True)
            return 3
        raw_header = read_exact(fin, header_len)
        if raw_header is None:
            stop()
            return 0
        raw_body_len = read_exact(fin, 4)
        if raw_body_len is None:
            stop()
            return 0
        body_len = struct.unpack(">I", raw_body_len)[0]
        if body_len > MAX_BODY:
            print("voice organ: frame too large", file=sys.stderr, flush=True)
            return 3
        body = read_exact(fin, body_len) or b""

        header = None
        problem = None
        try:
            header = json.loads(raw_header)
        except Exception as e:
            problem = f"the header is not JSON: {e}"
        if problem is None and not isinstance(header, dict):
            problem = "the header is not an object"
        if problem is None and not isinstance(header.get("op"), str):
            problem = "the header has no string op"
        if problem is not None:
            send({"op": "error", "id": None, "for": None, "error": f"ValueError: {problem}"}, b"")
            continue

        if header["op"] == "speak":
            speak_jobs.put((header, body))
        elif header["op"] == "transcribe":
            hear_jobs.put((header, body))
        else:
            run(header, body)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
