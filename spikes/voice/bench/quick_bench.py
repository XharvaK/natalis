"""Short measured samples: Moonshine small (offline, 10 accented clips) and Parakeet 110M with two threads (all accented clips)."""
import glob, json, os, sys, time, resource
from stt_bench import load_16k, norm, edits, HERE, offline

items = [x for x in json.load(open(os.path.join(HERE, "audio", "sets.json"))) if x["set"] == "edacc-accented"]
which = sys.argv[1]
if which == "moonshine-small":
    os.sched_setaffinity(0, {1})
    from moonshine_voice import Transcriber, ModelArch
    path = glob.glob(os.path.join(HERE, "models", "moonshine-cache", "download.moonshine.ai", "model", "small-streaming-en", "*"))[0]
    tr = Transcriber(path, ModelArch.SMALL_STREAMING)
    run = lambda a: " ".join(l.text for l in tr.transcribe_without_streaming(a.tolist(), 16000).lines)
    items = items[:10]
else:
    rec = offline("parakeet-110m", 2)

    def run(a):
        s = rec.create_stream()
        s.accept_waveform(16000, a)
        rec.decode_stream(s)
        return s.result.text
words = errs = 0
audio_s = comp = 0.0
lat = []
for it in items:
    a = load_16k(os.path.join(HERE, "audio", it["file"]))
    t0 = time.perf_counter()
    hyp = run(a)
    c = time.perf_counter() - t0
    ref = norm(it["text"])
    words += len(ref); errs += edits(ref, norm(hyp)); audio_s += len(a) / 16000; comp += c; lat.append(c)
lat.sort()
print(json.dumps({"model": which, "clips": len(items), "wer_percent": round(100 * errs / words, 1), "rtf": round(comp / audio_s, 3),
                  "median_s": round(lat[len(lat) // 2], 3), "max_s": round(lat[-1], 3), "audio_s": round(audio_s, 1),
                  "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)}))
