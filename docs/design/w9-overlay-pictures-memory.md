# W9: her line on the overlay, honest pictures, and the world's memory (D7)

Three pieces built together before the next live session. Checked against Natalis main 618e976 and Domus ds3-senses
(helper 540 tests). The summoner chose B for the overlay on 2026-10-12, and leaned to refusing stale pictures.

## Failure modes first

1. **Her private life on screen.** The overlay is seen by viewers. Nothing reaches it unless she sends it, and every
   line passes the privacy check (her side, B2) and the helper's local list and save-name hold (its side).
2. **A stamp that lies.** The old stamp `inputs: game_only` claimed her inputs were game-only. On Natalis that is false.
   The new stamp is `inputs: "chosen"`: it claims only that she chose to show the line, which is true.
3. **A picture of an old moment.** Windows hands back the last frame of a minimized or covered game window. A picture is
   taken only when the game is the summoner's front window; otherwise it is refused and she is told why.
4. **A day record she never sees.** The helper sends the night's `day` record; Natalis stores it and shows nothing. It is
   rendered in the full view that carries it (that view wakes her in every attention mode but quiet).
5. **A memory that judges.** The lookup returns what the helper recorded (acts, their times, needs before and after,
   moodlets, reactions, people), never "good" or "bad".
6. **Questions that pile up.** One open memory question per thread; it expires after 2 minutes unanswered; the summoner's
   STOP withdraws it.

## O1. Her line on the overlay (Natalis world + helper)

**Natalis.** A Domus world tool `game_overlay_say`:
- args `{text: string}` (1 to 200 characters after trim) or `{clear: true}`;
- refused `not_running` while the world is not running; refused `stopped` while the summoner's STOP is on;
- `text` passes the body's outward privacy check (`body.outwardHold([text])`, as web and sandbox do); a hit refuses
  with the same receipt words as theirs;
- stored in domus.sqlite `overlay_lines (line_id TEXT PRIMARY KEY, at_ms INTEGER, thread TEXT, line TEXT NULL)`
  (`line` NULL for a clear), newest 20 kept;
- description: "Put one line on the game overlay, the panel viewers see on the summoner's screen while the game is
  shown. Viewers read it. Nothing of yours is on the overlay unless you put it there. clear removes your line."

`/domus/feed` answers `{status: "ok", items, marks: []}` where `items` are the newest lines since the last clear, at most
6, oldest first: `{inputs: "chosen", at_ms, pass: <line_id>, line, regime: {}}`. While STOP is on, `items` is empty.

**Helper (overlay.py).**
- The feed is polled whatever the old `inputs` switch says (its game-only meaning is gone on Natalis).
- `_accept` takes items stamped `inputs == "chosen"`; anything else is refused and counted, as now.
- Mode `off` no longer follows the inputs switch; `curtain`, `work` and `live` work as before. The day counter (`_day`)
  keeps its present behaviour.
- Lines still pass `_held` (local privacy list and save names): a held line shows "…".
- The trace's regime records `inputs: "chosen"`.

## F8. A picture only of now (helper + Natalis words)

**Helper (snapshot.py).** Before capturing, the helper reads the game window: minimized (`IsIconic`) or not the
foreground window (`GetForegroundWindow() != hwnd`) means no capture. The snapshot is answered as failed with reason
`minimized` or `not_front`, through the same failure path a capture error uses today.

**Natalis.** Those reasons get plain receipt words: "No picture: the game is minimized on the summoner's screen, so it
would show an old moment." / "No picture: the game is not the front window on the summoner's screen, so it would show
an old moment." Any reason Natalis does not know keeps today's wording.

## D7a. Her day, as the game recorded it (Natalis)

