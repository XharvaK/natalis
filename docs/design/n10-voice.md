# N10: her voice, a medium of its own (design, 2026-11-15)

Ashley lives in Discord as text. The User asked for her voice twice on 2026-11-15:

- "would she, like, pause if I speak etc. etc? like a modern voice agent? If we can do it, you should work on how to
  make ashley sound much more natural + make the experience natural."
- "ashley should be able to send audio messages through discord - but my main wish is that speech to speech
  conversation being another medium - just like discord is a text based medium."

He chose tiny-voca's female voice, F2. This reverses one line of N9's rulings from the same morning ("No local models,
no voice") for voice only, and recommendation 1 asks him to confirm that.

Today the Discord body knows when the User joins or leaves a voice channel (N9), and nothing else about voice. It
cannot hear or speak in a call, and it cannot read or send a voice message.

This document is the design. The risky parts were measured on Mint the night it was written, silently: speech-to-text
on five model families, the whole speaking path fed by a simulated model stream, barge-in on recorded speech, and a
voice message file. Section 8 gives the numbers; `spikes/voice/` holds the code and the audio it wrote.

## The User's rulings (2026-11-15, the evening)

- Voice is allowed, as a medium of its own and as voice messages. N9's "no voice" is lifted for voice only
  (recommendation 1).
- In a call she may hear everyone in the channel, not only the User: "can decode others". This replaces
  recommendation 2 and the parts written for the User's stream only: section 4's single subscription, and phase 2's
  test "others' streams are never subscribed". No audio is kept, as before.
- She joins only the User's channel and leaves when the User leaves: "ok for now" (recommendation 4).
- Voice turns use her own model, deepseek-v4.1-flash, at low effort through `worldModels.voice`. A few measured calls
  set the first-words time before anything else is tried (recommendation 11).
- Her starting voice is picked by ear from the six samples, the slower ones first (recommendation 12). Not picked
  yet.
- The build goes in phase order: voice messages both ways, then the ten-minute live test, then calls.
- Anyone's speech can stop her, not only the User's: "we go natural. so, this should go naturally everyone." Barge-in
  and the hold on new words (section 5) apply to every speaker in the call.
- No notice when she joins a call: "that'd kill immersion." She is visible in the channel as a member, and she
  answers the people she hears.
- Each person's speech becomes its own event under their alias, so she knows who said what: "yes".

Suggested, not ruled: a line in her Discord profile saying she hears the calls she is in and keeps no audio. It
interrupts nothing, and it answers Discord's Terms of Service ("without that person's consent") and Developer Policy
rule 2 (permission before a bot acts on someone's behalf) for anyone who joins and doesn't know her.

## 1. Two things, one organ

- **Voice messages** belong to the Discord world. She can hear a voice message someone sends her, and she can choose
  to send one instead of text.
- **Speech to speech** is a world of its own, the voice world, as the User asked. Its places are calls, and it has its
  own threads, now line and tools, and its own model through `worldModels.voice`. Discord voice channels are its first
  transport. It uses the Discord world's connection (one bot login), so it starts only beside `discord.json`.
- **One organ** makes and hears speech for both: a small local process (section 9).

## 2. Body and mind

The test from AGENTS.md: would a better model make this rule unnecessary? Can the mind notice and correct it from
inside?

| Piece | Side | Why |
|---|---|---|
| Hearing: decoding, voice activity, speech to text | body | An organ. No model hears raw packets in 20 ms; the mind gets words. |
| End of an utterance | body guesses, mind corrects | It has to be decided within a second; a turn takes seconds. Woken on a half sentence, she can stay silent: the tool text says so. |
| Barge-in: duck, then stop | body | 100 to 300 ms is below any model's reach. Like the stop, it is a floor, not a choice of words. What to do next is hers. |
| What she is told when cut off | body records | A record: what was spoken, where it stopped, what was never said. |
| Not starting to speak over the User | body gate | Like the say-hold per place: it waits, then holds with his words; `knowingly` sends anyway. |
| Joining a call | mind (`join_voice`), body gate | When to join is social judgment. The gate keeps her in the User's channel only (recommendation 4). |
| Leaving | mind (`leave_voice`), and the body when the User leaves | Without him she would hear no one (recommendation 2) while others hear her. |
| What to say, how long, in what style; answering a fragment; resuming after a cut | mind | Judgment. The body states the facts of the medium and never a rule. |
| Making text speakable | body, reported | A voice cannot say a code block. The body drops code, emoji and markdown marks, reads a link as its site name, adds no word, and reports each drop. |
| Pauses, resampling, Opus | body | Phonetics and transport. |
| How she sounds: speed, pitch, liveliness | mind, inside bounds | Her voice is hers, like her mood line. The bounds keep it intelligible. |
| A voice message instead of text | mind (`as_voice` on `say`) | Choosing the medium is hers. |
| Backchannels ("mm-hm") and fillers ("let me think") | not built | Words the body made up would be the body speaking in her voice (one-mind rule 7). Revisit when a model is fast enough to listen. |
| Latency per stage, event-loop delay, CPU | body meters | Facts she can see and the User can read. |
| Audio | never kept | Transcripts and her spoken words are river rows. No recording exists. |

## 3. The voice world

- **Its file:** `voice.json` beside `discord.json`. Keys: `voice` (`"F2"`), `speed`, `pitchShift` and `pitchRange`
  (her starting voice), `endpointMs` (700), and where the organ lives (`organ.python`, `organ.models`). A missing
  organ or a bad file fails the start loudly and names what is wrong.
- **Places:** `voice:<channel>`, the channel's name as an alias, like rooms. Each call place is its own thread.
- **What she hears becomes events.** Each finished utterance of the User is a message event in the call's thread:
  actor `owner`, source `owner`, the transcript as text, `data.heard` with its length and the model that heard it.
  There is no debounce: the end of the utterance is the debounce. The world's `about()` says that words she hears are
  machine transcripts and can be wrong.
- **Who she hears: only the User.** Others' streams are never subscribed, so their audio is never decoded or
  transcribed. The now line gives a count, as the voice-state row already does: `In the call living-room with your
  summoner for 12 min; 2 others in the call; you hear only your summoner.`
- **Joining:** `join_voice` takes no place. It joins the channel the User is in, and is refused when he is in none.
  N9's event wake `summoner_in_voice` lets her choose to be woken when he joins. `leave_voice` leaves. The body leaves
  when he leaves.
- **The stop** ends her speech at once (the world's `onStop` flushes the organ) and leaves the call.
- **Disclosure:** her account is a bot, marked as an app beside her name, in the call as in text.

## 4. Hearing

Discord sends each speaker as a separate stream of 20 ms Opus packets. `@discordjs/voice` 0.19.2 decrypts them, DAVE
end-to-end encryption included, and hands one stream per user to a subscriber. The world subscribes to the User's
stream only and passes the packets to the organ. The organ decodes them (the system's libopus), resamples 48 to
16 kHz, runs Silero VAD on 32 ms windows, and runs speech to text when the utterance ends.

**Echo.** Her own voice never reaches her input: a bot does not receive its own stream, and the User's stream holds
only his microphone. So the body needs no echo cancellation of its own. One leak remains. If the User listens on
speakers, his microphone hears her, and his client's echo cancellation (on by default) removes most of it. What slips
through could start a false barge-in. The confirm step below catches most of that. If it happens in practice, the body
drops a transcript that matches her last spoken words (phase 4). Headphones avoid the question.

**End of an utterance.**

- Phase 2: 700 ms of silence by the VAD ends it. `@discordjs/voice` ends "speaking" 100 ms after the last packet,
  which is too eager for a person who pauses mid-sentence. With push to talk, the packets stop when he lets
  go, and 300 ms later the utterance ends.
- Phase 4: Pipecat's Smart Turn v3.2 (8M parameters, 8 MB int8 ONNX, BSD-2, reads audio, 23 languages including
  Turkish). At 300 ms of silence it judges whether the turn sounds finished: yes ends it there; no waits up to 1.5 s.
  Sesame's TurnBench (2026-08-28) shows the trade: endpointers near 200 ms fire on many pauses that are not turn
  ends. That is why the body only guesses here, and she can choose silence on a fragment.
- A monologue becomes events of at most 30 s each, split at a pause.

## 5. Taking turns

### 5.1 Not speaking over the User

She never starts to speak while the User is speaking (VAD speech in the last 300 ms). A say that finds him speaking
waits for his utterance to end, at most 15 s. If by then he has said something since her turn began, the say is held:

`Your summoner spoke after this turn began: "<transcript>". Nothing was said. Say it with knowingly: true to say it anyway.`

Short sounds do not hold her: an utterance under three words or under one second (a "yeah", an "okay") goes into the
receipt of the say instead, after the say went out. Spoken words cannot be edited or deleted like a Discord message,
which is why voice holds where text does not (recommendation 7). His words also come as their own event, so the next
turn sees them in order.

### 5.2 Barge-in: duck, then stop

1. **Duck.** At the User's first packet after at least 300 ms of quiet (his client opened its voice gate), her
   volume drops to 30%. The organ encodes 60 ms ahead, so the duck is heard within 60 ms.
2. **Stop.** When 3 of the last 4 VAD windows say speech (about 100 ms of it), she stops. The rest of the say is
   dropped and never queued for later.
3. **Restore.** If nothing confirms within 600 ms (a cough, a door, a key), the volume comes back and she goes on.

Measured in the spike on Mint, with a recorded speaker (EdAcc, a French speaker) cutting in 3 s into her speech: the
stop came 142 ms after his first packet, 82 ms after his speech began. A cough-like noise ducked her for 603 ms and
she went on; nothing was cut. Two parts are outside the body. His client's voice gate adds about 200 ms before his
first packet (Discord's support page), and the network adds its own. So from his first syllable to her silence is
about 0.35 to 0.45 s, of which the body's share is about 0.14 s.

**What she is told.** The say's receipt, as the spike wrote it:

`Said in part to voice:discord:living-room. Your summoner started speaking 3.1 s in, and you stopped after "back! So,
about the". Spoken: "Oh, nice, you're back! So, about the". The rest was not spoken. Left out of speech: an emoji; a
link, read as its site name; a code block (1 line).`

- The river's say row holds only the spoken words, with `data.cut` (where, and after which word). The words that
  were never spoken are not her says.
- Word positions come from tiny-voca's own per-token durations. Where text normalization changes the word count
  ("12.5" is three spoken words), the spike mapped words by proportion. The build maps them exactly, by phonemizing
  word by word.
- A word begun before the duck and ended after it counts as cut: the recording of the spike ends with "server",
  spoken quietly after the duck.
- His words arrive as the next event in the call's thread.

### 5.3 Backchannels and fillers

Not built. A backchannel is a sub-second social judgment made while he speaks, and her turns take seconds. A filler
made by the body would be the body putting words in her mouth. She can open a reply with a short sentence of her own;
with streaming (6.1), a short first sentence is heard within about 0.15 s of being written.

## 6. Speaking

### 6.1 Speaking before the reply is finished

Today the model's reply arrives as a stream (with `incremental`), and the port joins it before anything acts on it.
Voice needs the say's words as they come.

- **Contract change (on purpose):** `ModelRequest.onDelta?(delta)`. With `incremental` on, the OpenAI-compatible port
  calls it with each tool call's argument fragments as they arrive. Nothing about it is sent to the provider. A port
  without it still works; speech then starts when the reply is complete.
- **The voice lead** in the runtime reads a streaming `say` (the reader in `spikes/voice/say-stream.mjs`: escapes and
  surrogate pairs split across fragments, other fields skipped; 0 mismatches over 299 random splits). When the place
  is a voice place and the first chunk is complete, it starts the utterance.
- **Contract change (on purpose):** an optional `World.speak?(place)` returns a speech stream with `push(text)`,
  `end()`, `cancel(reason)` and `done`, a promise of the say's result. `SayResult` gains `delivered?: string`, what
  reached the place when not all of it did. The runtime records that, not the whole text.
- When the loop then runs the `say` tool with the same arguments, the tool attaches to the utterance in flight and
  returns its receipt when the speech ends or is cut. If the reply fails or the call never runs (the ceiling), the
  utterance is cancelled, and a body note says what was spoken.

**Checks.** The stop, secrets, the privacy list, the impersonation hold and the world's outward hold are local and
take under a millisecond, so they run on every chunk. A chunk they hold ends the utterance there, and the receipt
names the check. The say-hold per place and the floor gate (5.1) run once, before the first chunk. The honesty hold is
a model call on the whole say and cannot run per sentence. When `holds.honesty` is on, a voice say waits for its whole
text and the check, which costs one model call of latency (recommendation 6). It is off unless written.

### 6.2 Making text speakable

dizione, tiny-voca's phonemizer, already reads numbers, dates, money, units and chat forms. The body adds, and
reports in the receipt:

| In the text | Spoken as | Reported |
|---|---|---|
| code block | nothing | `a code block (n lines)` |
| emoji | nothing | `an emoji` |
| link | its site name ("status dot example dot com") | `a link, read as its site name` |
| `[label](url)` | the label | nothing |
| `**bold**`, `_it_`, `` `code` ``, `# heading`, `> quote`, list marks | the words without the marks | nothing |

Each list item becomes its own chunk. The body never adds or reorders words.

### 6.3 Chunks and pauses

- The first chunk may end at a comma, colon or dash once 10 words are in, so speech starts early. Later chunks end at
  sentence ends and line breaks, and at most 32 words.
- "Dr.", "e.g.", "12.5" and "example.com" do not end a sentence.
- Pauses after a chunk: 300 ms after `.`, 320 after `!`, 340 after `?`, 420 after `…`, 150 after a clause, 380 after a
  line break. Each chunk is first trimmed of the model's own silence at its edges.
- Synthesis runs on its own thread in the organ, so frames never wait for the next sentence: no underrun in 4 runs of
  18.4 s each (920 frames each). A 6 s sentence takes about 0.5 s to make.

### 6.4 Her voice

- tiny-voca's inputs: `speed` (1.0 as trained; larger is faster), `pitch_shift` (added to log F0; 0.058 is about one
  semitone) and `pitch_range` (scales pitch movement). Its card says the default speed is a little faster than the
  recordings it learned from, and that the same text is always read the same way.
- `voice.json` holds her starting voice. Six samples of one sentence (`spikes/voice/out/prosody-*.wav`) let the User
  pick by ear: default, slower, slower and livelier, higher and livelier, lower and calmer, flat.
- Phase 4: `set_voice` lets her change her own voice inside bounds the body keeps: speed 0.85 to 1.15, pitch within
  two semitones, liveliness 0.7 to 1.4. It is kept in her state and shown on the board, like her mood.

### 6.5 The sound path

24 kHz from tiny-voca, then 48 kHz through a 63-tap windowed-sinc filter, then Opus in 20 ms frames, stereo at
64 kbps (Discord asks for 48 kHz stereo). The organ encodes three frames ahead, which is why a duck lands within 60 ms.
`@discordjs/voice` sends Opus packets as given, so Node needs no Opus package.

## 7. Voice messages

- **Hearing one.** A message flagged as a voice message from someone admitted in that place: the body fetches the
  attachment from Discord's CDN only, as it does pictures, reads the Ogg file (Node), and the organ decodes and
  transcribes it. The event text: `[voice message, 7 s] <transcript>`. Voice messages from people other than the User
  count toward the daily cap on pictures and files. The audio is not kept.
- **Sending one.** `say` gains `as_voice: true`, for Discord text places only. Every check runs on the whole text
  first, the honesty hold included: nothing is spoken live, so nothing needs to start early. Then the organ speaks the
  whole say into Ogg Opus, mono, 48 kHz, 32 kbps (what Discord's own clients send), and the body adds the duration and
  the waveform (one byte per point, at most 256 points, at most one point per 100 ms). It goes out with discord.js
  14.27 or later: `AttachmentBuilder.setDuration().setWaveform()` and `MessageFlags.IsVoiceMessage`. Discord allows no
  text beside a voice message, so the river's say row keeps the text and marks it as sent as a voice message. At most
  2 minutes a message.
- **Spike:** 18.4 s of speech made in 1.85 s, a 70.6 KB file. libsndfile reads it as Ogg Opus, 48 kHz, mono, 18.39 s.
  Parakeet hears it back with 6 errors in 61 words, nearly all formatting ("dot" written as ".", "I'd" for "I would").

## 8. Measured on Mint (2026-11-15)

Mint: AMD A6-9220 (2 cores, 2.5 GHz, AVX2), 3.7 GiB, about 2.5 GB available, with Ashley's process at 220 MB. Every
bench ran on one thread at low priority, wrote files and played nothing. Three sets of speech:

- 20 read LibriSpeech clips (188 s, about 9 s each)
- 32 conversational EdAcc clips (179 s, about 5.6 s each) from speakers whose first language is not English (14
  languages; no Turkish speaker was found in the part of the corpus reached)
- 8 lines spoken by tiny-voca F2

### Speech to text

| Model (int8) | On disk | Peak memory | Errors, read | Errors, accented | Compute ÷ audio | Wait after he stops (5.6 s, median) |
|---|---|---|---|---|---|---|
| **Parakeet TDT-CTC 110M** (sherpa-onnx) | 132 MB | 348 MB (481 on 30 s clips) | **5.1%** | **20.6%** | 0.15 | **0.70 s** |
| Whisper base.en (sherpa-onnx) | 160 MB | 643 MB | 9.6% | 20.8% | 0.55 | 3.17 s |
| Moonshine base (sherpa-onnx) | 141 MB | 426 MB | 7.8% | 28.6% | 0.15 | 0.80 s |
| Moonshine tiny (sherpa-onnx) | 43 MB | 300 MB | 11.4% | 31.9% | 0.08 | 0.38 s |
| Kroko streaming zipformer (sherpa-onnx) | 71 MB | 197 MB | 10.0% | 29.3% | 0.13 while listening | 0.00 to 0.16 s |
| Moonshine tiny streaming (moonshine-voice) | | 293 MB | 12.3% | 36.5% | 0.87 to 0.93 while listening | 0.57 s |
| Moonshine small streaming, 10 accented clips | | 449 MB | | 27.9% | 0.71 | 4.2 s |

On the same 10 accented clips: Parakeet 24.0%, Moonshine small 27.9%, Whisper base 18.6%. Two threads did not help
Parakeet (0.139 against 0.146). Error rates count words against the corpus's own transcripts, fillers removed; EdAcc
transcripts keep repetitions ("A A A") that every model drops, so the accented numbers are high for all.

**Choice: Parakeet TDT-CTC 110M through sherpa-onnx, one thread.** It ties Whisper base on accented conversation, it
is the most accurate on read speech, it answers in 0.4 to 0.7 s for a normal utterance, and it writes punctuation and
capitals. Whisper base is four to five times slower. Moonshine's 2026 streaming models were slower on this CPU than
their published x86 numbers and the least accurate on accents. Kroko streams with almost no wait, but makes about 40%
more errors on accents, and 13% on her own synthetic voice.

### The rest

| What | Measured |
|---|---|
| Silero VAD v5 | 0.75 ms per 32 ms window (p99 0.95 ms): 2.4% of one core while he speaks; +38 MB |
| tiny-voca F2 (the lead's bench) | 12 to 21 times faster than real time on one core; 210 MB |
| Organ in one process: onnxruntime 1.32 + sherpa-onnx 2.0.1 | TTS 200 ms and STT 470 ms for a 3.6 s sentence, 3 rounds; 406 MB resident; venv 208 MB on disk |
| Model's first token to her first frame (spike) | 597 ms at 50 tokens/s, 1003 ms at 25: the first sentence's text took 447 ms, synthesis 130 ms |
| Underruns | none in 4 runs of 18.4 s |
| Barge-in | duck within 60 ms of his first packet; stop 142 ms after it, 82 ms after his speech began |
| False start | a 180 ms noise burst: ducked 603 ms, no stop |
| Voice message | 18.4 s made in 1.85 s; 70.6 KB; decodes; heard back with 6 errors in 61 words |

## 9. The organ: a Python process, not a Node port

Two shapes were possible: a small Python process beside her, or a Node port of dizione with ONNX Runtime's Node
binding.

**Decision: a Python process, the voice organ.** Node starts it and talks to it over its stdin and stdout, in frames:
a length, a JSON header, a length, a binary body. One process holds onnxruntime 1.32, numpy, dizione (from its git
commit; it is not on PyPI) and sherpa-onnx 2.0.1, in a venv beside the Lar's service. Why:

1. **The phonemizer must match tiny-voca exactly.** The model was trained on dizione version 4 (its config records a
   fingerprint). A port is 2,777 lines of Python (1,070 of text normalization) plus a small GRU in numpy, and any
   drift mispronounces words. The real dizione has no drift.
2. **The runtimes are native either way.** `onnxruntime-node` and `sherpa-onnx-node` are native addons too. In Node
   they would also need worker threads, to keep inference off the thread that sends a packet every 20 ms.
3. **A separate process isolates her mind.** A crash in native audio code leaves her mind running in text, and the
   organ runs at a lower priority than her mind's process, which keeps the audio clock.
4. **Opus costs nothing extra.** The organ uses the system's libopus (1.4 on Mint), so Node needs no Opus package.

The cost: Python 3.12 and a venv on the host, a second language in the repository, and organ tests that run only where
the venv exists. The protocol is small, so a Node port later would replace the organ and nothing else.

| Op | Asks | Answers |
|---|---|---|
| `speak` | words, voice, prosody, pause, channels, bitrate | the chunk's length and word timings; its sound joins the utterance's queue |
| `frames` | n frames at a gain | n Opus packets (and their PCM, for tests) and the position |
| `flush` | an utterance | where it stopped and what was dropped |
| `hear` | Opus packets from one speaker | VAD probabilities per window |
| `transcribe` | a finished utterance, or a voice message's packets | the words |

Replies match requests by id. Synthesis runs on its own thread, in order. An error comes back as a reply and is shown,
never swallowed. The world restarts a dead organ after 1, 5 and then 30 s, and says it is resting meanwhile.

**Node's new dependencies**, loaded only when `voice.json` exists:

- `@discordjs/voice` 0.19.2, which brings `@snazzah/davey` for DAVE (native, prebuilt for Linux x64), `prism-media`
  and `ws`. Discord has refused calls without DAVE since 2026-03-01.
- `@noble/ciphers`, pure JavaScript, for the xchacha20 mode Discord says every client must support. Node's own crypto
  covers AES-GCM, which Discord usually offers.

**Budget on Mint:**

| | Memory | CPU (2 cores) |
|---|---|---|
| Ashley's process today | 220 MB | mostly idle |
| Organ, loaded | about 410 MB (measured), up to 550 on long utterances | idle near 0 |
| While he speaks | | Opus decode and VAD, about 3% of a core |
| When he stops | | Parakeet on one core, 0.4 to 0.7 s |
| While she speaks | | synthesis at about 1/12 of real time, Opus under 1% |
| Voice libraries in Node | about 40 MB (estimate) | packets every 20 ms |
| Left available | about 1.8 GB | |

**A risk to watch:** her process sends a packet every 20 ms from its main thread. A long synchronous step in a turn
(SQLite, building the context) delays packets. The User's jitter buffer hides some of that. Phase 2 adds an
event-loop delay meter. If speech stutters during turns, the voice connection moves to a worker thread.

## 10. Latency: from the end of his words to her first sound

| Stage | Phase 2 | Phase 3 and 4 | Source |
|---|---|---|---|
| His last words reach the bot | about 0.05 s | | estimate |
| Silence that ends the utterance | 0.70 s | 0.3 to 0.5 s (Smart Turn) | design |
| Speech to text | 0.4 to 0.7 s | 0.15 to 0.3 s (phrases transcribed as they end) | measured |
| Event to model request | unknown, likely about 0.1 s | | phase 2 meter |
| Model, to the say's first words | unknown: seconds with reasoning | under a second with a fast voice model at low effort | not measured: a paid call |
| First sentence written | the whole say first | 0.45 s at 50 tokens/s | spike |
| First chunk synthesized | 0.10 to 0.13 s | same | spike |
| First frame, Discord, his jitter buffer | about 0.1 s | same | estimate |

The body's share comes to about 1.5 s in phase 2 and about 1 s by phase 4. The model's time comes on top, and it is
the largest unknown. People leave about 200 ms between turns (Stivers et al., PNAS 2009). OpenAI's realtime server
VAD commits a turn 282 ms after it ends (TurnBench). Her voice will not be that fast on this machine with a remote
model. A fast voice model (`worldModels.voice`, recommendation 11) and a short first sentence of her own close most of
the gap. The now board shows her the last reply's times per stage, so she can see it too.

## 11. What can go wrong (catalogued before building)

| Where | What | Answer |
|---|---|---|
| DAVE | receive breaks after a key change (discord.js issue #11653, open since 2026-10-08) | a live test with the User before phase 2; a decrypt failure resubscribes and leaves a note |
| hearing | someone else in the call is heard | their streams are never subscribed |
| hearing | her own voice leaks back through his speakers | his client's echo cancellation; the confirm step; drop a transcript that matches her last words |
| hearing | a wrong transcript | `about()` says transcripts can be wrong; the event names the model |
| turn end | woken on half a sentence | she can stay silent; the next words come as an event |
| barge-in | a cough or keyboard stops her | duck, then stop only on about 100 ms of speech; tested with a noise burst |
| barge-in | the rest of her say spoken later | dropped, never queued |
| speaking | a held word mid-say | that chunk and the rest are not spoken; the receipt names the check |
| speaking | the honesty hold cannot run per sentence | with it on, a voice say waits for its whole text |
| speaking | a long synchronous step in a turn stutters her | event-loop meter; voice moves to a worker if needed |
| speaking | the model call fails mid-say | the utterance is cancelled; a note says what was spoken |
| organ | it crashes | restart with backoff; the world rests; her text life goes on |
| organ | onnxruntime and sherpa-onnx in one process | tested together: works (section 8) |
| memory | the organ grows on long utterances | utterances capped at 30 s; peak measured at 481 MB with 30 s clips |
| voice message | Discord refuses the flag from a bot | test on a private channel first; then the say is refused with Discord's reason |
| voice message | a stranger floods her with voice notes | the daily cap on pictures and files counts them |
| privacy | a privacy-list word spoken aloud | the privacy check runs on every chunk before it is synthesized |
| stop | she keeps talking after a stop | `onStop` flushes the organ and leaves the call |

## 12. Phases

Every phase has tests beside each module. They use no network and no real model key, pass on Windows and Linux, and
need no Python: the organ is faked in Node tests. The organ's own Python tests run only when an environment variable
names its venv.

**Phase 1: the organ and voice messages.** Usable first, and it carries none of the live-call risk.

- The organ (speak, frames, transcribe), its Node client and framing, and its supervisor.
- The Discord world hears voice messages and sends them with `say` and `as_voice`.
- Node tests:
  - the frame codec
  - the client against a fake organ: replies, error replies, the organ dying and restarting
  - the Ogg writer: CRC, lacing and granule positions; a fixed packet set gives fixed bytes
  - the waveform: at most 256 points, at most one per 100 ms
  - `speakable` and the chunker, over a table: abbreviations, decimals, links, emoji, fences, lists
  - a voice-message say on the fake platform client: the flag, duration and waveform with no text; the checks before
    synthesis; a refusal while the organ is down
- Python tests: the Opus round trip, the resampler's response, word timings summing to the audio's length, a bad
  request answered with an error.
- On Mint after deploy: she sends the User a voice message in his DM, and his voice message to her arrives as a
  transcript.

**Phase 2: the voice world, speaking whole says.** Before building: a ten-minute live test with the User on a private
channel, for DAVE receive.

- `join_voice` and `leave_voice`; hearing as events; the 700 ms endpoint; the floor gate and the meanwhile hold;
  barge-in; the cut-off receipt; the now line; the stop; the event-loop meter.
- Tests run on a fake voice transport:
  - a scripted packet timeline gives the events
  - a barge-in timeline gives the duck and the stop at the expected frames, and the receipt's exact text
  - others' streams are never subscribed
  - she leaves when the User leaves
  - the stop flushes

**Phase 3: speaking as she writes.** `ModelRequest.onDelta`, the voice lead, checks per chunk, `World.speak`,
`SayResult.delivered`, and `worldModels.voice`. Tests:

- the reader under random splits
- a fake model port streaming a say: the first chunk is spoken before the reply completes
- a privacy-held chunk stops the utterance with a receipt that names the check
- a cancelled call leaves a note
- with honesty on, nothing starts early

**Phase 4: the natural feel, each step after measuring real calls.** Smart Turn endpointing, `set_voice`, phrases
transcribed as they end, the echo drop, and small sentence-to-sentence variation in her pitch, if the User wants it.

## 13. Still unknown

- **The model's time to its first words in a voice turn.** It is the largest stage and was not measured: it needs a
  paid call.
- **DAVE receive in a real call** (issue #11653).
- **The User's own voice and accent.** No clip of his was used. He can record three sentences on his PC (not on
  Mint), and they go through the same bench.
- **Whether Discord takes the voice-message flag from a bot.** The docs do not restrict it.
- **How her process's event loop behaves during a turn while audio plays.**
- **Exact word positions where normalization changes word counts** (a build task, not a risk).
- **Whether F2's sameness ("the same text is always read the same way") wears over long talks.**

## Recommendations for the User

1. Voice is allowed, as a medium of its own and as voice messages. This lifts N9's "no voice" for voice only.
2. In calls she hears only you. Others' audio is never decoded or transcribed.
3. No audio is kept. What you say becomes text in her river, marked as heard by a machine.
4. She joins only when she chooses, only your channel, and leaves when you leave. She can set the event wake for when
   you join.
5. The organ is a small Python process on Mint, not a Node port.
6. With the honesty hold on, a voice say waits for its whole text. It is off today.
7. A voice say is held when you said something since her turn began, except a short "yeah" or "okay". She can say it
   anyway.
8. The body makes no fillers or backchannels. Only she chooses words.
9. Phase 1 first: voice messages both ways, then the live test, then calls.
10. Speech to text is Parakeet TDT-CTC 110M, on one core.
11. Voice turns get their own fast model and a low effort through `worldModels.voice`. Which model is your call; it
    decides most of how quickly she answers.
12. Pick her starting voice by ear from the six samples in `spikes/voice/out/` (speed, pitch, liveliness).
