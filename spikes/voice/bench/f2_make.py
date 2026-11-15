"""Speak eight conversational lines with tiny-voca F2 into ../stt/audio/f2-*.wav (24 kHz). Written, never played."""
import json, os, wave
import numpy as np
import onnxruntime as ort
import dizione

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "stt", "audio")
LINES = [
    "Hey, are you still there?",
    "I think we should finish the kitchen first, and then the garden.",
    "Did you see the message I sent you this morning?",
    "No, wait, I meant the other one, the blue file.",
    "Okay, give me a minute, I'm almost done with this level.",
    "What time is it in Tokyo right now?",
    "Can you remind me tomorrow at nine to call my sister?",
    "Honestly, that was the best game we've played all week.",
]
so = ort.SessionOptions(); so.intra_op_num_threads = 1
s = ort.InferenceSession(os.path.join(HERE, "onnx", "model.onnx"), so, providers=["CPUExecutionProvider"])
one = lambda v: np.array([v], dtype=np.float32)
items = []
for i, text in enumerate(LINES):
    p = dizione.phonemize(text)
    audio, _ = s.run(None, {"tokens": np.array([p.ids], dtype=np.int64), "stress": np.array([p.stress], dtype=np.int64),
                            "voice": np.array([0], dtype=np.int64), "speed": one(1.0), "pitch_shift": one(0.0), "pitch_range": one(1.0)})
    pcm = (np.clip(audio[0], -1, 1) * 32767).astype(np.int16)
    name = f"f2-{i:02d}.wav"
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm.tobytes())
    items.append({"file": name, "text": text})
json.dump(items, open(os.path.join(OUT, "f2.json"), "w"), indent=1)
print(len(items), "lines")
