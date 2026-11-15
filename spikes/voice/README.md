# Voice spike (N10)

Throwaway code that proved the risky parts of `docs/design/n10-voice.md` on Mint, silently. Nothing here is imported
by Natalis, and nothing here plays sound: every result is a file.

| File | What it is |
|---|---|
| `voice_organ.py` | The organ, spike version: tiny-voca F2 speech, Opus through the system libopus, 24 to 48 kHz, Silero VAD, over a framed stdin/stdout pipe. Synthesis runs on its own thread. |
| `say-stream.mjs` | Reads a `say` call's JSON arguments as they stream, field by field. |
| `speech-text.mjs` | Makes text speakable (drops code, emoji, marks; reads links as site names; reports each) and cuts it into chunks with pauses. |
| `ogg.mjs` | An Ogg Opus file and Discord's waveform, for voice messages. |
| `spike.mjs` | The scenario: a simulated model streams a say; the body speaks it; a recorded speaker barges in; a noise burst tries to; a voice message is made. |
| `check.mjs` | The reader under 299 random splits, and the chunker's output, with no Python. |
| `bench/` | The speech-to-text bench: model runners, the clip picker and the set builder. |
| `out/` | What the runs wrote (not committed): the WAVs, the voice message, the prosody samples, `results.json`, `stt-results.jsonl`. |

To run it again on a Linux box with the tiny-voca bench folder (`~/bench/tiny-voca`) and Silero's ONNX file:

```
node check.mjs
node spike.mjs ~/bench/tiny-voca/venv/bin/python voice_organ.py out in/summoner.wav in/noise.wav
```

`in/summoner.wav` is any short recording of a person speaking, and `in/noise.wav` a short noise burst.
