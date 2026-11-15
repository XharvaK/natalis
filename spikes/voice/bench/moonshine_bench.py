"""Moonshine streaming models (moonshine-voice) on Mint: offline and streamed latency, WER, memory. One thread, silent.

Usage: venv/bin/python moonshine_bench.py tiny|small|medium
"""
import glob, json, os, sys, time, resource
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.sched_setaffinity(0, {1})  # one core, like the other benches: the runtime has no thread option
from moonshine_voice import Transcriber, ModelArch
from stt_bench import load_16k, norm, edits, rss_mb, HERE

ARCH = {"tiny": ModelArch.TINY_STREAMING, "small": ModelArch.SMALL_STREAMING, "medium": ModelArch.MEDIUM_STREAMING}
key = sys.argv[1]
path = glob.glob(os.path.join(HERE, "models", "moonshine-cache", "download.moonshine.ai", "model", f"{key}-streaming-en", "*"))[0]
items = json.load(open(os.path.join(HERE, "audio", "sets.json")))
out = {"model": f"moonshine-{key}-streaming", "rss_start_mb": round(rss_mb(), 1)}
t = time.perf_counter()
tr = Transcriber(path, ARCH[key], update_interval=0.5)
out["load_s"] = round(time.perf_counter() - t, 2)
out["rss_loaded_mb"] = round(rss_mb(), 1)

sets, rows = {}, []
for it in items:
    audio = load_16k(os.path.join(HERE, "audio", it["file"]))
    dur = len(audio) / 16000
    # Offline: the whole utterance after the endpoint.
    t0 = time.perf_counter()
    res = tr.transcribe_without_streaming(audio.tolist(), 16000)
    offline_s = time.perf_counter() - t0
    text_off = " ".join(l.text for l in res.lines)
    # Streamed: 100 ms chunks as they arrive (passes run inside add_audio), then stop() gives the final line.
    s = tr.create_stream()
    s.start()
    busy = 0.0
    step = 1600
    for i in range(0, len(audio), step):
        t0 = time.perf_counter()
        s.add_audio(audio[i:i + step].tolist(), 16000)
        busy += time.perf_counter() - t0
    t0 = time.perf_counter()
    fin = s.stop()
    after_end = time.perf_counter() - t0
    busy += after_end
    text_st = " ".join(l.text for l in fin.lines) if fin else ""
    ref = norm(it["text"])
    e_off, e_st = edits(ref, norm(text_off)), edits(ref, norm(text_st))
    g = sets.setdefault(it["set"], {"n": 0, "words": 0, "err_off": 0, "err_st": 0, "audio_s": 0.0, "off_s": 0.0, "busy_s": 0.0, "after": [], "offl": []})
    g["n"] += 1; g["words"] += len(ref); g["err_off"] += e_off; g["err_st"] += e_st
    g["audio_s"] += dur; g["off_s"] += offline_s; g["busy_s"] += busy; g["after"].append(after_end); g["offl"].append(offline_s)
    rows.append({"file": it["file"], "audio_s": round(dur, 2), "offline_s": round(offline_s, 3), "stream_after_end_s": round(after_end, 3),
                 "words": len(ref), "errors_offline": e_off, "errors_stream": e_st, "hyp": text_st.strip()[:160]})
out["sets"] = {}
for name, g in sets.items():
    a, o = sorted(g["after"]), sorted(g["offl"])
    out["sets"][name] = {"utterances": g["n"], "wer_offline_percent": round(100 * g["err_off"] / g["words"], 1),
                         "wer_stream_percent": round(100 * g["err_st"] / g["words"], 1), "audio_s": round(g["audio_s"], 1),
                         "rtf_offline": round(g["off_s"] / g["audio_s"], 3), "rtf_stream_busy": round(g["busy_s"] / g["audio_s"], 3),
                         "offline_median_s": round(o[len(o) // 2], 3), "offline_max_s": round(o[-1], 3),
                         "stream_after_end_median_s": round(a[len(a) // 2], 3), "stream_after_end_max_s": round(a[-1], 3)}
out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
out["rows"] = rows
print(json.dumps(out))
