# Replay: capture, replay, judge

A replay runs the same recent inputs through a different model, or through a changed layer of the entity, and
compares what it says with what the entity actually said. It is the gate before a candidate goes live.

**Rule:** a candidate (another model, or an entity-layer change) must at least match the reference before it goes
live. Replay the same events with the candidate, judge it against the reference, and check the report. A report
with unjudged events is not a pass until those events are judged.

## 1. Capture

```
natalis capture --dir <entity folder> --since <ISO time> --until <ISO time> --out <folder>
```

Reads the entity's river for the window (`--since` inclusive, `--until` exclusive) and writes two files:

- `events.jsonl`: what the worlds sent in, one event per line, in time order. Each line has `world`, `place`,
  `thread`, `source`, `atMs`, and `actor`, `text`, `data` when present.
- `reference.jsonl`: what the entity said in the same window (`place`, `text`, `atMs`).

Forgotten rows are skipped. Capture only reads the river.

## 2. Replay

```
natalis replay --dir <entity folder> --events <events.jsonl> --out <run folder> [--config <entity.json>]
```

- The entity is copied into `<run folder>/entity`. The river copy is cut at the time of the first event, so the
  replay starts where the entity was. The notebook copy is reset to its last commit before that time, and
  `state.json` is made to match. The original folder is never written.
- `--config` replaces the copy's `entity.json`, for example to try another model block.
- The copy is opened on a virtual clock. Events are fed one at a time, and the replay waits for the entity to be
  idle before the next one.
- Nothing is delivered. Every reply is written to `<run folder>/transcript.jsonl`. Wakes the entity schedules are
  recorded there and are never fired.
- The replay stops early if the model fails three times in a row.

## 3. Judge

```
natalis judge --events <events.jsonl> --a <run folder or reference.jsonl> --b <run folder or reference.jsonl> \
  --rubric <rubric.md> --judge <judge.json> --out <folder>
```

For each event, a judge model sees the rubric, the event, and what each side said from that event until the
next one. The sides are shown as X and Y in an order chosen at random, and the order is recorded in the report.
The judge answers in JSON only: a score from 1 to 5 per criterion for X and for Y, a preference (X, Y or tie),
and one line of why.

- **Rubric.** Each bullet in the file is a criterion: `- name: what good looks like`. The text before the colon is
  the name. The rubric file is read by path and is never copied into the repository.
- **Judge config.** `judge.json` holds one model block, in the same shape as the `model` block of `entity.json`.
  The key is read from the environment variable it names.
- **Replies that do not parse** are retried once. If the retry fails too, the event is recorded as unjudged, with
  the reason. Nothing is filled in silently.

Output: `report.json` (every event, the order shown, the scores, the preference, the why, and the totals) and
`report.md` (totals per criterion, wins, ties and losses, the five largest gaps with their whys, and the unjudged
events).

## Limits

- The judge is a model too. Its scores are evidence to read, not proof.
- The replay copy differs from the live entity only in what the replay changes: the model or config, and the
  wake tools that record instead of fire. Wake receipts show the time in UTC.
- Judge a candidate against the same capture window as its reference, every time.
