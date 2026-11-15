"""Silero VAD (v5) on Mint: CPU time per 32 ms window, and when speech start and end are flagged. Silent."""
import json, os, sys, time
import numpy as np
import sherpa_onnx
from stt_bench import load_16k, rss_mb, HERE

cfg = sherpa_onnx.VadModelConfig()
cfg.silero_vad.model = os.path.join(HERE, "models", "silero_vad_v5.onnx")
cfg.silero_vad.threshold = 0.5
cfg.silero_vad.min_silence_duration = 0.25
cfg.silero_vad.min_speech_duration = 0.1
cfg.sample_rate = 16000
cfg.num_threads = 1
rss0 = rss_mb()
vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)
win = cfg.silero_vad.window_size
items = json.load(open(os.path.join(HERE, "audio", "sets.json")))
times = []
onsets = []
for it in items[:30]:
    audio = load_16k(os.path.join(HERE, "audio", it["file"]))
    # 0.5 s of silence first, so the onset is measurable.
    audio = np.concatenate([np.zeros(8000, dtype=np.float32), audio, np.zeros(8000, dtype=np.float32)])
    vad.reset()
    seen = None
    for i in range(0, len(audio) - win, win):
        t0 = time.perf_counter()
        vad.accept_waveform(audio[i:i + win])
        detected = vad.is_speech_detected()
        times.append(time.perf_counter() - t0)
        if detected and seen is None:
            seen = (i + win) / 16000 - 0.5
        while not vad.empty():
            vad.pop()
    if seen is not None:
        onsets.append(seen)
times.sort()
print(json.dumps({
    "window_samples": win, "windows": len(times),
    "ms_per_window_median": round(1000 * times[len(times) // 2], 3), "ms_per_window_p99": round(1000 * times[int(len(times) * 0.99)], 3),
    "cpu_percent_of_one_core_while_listening": round(100 * (sum(times) / len(times)) / (win / 16000), 2),
    "speech_flagged_after_onset_s_median": round(sorted(onsets)[len(onsets) // 2], 3) if onsets else None,
    "rss_added_mb": round(rss_mb() - rss0, 1),
}))
