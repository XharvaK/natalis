"""Speech-to-text on Mint: latency, real-time factor, word error rate and memory per model, one thread, silent.

Usage: venv/bin/python stt_bench.py <model-key> [--threads N]
Reads audio/sets.json ([{file, text, set}]); prints one JSON object. Never plays audio.
"""
import json, os, re, sys, time, resource
import numpy as np
import soundfile as sf
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(HERE, "models")


def rss_mb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0.0


def load_16k(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != 16000:
        n = int(round(len(audio) * 16000 / sr))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


NUM = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight",
       "9": "nine", "10": "ten", "11": "eleven", "12": "twelve", "20": "twenty", "30": "thirty", "100": "hundred"}


def norm(text):
    text = re.sub(r"<[^>]*>", " ", text.lower())
    text = text.replace("’", "'")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    words = [NUM.get(w, w) for w in text.split()]
    words = [w.strip("'") for w in words]
    return [w for w in words if w and w not in ("uh", "um", "er", "erm", "hmm", "mm", "ah")]


def edits(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
            prev, d[j] = d[j], cur
    return d[len(hyp)]


def offline(key, threads):
    if key == "moonshine-tiny":
        d = f"{M}/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27"
        return sherpa_onnx.OfflineRecognizer.from_moonshine_v2(encoder=f"{d}/encoder_model.ort", decoder=f"{d}/decoder_model_merged.ort",
                                                              tokens=f"{d}/tokens.txt", num_threads=threads)
    if key == "moonshine-base":
        d = f"{M}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27"
        return sherpa_onnx.OfflineRecognizer.from_moonshine_v2(encoder=f"{d}/encoder_model.ort", decoder=f"{d}/decoder_model_merged.ort",
                                                              tokens=f"{d}/tokens.txt", num_threads=threads)
    if key == "parakeet-110m":
        d = f"{M}/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8"
        return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=f"{d}/model.int8.onnx", tokens=f"{d}/tokens.txt", num_threads=threads)
    if key == "whisper-base.en":
        d = f"{M}/sherpa-onnx-whisper-base.en"
        return sherpa_onnx.OfflineRecognizer.from_whisper(encoder=f"{d}/base.en-encoder.int8.onnx", decoder=f"{d}/base.en-decoder.int8.onnx",
                                                         tokens=f"{d}/base.en-tokens.txt", num_threads=threads, language="en", task="transcribe")
    return None


def main():
    key = sys.argv[1]
    threads = int(sys.argv[sys.argv.index("--threads") + 1]) if "--threads" in sys.argv else 1
    items = json.load(open(os.path.join(HERE, "audio", "sets.json")))
    out = {"model": key, "threads": threads, "rss_start_mb": round(rss_mb(), 1)}
    t = time.perf_counter()
    streaming = key == "kroko-streaming"
    if streaming:
        d = f"{M}/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06"
        rec = sherpa_onnx.OnlineRecognizer.from_transducer(tokens=f"{d}/tokens.txt", encoder=f"{d}/encoder.onnx", decoder=f"{d}/decoder.onnx",
                                                           joiner=f"{d}/joiner.onnx", num_threads=threads)
    else:
        rec = offline(key, threads)
    out["load_s"] = round(time.perf_counter() - t, 2)
    out["rss_loaded_mb"] = round(rss_mb(), 1)
    sets = {}
    rows = []
    first = True
    for it in items:
        audio = load_16k(os.path.join(HERE, "audio", it["file"]))
        dur = len(audio) / 16000
        if streaming:
            s = rec.create_stream()
            step = 1600  # 100 ms chunks, as they would arrive
            compute = 0.0
            chunk_ms = []
            for i in range(0, len(audio), step):
                t0 = time.perf_counter()
                s.accept_waveform(16000, audio[i:i + step])
                while rec.is_ready(s):
                    rec.decode_stream(s)
                c = time.perf_counter() - t0
                compute += c
                chunk_ms.append(c * 1000)
            # End of speech: tail padding flushes the model; this is the wait after the last word.
            t0 = time.perf_counter()
            s.accept_waveform(16000, np.zeros(int(0.66 * 16000), dtype=np.float32))
            s.input_finished()
            while rec.is_ready(s):
                rec.decode_stream(s)
            final_s = time.perf_counter() - t0
            compute += final_s
            text = rec.get_result(s)
            row = {"after_end_s": round(final_s, 3), "chunk_ms_max": round(max(chunk_ms), 1)}
        else:
            t0 = time.perf_counter()
            s = rec.create_stream()
            s.accept_waveform(16000, audio)
            rec.decode_stream(s)
            compute = time.perf_counter() - t0
            text = s.result.text
            row = {"after_end_s": round(compute, 3)}
        if first:
            out["first_utterance_s"] = round(compute, 3)
            first = False
        ref, hyp = norm(it["text"]), norm(text)
        e = edits(ref, hyp)
        g = sets.setdefault(it["set"], {"n": 0, "words": 0, "errors": 0, "audio_s": 0.0, "compute_s": 0.0, "after_end": []})
        g["n"] += 1; g["words"] += len(ref); g["errors"] += e; g["audio_s"] += dur; g["compute_s"] += compute
        g["after_end"].append(row["after_end_s"])
        rows.append({"file": it["file"], "audio_s": round(dur, 2), **row, "errors": e, "words": len(ref), "hyp": text.strip()[:160]})
    out["sets"] = {}
    for name, g in sets.items():
        a = sorted(g["after_end"])
        out["sets"][name] = {"utterances": g["n"], "wer_percent": round(100 * g["errors"] / max(1, g["words"]), 1),
                             "audio_s": round(g["audio_s"], 1), "rtf": round(g["compute_s"] / g["audio_s"], 3),
                             "after_end_median_s": a[len(a) // 2], "after_end_max_s": a[-1]}
    out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    out["rows"] = rows
    print(json.dumps(out))


if __name__ == "__main__":
    main()