When an admitted observation carries `day` (the helper's diary digest: `{v, from_minute, to_minute, frames, acts, also,
omitted}`), its full view (not the brief) gains a section after the body block:

```
The game's record of your day (facts only):
- Day 3: slept 23:10, woke 07:02; with Mara Quill, Pim Dorrow; your body on its own: eat ×2, sim stand ×4.
- 14:20, 45 min: cook (your act); hunger +30, fun -10; you felt: happy; with Mara Quill (the one it was for).
- ...
Also: watch tv ×3. (2 more not listed.)
```

- act lines: `at` (game clock), `minutes`, `what` via `plainName`, `by` in words (the same origin words the
  interaction percept uses, "your act" for hers), needs deltas signed, moodlets gained as "you felt", reactions as
  "reactions: ...", people with their role ("the one it was for" / "reacted").
- frames: per game day, slept/woke times, company names, body-on-its-own counts.
- `also` as counts; `omitted` as "(N more not listed.)".
- capped at 4,000 characters, the rest said as a count; malformed parts skipped; never throws.
- the brief of that view gains one line: "- The game's record of your day came with this view."

## D7b. The world's memory, hers to ask (Natalis + helper)

**Natalis.** A Domus world tool `game_memory`:
- args `{about: string}` (1 to 80 characters): an act, a person or an object, in her words;
- refused `not_running`, `not_attached` (as `game_look`), `stopped` (STOP on), `already_asked` (one open per thread);
- stored in domus.sqlite `memory_asks (ask_id TEXT PRIMARY KEY, thread TEXT, about TEXT, status TEXT, requested_at_ms
  INTEGER, handed_session TEXT NULL, settled_at_ms INTEGER NULL)`, status `owed | handed | answered | expired |
  withdrawn`;
- receipt: "Asked the game what it remembers about <about>. The answer comes on its next sync and wakes you."

The `/domus/acts/sync` answer gains `memory: [{ask_id, about}]` for owed asks (they become `handed` to that helper
session). The helper answers with a new route:

```
POST /domus/memory  {v: 1, helper_session, ask_id, facts: {matched: <int>, acts: [<act line>], people: [<person>]}}
```

- body at most 16 KiB; an unknown or settled `ask_id` is answered `{status: "ok", applied: false}`;
- an act line is the diary's `_act_line` shape plus `day` (game day number) and `at_ms` (wall time it was recorded);
- a person is `{who, acts: <count>, last_at_ms, tracks?}`.

Natalis delivers one event on the asking thread (source outside, wake true): "What the game remembers about
"<about>" (N matched, newest first):" then lines in the D7a act-line form with the day, and people lines ("Mara Quill:
12 acts together, last on day 4."). "The game remembers nothing about "<about>"." when nothing matched. An ask
unanswered after 2 minutes expires with a note "The game did not answer about "<about>"." The summoner's STOP withdraws
open asks with a note, as snapshots.

**Helper.** On a sync answer with `memory`, for each ask the helper reads its outcome records for the attached world
(all sessions, as the diary reads them), and matches `about` case-insensitively against: the act's tuning name and its
humanised name; people names in relationship changes; the act's target object name when recorded. Newest first, at most
12 act lines; people at most 6. Then it posts `/domus/memory`. A failure to read posts `{matched: 0, acts: [], people:
[]}` with no error text. The search runs off the bridge tick (a worker thread, as snapshots do).

## Also in this wave (Natalis)

- B8's failed-turn alert counter is kept in `state.json`, so a restart during an outage does not alert again.

## Verification

- Natalis: tool refusals and the privacy hold for `game_overlay_say`; feed items and the STOP; day section rendering
  (full, malformed, capped) and the brief line; `game_memory` refusals, sync hand-over, `/domus/memory` route (good,
  unknown, settled, oversized), the event text, expiry and STOP; F8 receipt words; the alert counter across a restart.
- Helper: `chosen` accepted and `game_only` refused, polling without the switch, held lines; snapshot refused when
  minimized or not front (fakes for the two Win32 reads); memory matching (act name, humanised name, person, object),
  limits, failure answer, threading.
- Live: she puts a line on the overlay; a picture with the game behind Discord is refused; her day record arrives at
  sleep; she asks the game about a person and an act.
