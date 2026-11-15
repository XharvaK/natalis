# The voice organ's protocol (version 1)

The organ is one Python process beside the Lar (`organ/voice_organ.py`). It makes her speech (tiny-voca), hears speech
(Parakeet TDT-CTC 110M through sherpa-onnx) and encodes and decodes Opus (the system's libopus). Node starts it and
talks to it over its stdin and stdout. Nothing else is written to stdout. Logs go to stderr. It never opens an audio
device.

    python -I organ/voice_organ.py --models <models folder>

## Frames

Both directions use the same frame:

| Bytes | What |
|---|---|
| 4 | header length, unsigned, big-endian |
| n | the header: one JSON object, UTF-8 |
| 4 | body length, unsigned, big-endian |
| m | the body: raw bytes, often empty |

A header is at most 1 MiB and a body at most 64 MiB. A larger length, a header that is not JSON, or a JSON value that is
not an object is a protocol fault. Node then kills the organ and starts it again.

## Start

The organ loads its models, makes one short warm-up sentence, then sends one frame with no `id`:

```json
{"op": "ready", "protocol": 1, "voices": ["F2", "M2"], "sample_rate": 48000, "frame_ms": 20, "lookahead": 312,
 "phonemizer": "<dizione version>", "stt": "parakeet-tdt-ctc-110m-int8"}
```

`lookahead` is the Opus encoder's lookahead in samples at 48 kHz (`OPUS_GET_LOOKAHEAD`); an Ogg file uses it as its
pre-skip. If loading fails, the organ writes the reason to stderr and exits with code 2. When stdin closes, it exits
with code 0. On a POSIX system it lowers its own priority by 10 (`os.nice(10)`) before loading, so the Lar's own
process keeps the audio clock.

## Requests and replies

Every request carries an `id`, a positive integer. Every request gets exactly one reply with the same `id`. Replies can
come out of order, because `speak` and `transcribe` each run on a thread of their own, in arrival order, while every
other op is answered at once. So `frames` never waits behind a sentence being made or a voice message being heard.

An error comes back as a reply and is never swallowed:

```json
{"op": "error", "id": 7, "for": "frames", "error": "KeyError: no utterance u3"}
```

A header that has no usable `id` (not JSON, or no `op`) gets an error reply with `"id": null`. Node treats that as a
protocol fault.

## Ops

### `ping`

`{"op": "ping", "id": 1}` gives `{"op": "pong", "id": 1}`.

### `speak`

Makes one chunk of speech and adds it to an utterance's queue. Runs on the speaking thread.

| Field | Type | Rule |
|---|---|---|
| `utt` | string | the utterance; 1 to 64 characters |
| `text` | string | 1 to 2000 characters, already made speakable by Node |
| `voice` | string | one of `voices` in `ready` |
| `speed` | number | 0.5 to 2.0; 1.0 is the model as trained, larger is faster |
| `pitch_shift` | number | -0.5 to 0.5, added to log F0; 0.058 is about one semitone |
| `pitch_range` | number | 0 to 3; scales the pitch movement |
| `pause_ms` | integer | 0 to 5000; silence added after this chunk |
| `channels` | 1 or 2 | used by the utterance's first `speak` only |
| `bitrate` | integer | 6000 to 510000 bits a second; first `speak` only |

The model's own silence at the chunk's edges is trimmed first. Reply, with an empty body:

```json
{"op": "spoken", "id": 2, "utt": "u1", "audio_ms": 1840, "offset_ms": 0, "words": [[0, 310], [330, 720]],
 "ms": {"phonemize": 4.1, "synth": 130.2, "post": 2.0, "total": 136.9}}
```

`offset_ms` is where this chunk starts in the utterance. `words` are the start and end of each spoken word in
milliseconds from the utterance's start (the offset is included), from the model's own per-token durations. A `speak`
for an utterance that was flushed makes nothing and replies `{"op": "spoken", "id": 2, "utt": "u1", "skipped": true}`.
A text that phonemizes to nothing is an error.

### `frames`

Takes up to `n` frames of 20 ms from an utterance's queue and encodes them.

| Field | Type | Rule |
|---|---|---|
| `utt` | string | an utterance that has had a `speak` |
| `n` | integer | 1 to 3000 |
| `gain` | number | 0 to 1, default 1; applied before encoding |
| `final` | boolean | default false; true pads the last partial frame with silence |
| `pcm` | boolean | default false; true adds the frames' samples to the body |

Without `final`, a partial last frame stays in the queue for the next chunk. Reply:

```json
{"op": "packets", "id": 3, "utt": "u1", "lens": [82, 79, 80], "pos_ms": 60, "left_ms": 1780}
```

The body is the Opus packets one after another (their lengths are `lens`), then, with `pcm`, the same frames as 16-bit
little-endian mono samples at 48 kHz, after the gain: 1920 bytes a frame. `pos_ms` is how much of the utterance has
been encoded so far; `left_ms` is what is still queued. An empty `lens` means nothing was ready.

### `flush`

`{"op": "flush", "id": 4, "utt": "u1"}` drops what is still queued, frees the utterance's encoder, and makes later
`speak` calls for it skip. Reply: `{"op": "flushed", "id": 4, "utt": "u1", "pos_ms": 1200, "dropped_ms": 640}`. An
unknown utterance gives `pos_ms` 0 and `dropped_ms` 0.

### `transcribe`

Hears a voice message or a finished utterance. Runs on the hearing thread.

| Field | Type | Rule |
|---|---|---|
| `channels` | 1 or 2 | the packets' channel count |
| `max_s` | number | 1 to 600, default 300; audio past this is not heard |

The body is Opus packets, each one preceded by its length as an unsigned 16-bit big-endian number. The organ decodes
them at 48 kHz, mixes to mono, resamples to 16 kHz, cuts the audio into pieces of at most 30 s (each cut at the quietest
20 ms in the last 5 s before the 30 s mark), recognizes each piece, and joins the texts with a space. Reply, with an
empty body:

```json
{"op": "transcript", "id": 5, "text": "See you at nine.", "audio_ms": 7040, "heard_ms": 7040,
 "model": "parakeet-tdt-ctc-110m-int8", "ms": {"decode": 12.0, "recognize": 690.4}}
```

`audio_ms` is the length of all the packets; `heard_ms` is how much of it was recognized (less than `audio_ms` only
when `max_s` cut it). `text` is empty when nothing was heard. A packet libopus cannot decode is an error.

## Models

`--models` names a folder laid out like this:

| Path | What |
|---|---|
| `tiny-voca/config.json` | its voices (`voices`, in model index order) and the phonemizer it was trained on |
| `tiny-voca/onnx/model.onnx` | tiny-voca, the speaking model |
| `tiny-voca/phonemizer/` | dizione's data (`DIZIONE_DATA`) |
| `parakeet/model.int8.onnx` | Parakeet TDT-CTC 110M, int8, loaded through its CTC head (`from_nemo_ctc`) |
| `parakeet/tokens.txt` | its tokens |

A voice's model index is its position in `config.json`'s `voices` (F2 is 0). The organ refuses to start (exit code 2)
when `config.json`'s `phonemizer.version` differs from the installed dizione's version: a different phonemizer
mispronounces words. Every model runs on one thread.
