"""The voice organ's tests: the pure parts here, and a running organ when NATALIS_ORGAN_MODELS names a models folder."""

import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

import numpy as np

import voice_organ

SR_OUT = 48000
SR_HEAR = 16000
FRAME = 960


def _tone(sr, hz, seconds=1.0, amplitude=0.5):
    t = np.arange(int(sr * seconds)) / sr
    return (amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _amplitude_at(x, sr, hz, half_width=50.0):
    """The Hann-windowed FFT's amplitude near one frequency."""
    w = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * w)) * 2 / w.sum()
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    band = spec[np.abs(freqs - hz) <= half_width]
    return float(band.max()) if len(band) else 0.0


def _push_down3(x, piece=FRAME):
    down = voice_organ.Down3()
    return np.concatenate([down.push(x[i:i + piece]) for i in range(0, len(x), piece)])


def _read_exact(stream, n):
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def _libopus_available():
    try:
        voice_organ._opus()
    except OSError:
        return False
    return True


HAS_LIBOPUS = _libopus_available()


class PureTests(unittest.TestCase):
    @unittest.skipUnless(HAS_LIBOPUS, "libopus is not installed")
    def test_opus_round_trip(self):
        self._round_trip(1, 32000)
        self._round_trip(2, 64000)

    def _round_trip(self, channels, bitrate):
        x = _tone(SR_OUT, 440.0)
        i16 = (x * 32767).astype(np.int16)
        enc = voice_organ.Encoder(channels, bitrate)
        dec = voice_organ.Decoder(channels)
        packets = [enc.encode(i16[i:i + FRAME]) for i in range(0, len(i16) - FRAME + 1, FRAME)]
        out = np.concatenate([dec.decode(packet) for packet in packets])
        out = out[voice_organ.lookahead():]
        self.assertGreater(len(out), 0)

        freqs = np.fft.rfftfreq(len(out), 1 / SR_OUT)
        strongest = float(freqs[int(np.argmax(np.abs(np.fft.rfft(out))))])
        self.assertLessEqual(abs(strongest - 440.0), 10.0)

        rms_in = float(np.sqrt(np.mean(x ** 2)))
        rms_out = float(np.sqrt(np.mean(out ** 2)))
        self.assertLessEqual(abs(rms_out - rms_in) / rms_in, 0.25)

    def test_up2_response(self):
        x = _tone(24000, 1000.0)
        out = voice_organ.up2(x)
        amp_in = _amplitude_at(x[100:-100], 24000, 1000.0)
        amp_out = _amplitude_at(out[100:-100], 48000, 1000.0)
        self.assertLessEqual(abs(20 * np.log10(amp_out / amp_in)), 1.0)

        x3 = _tone(24000, 3000.0)
        middle = voice_organ.up2(x3)[100:-100]
        at_3k = _amplitude_at(middle, 48000, 3000.0)
        at_21k = _amplitude_at(middle, 48000, 21000.0)
        self.assertLessEqual(20 * np.log10(max(at_21k, 1e-12) / at_3k), -40.0)

    def test_down3_response(self):
        x = _tone(SR_OUT, 1000.0)
        out = _push_down3(x)
        amp_in = _amplitude_at(x, SR_OUT, 1000.0)
        amp_out = _amplitude_at(out[100:], SR_HEAR, 1000.0)
        self.assertLessEqual(abs(20 * np.log10(amp_out / amp_in)), 1.0)

        x12 = _tone(SR_OUT, 12000.0)
        out12 = _push_down3(x12)
        rms_in = float(np.sqrt(np.mean(x12 ** 2)))
        rms_out = float(np.sqrt(np.mean(out12[100:] ** 2)))
        self.assertLessEqual(20 * np.log10(rms_out / rms_in), -40.0)

        one_piece = voice_organ.Down3().push(x)
        self.assertLessEqual(float(np.max(np.abs(out - one_piece))), 1e-5)

    def test_cut_pieces(self):
        rng = np.random.default_rng(20261115)
        audio = (rng.uniform(-1.0, 1.0, 70 * SR_HEAR) * 0.1).astype(np.float32)
        audio[27 * SR_HEAR:27 * SR_HEAR + 320] = 0
        audio[55 * SR_HEAR + 8000:55 * SR_HEAR + 8320] = 0

        pieces = voice_organ.cut_pieces(audio)
        self.assertEqual(len(pieces), 3)
        self.assertTrue(np.array_equal(np.concatenate(pieces), audio))
        cuts = np.cumsum([len(piece) for piece in pieces[:-1]]) / SR_HEAR
        self.assertLessEqual(abs(cuts[0] - 27.0), 0.02)
        self.assertLessEqual(abs(cuts[1] - 55.5), 0.02)
        for piece in pieces:
            self.assertLessEqual(len(piece), 30 * SR_HEAR)

        short = (rng.uniform(-1.0, 1.0, 10 * SR_HEAR) * 0.1).astype(np.float32)
        one = voice_organ.cut_pieces(short)
        self.assertEqual(len(one), 1)
        self.assertTrue(np.array_equal(one[0], short))

    def test_split_packets(self):
        body = (struct.pack(">H", 1) + b"a" + struct.pack(">H", 300) + b"b" * 300
                + struct.pack(">H", 0))
        self.assertEqual(voice_organ.split_packets(body), [b"a", b"b" * 300, b""])
        with self.assertRaises(ValueError):
            voice_organ.split_packets(body[:-1])


@unittest.skipUnless(HAS_LIBOPUS, "libopus is not installed")
class CodecCloseTests(unittest.TestCase):
    def test_encoder_close_twice_is_safe_and_encode_after_close_raises(self):
        enc = voice_organ.Encoder(1, 32000)
        enc.close()
        enc.close()
        self.assertIsNone(enc.h)
        with self.assertRaisesRegex(RuntimeError, "encoder is closed"):
            enc.encode(np.zeros(FRAME, dtype=np.int16))

    def test_decoder_close_twice_is_safe_and_decode_after_close_raises(self):
        dec = voice_organ.Decoder(1)
        dec.close()
        dec.close()
        self.assertIsNone(dec.h)
        with self.assertRaisesRegex(RuntimeError, "decoder is closed"):
            dec.decode(b"")


class _FakeDecoder:
    def __init__(self, channels=2):
        self.channels = channels
        self.closed = False

    def decode(self, packet):
        return np.zeros(64, dtype=np.float32)

    def close(self):
        self.closed = True


class _FailingDecoder(_FakeDecoder):
    def decode(self, packet):
        raise RuntimeError("a packet libopus cannot decode")


class _FakeResult:
    text = ""


class _FakeStream:
    result = _FakeResult()

    def accept_waveform(self, sample_rate, audio):
        pass


class _FakeRecognizer:
    def create_stream(self):
        return _FakeStream()

    def decode_stream(self, stream):
        pass


class EncoderLifecycleTests(unittest.TestCase):
    def setUp(self):
        voice_organ.utts.clear()
        voice_organ.cancelled.clear()

    def tearDown(self):
        for u in voice_organ.utts.values():
            u.enc.close()
        voice_organ.utts.clear()
        voice_organ.cancelled.clear()

    @unittest.skipUnless(HAS_LIBOPUS, "libopus is not installed")
    def test_a_final_drain_keeps_the_utterance_for_the_hosts_empty_poll(self):
        utt = "final-drain"
        u = voice_organ.Utterance(1, 32000)
        u.pcm = _tone(SR_OUT, 440.0, seconds=0.1)
        voice_organ.utts[utt] = u

        reply, _ = voice_organ.op_frames({"utt": utt, "n": 1000, "final": True}, b"")
        self.assertEqual(len(reply["lens"]), 5)
        self.assertEqual(reply["left_ms"], 0)
        self.assertIn(utt, voice_organ.utts)

        again, _ = voice_organ.op_frames({"utt": utt, "n": 1000, "final": True}, b"")
        self.assertEqual(again["lens"], [])
        self.assertIn(utt, voice_organ.utts)

    @unittest.skipUnless(HAS_LIBOPUS, "libopus is not installed")
    def test_flush_closes_the_utterance_encoder(self):
        utt = "flush-closes"
        u = voice_organ.Utterance(1, 32000)
        u.pcm = _tone(SR_OUT, 440.0, seconds=0.05)
        enc = u.enc
        voice_organ.utts[utt] = u

        reply, _ = voice_organ.op_flush({"utt": utt}, b"")
        self.assertEqual(reply["op"], "flushed")
        self.assertNotIn(utt, voice_organ.utts)
        self.assertIsNone(enc.h)
        with self.assertRaisesRegex(RuntimeError, "encoder is closed"):
            enc.encode(np.zeros(FRAME, dtype=np.int16))

    def test_cancelled_keeps_the_newest_256(self):
        for i in range(300):
            voice_organ.op_flush({"utt": f"u{i}"}, b"")
        self.assertEqual(len(voice_organ.cancelled), 256)
        self.assertEqual(list(voice_organ.cancelled), [f"u{i}" for i in range(44, 300)])
        self.assertNotIn("u43", voice_organ.cancelled)
        self.assertIn("u299", voice_organ.cancelled)

    def test_transcribe_closes_its_decoder(self):
        made = []

        def make_decoder(channels=2):
            decoder = _FakeDecoder(channels)
            made.append(decoder)
            return decoder

        with mock.patch.object(voice_organ, "Decoder", make_decoder), \
                mock.patch.object(voice_organ, "RECOGNIZER", _FakeRecognizer()):
            reply, _ = voice_organ.op_transcribe({"channels": 1}, struct.pack(">H", 1) + b"x")
        self.assertEqual(reply["op"], "transcript")
        self.assertEqual(len(made), 1)
        self.assertTrue(made[0].closed)

    def test_transcribe_closes_its_decoder_when_a_packet_fails(self):
        made = []

        def make_decoder(channels=2):
            decoder = _FailingDecoder(channels)
            made.append(decoder)
            return decoder

        with mock.patch.object(voice_organ, "Decoder", make_decoder):
            with self.assertRaisesRegex(RuntimeError, "cannot decode"):
                voice_organ.op_transcribe({"channels": 1}, struct.pack(">H", 1) + b"x")
        self.assertEqual(len(made), 1)
        self.assertTrue(made[0].closed)


@unittest.skipUnless(os.environ.get("NATALIS_ORGAN_MODELS"),
                     "set NATALIS_ORGAN_MODELS to the folder holding tiny-voca and parakeet")
class ProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        cls.proc = subprocess.Popen(
            [sys.executable, "-I", "voice_organ.py", "--models", os.environ["NATALIS_ORGAN_MODELS"]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=creationflags,
        )
        cls.replies = queue.Queue()
        cls.pending = {}
        cls.reader = threading.Thread(target=cls._read_replies, args=(cls.proc, cls.replies), daemon=True)
        cls.reader.start()

        deadline = time.monotonic() + 180
        cls.ready = None
        while cls.ready is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                cls._stop()
                raise AssertionError("the organ did not become ready in 180 s: " + cls._stderr())
            try:
                header, body = cls.replies.get(timeout=min(1.0, remaining))
            except queue.Empty:
                if cls.proc.poll() is not None:
                    raise AssertionError(f"the organ exited with {cls.proc.returncode}: {cls._stderr()}")
                continue
            if header.get("op") == "ready":
                cls.ready = header
        if cls.ready.get("protocol") != 1:
            cls._stop()
            raise AssertionError(f"bad ready frame: {cls.ready}")
        if "F2" not in cls.ready.get("voices", []):
            cls._stop()
            raise AssertionError(f"F2 is not in the ready voices: {cls.ready}")

    @classmethod
    def tearDownClass(cls):
        cls._stop()
        cls.reader.join(timeout=5)
        for stream in (cls.proc.stdout, cls.proc.stderr):
            try:
                stream.close()
            except Exception:
                pass

    @classmethod
    def _stop(cls):
        try:
            if cls.proc.stdin and not cls.proc.stdin.closed:
                cls.proc.stdin.close()
        except Exception:
            pass
        try:
            cls.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait(timeout=10)

    @classmethod
    def _stderr(cls):
        if cls.proc.poll() is None:
            cls._stop()
        try:
            return (cls.proc.stderr.read() or b"").decode("utf-8", "replace")
        except Exception:
            return ""

    @staticmethod
    def _read_replies(proc, replies):
        while True:
            raw = _read_exact(proc.stdout, 4)
            if raw is None:
                return
            (header_len,) = struct.unpack(">I", raw)
            header_bytes = _read_exact(proc.stdout, header_len)
            if header_bytes is None:
                return
            raw = _read_exact(proc.stdout, 4)
            if raw is None:
                return
            (body_len,) = struct.unpack(">I", raw)
            body = _read_exact(proc.stdout, body_len)
            if body is None:
                return
            try:
                header = json.loads(header_bytes)
            except Exception:
                return
            replies.put((header, body))

    def send(self, header, body=b""):
        header_bytes = json.dumps(header).encode()
        self.proc.stdin.write(struct.pack(">I", len(header_bytes)) + header_bytes
                              + struct.pack(">I", len(body)) + body)
        self.proc.stdin.flush()

    def call(self, header, body=b"", timeout=600):
        rid = header["id"]
        self.send(header, body)
        if rid in self.pending:
            return self.pending.pop(rid)
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.fail(f"no reply for id {rid}: {self._stderr()}")
            try:
                reply, reply_body = self.replies.get(timeout=remaining)
            except queue.Empty:
                self.fail(f"no reply for id {rid} in {timeout} s: {self._stderr()}")
            if reply.get("id") == rid:
                return reply, reply_body
            self.pending[reply.get("id")] = (reply, reply_body)

    def speak(self, rid, utt, text, **fields):
        header = {"op": "speak", "id": rid, "utt": utt, "text": text, "voice": "F2",
                  "speed": 1.0, "pitch_shift": 0.0, "pitch_range": 1.0, "pause_ms": 0,
                  "channels": 1, "bitrate": 32000}
        header.update(fields)
        reply, _ = self.call(header)
        return reply

    def test_bad_requests(self):
        reply, _ = self.call({"op": "bogus", "id": 1})
        self.assertEqual(reply["op"], "error")
        self.assertEqual(reply["for"], "bogus")

        reply, _ = self.call({"op": "frames", "id": 2, "utt": "never-spoken", "n": 1})
        self.assertEqual(reply["op"], "error")
        self.assertEqual(reply["for"], "frames")

        reply, _ = self.call({"op": "speak", "id": 3, "utt": "bad-speed", "text": "Hello.",
                              "voice": "F2", "speed": 9, "pitch_shift": 0.0, "pitch_range": 1.0,
                              "pause_ms": 0, "channels": 1, "bitrate": 32000})
        self.assertEqual(reply["op"], "error")
        self.assertEqual(reply["for"], "speak")
        self.assertIn("speed", reply["error"])

        reply, _ = self.call({"op": "ping", "id": 4})
        self.assertEqual(reply, {"op": "pong", "id": 4})

    def test_word_timings(self):
        utt = "word-timings"
        first = self.speak(1, utt, "Hello there. This is a short test of her voice.")
        words = first["words"]
        self.assertTrue(words)
        for start, end in words:
            self.assertLess(start, end)
        for before, after in zip(words, words[1:]):
            self.assertGreaterEqual(after[0], before[0])
        self.assertLessEqual(words[-1][1], first["audio_ms"] + 20)
        self.assertGreaterEqual(words[-1][1], first["audio_ms"] - 200)

        second = self.speak(2, utt, "And one more.")
        self.assertLessEqual(abs(second["offset_ms"] - first["audio_ms"]), 1)
        self.assertGreaterEqual(second["words"][0][0], second["offset_ms"])

    def test_frames_and_flush(self):
        utt = "frames-and-flush"
        spoken = self.speak(1, utt, "A short sentence for frames.")
        reply, body = self.call({"op": "frames", "id": 2, "utt": utt, "n": 1000, "final": True, "pcm": True})
        self.assertEqual(reply["op"], "packets")
        lens = reply["lens"]
        self.assertTrue(lens)
        self.assertEqual(len(body), sum(lens) + 1920 * len(lens))
        self.assertGreaterEqual(len(lens) * 20, spoken["audio_ms"])
        self.assertEqual(reply["left_ms"], 0)

        reply, _ = self.call({"op": "flush", "id": 3, "utt": utt})
        self.assertEqual(reply["op"], "flushed")
        reply = self.speak(4, utt, "This must skip.")
        self.assertTrue(reply.get("skipped") is True)

    def test_transcribe_her_own_voice(self):
        utt = "transcribe-own"
        self.speak(1, utt, "Please call me tomorrow at nine.", channels=1, bitrate=32000)
        packets = []
        rid = 2
        while True:
            reply, body = self.call({"op": "frames", "id": rid, "utt": utt, "n": 3000, "final": True})
            rid += 1
            lens = reply["lens"]
            if not lens:
                break
            offset = 0
            for length in lens:
                packets.append(body[offset:offset + length])
                offset += length
            self.assertEqual(offset, len(body))

        payload = b"".join(struct.pack(">H", len(packet)) + packet for packet in packets)
        reply, _ = self.call({"op": "transcribe", "id": rid, "channels": 1, "max_s": 300}, body=payload)
        self.assertEqual(reply["op"], "transcript")
        text = reply["text"].lower()
        self.assertIn("tomorrow", text)
        self.assertTrue("nine" in text or "9" in text)
        self.assertLessEqual(abs(reply["audio_ms"] - len(packets) * 20), 40)

    def test_transcribe_cut_body(self):
        body = struct.pack(">H", 100) + b"abc"
        reply, _ = self.call({"op": "transcribe", "id": 1, "channels": 1}, body=body)
        self.assertEqual(reply["op"], "error")
        self.assertEqual(reply["for"], "transcribe")


if __name__ == "__main__":
    unittest.main()
