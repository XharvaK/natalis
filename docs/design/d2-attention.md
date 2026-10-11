# D2: attention of her own

The helper's thalamus decides which changes in the game reach her: habituation, novelty, arousal, a threshold, a
refractory period, boredom and a slow check while she is busy, about twenty tuned numbers. Each is a judgment about
what matters to her, made for her. D2 removes it. The body sends every change, mechanically coalesced. Whether a change
starts a turn is a setting she holds and changes with a tool. Checked against the source on 2026-10-11 (Natalis main
8423ae0, Domus ds3-senses c5c272a).

## What goes wrong if this is built thinly (failure modes first)

1. **A view per change floods her turns.** Since N8 each view is long: her body now, the percepts, and the lot's
   choices. Every admitted view is an event, and a turn shows the thread's last 30 rows plus every new one. Five views
   arriving while she thinks would put five whole bodies and lots in front of her. Ten recent views at the 20,000
   character view cap is 200,000 characters. **This is live on main after N8 and must be fixed before N8 is
   deployed.**
2. **Waking on everything costs a turn per change.** Her own act makes "started" and "ended" changes; her needs
   change bands; people walk about. Every change waking her is honest but loud. That is her choice to make, and she
   can only make it with a setting that exists.
3. **Quiet means blind.** If changes do not wake her, she must still be able to look whenever she wants, and to
   be woken for what cannot wait.
4. **Something cannot wait.** A window held for her answer times out (the probe's fallback after 180 s). If her setting
   kept her asleep through it, the game would answer for her. A question with a deadline always wakes her: that is not
   a judgment about importance. It is the only way her setting does not take a choice away from her.
5. **A stale picture of her body.** If nothing changes, nothing is sent, and the last view's game time ages. When she
   wakes for her own reasons she must be able to ask for a fresh view, not read an old one as now.
6. **Two clocks.** The game may run at speed 3 while she sleeps or works. Coalescing is on the wall clock and
   says nothing about game time; the view carries the game's time.
7. **The setting is forgotten.** If a restart resets her setting, the body overrules her. It is kept in the world's
   database until she changes it.
8. **The old Host by another name.** A "which kinds of change wake her" list must be facts about the change (a
   question was put to her, someone spoke to her, someone came, her act ended, the game attached), never rankings
   of importance. She picks the mode. The body never picks for her by need level or mood.

## The design

### Natalis

**N1. Older views shrink (the prerequisite, failure 1).** A world event may name a `view` (a string key, the same
for every event of one kind of full view on a thread) and a `brief` (a short text). The runtime renders a turn as
today, except that among the rows it shows (recent and new), only the newest row of each `view` key is shown with its
full text; every older row with that key is shown by its `brief`. Both are stored in the row's data (`data.view`,
`data.brief`) when the event is written, so the rule holds across restarts. A row without `view` is unchanged. This
is a generic body mechanic for any world with full-state views.

The Domus world sets `view: "domus"` and a `brief` on each observation event: the percept lines only (the F6 plain
words), with no body block and no choices; when there are no percept lines, "An earlier view."

**N2. Her attention setting (failures 2, 4, 7, 8).** A tool `game_attention` for her game thread, with these modes:

- `every_change` (the setting a new Lar starts with): every view wakes her.
- `when_called`: a view wakes her only when one of its percepts is one of these facts: a question opened for her
  (`env`, bucket `asked`); someone addressed her (`social`, bucket `addressed`); someone arrived on the lot
  (`presence`, bucket `arrived` or `on_lot`); one of her acts ended or the game refused it (the act receipts already
  wake her); the first view after the game attached; the day record at sleep onset; a look she asked for.
- `quiet`: nothing wakes her until `until` (a time, required, at most 24 hours ahead); then the mode reverts to what
  it was before. A question with a deadline still wakes her.

It also takes `look_every_minutes` (an integer from 5 to 240, or 0 to turn it off; any mode): while the game is
attached and her game thread has had no turn for that long, the world asks the helper for a look (N3).

A view that does not wake her is still written to her game thread, so she sees it by its brief in her next turn
there. In every mode, a view whose portrait shows a window held for her (`asked` with `held: true`), or that carries
an `asked` percept, wakes her (failure 4).

The setting is stored per game thread in `domus.sqlite` and kept across restarts. The body block's first lines say
it: "Your attention: every change." / "Your attention: when something calls you, and a look every 30 minutes." /
"Your attention: quiet until 14:30." The tool's description says what each mode means in these same facts, and that
a question with a deadline always reaches her.

**N3. A fresh look (failures 3, 5).** A tool `game_look`: asks the helper for a view of now. The helper answers on its
next sync with a view carrying one percept of kind `look`; a look view always wakes her. The sync answer carries
`look: true` when a look is owed (one flag, cleared once handed over). If the game is not attached, `game_look` is
refused with `not_attached`, as `game_act` is.

### Domus helper

**H1. The thalamus goes; a coalescer sends.** `bridge.py` stops calling `thalamus.core.decide` and `prune`. A new
small module keeps pending percepts from the Extractor. It sends one view when any of these is true:

- something is pending and nothing new has come for 1.5 s;
- or the first pending percept is 8 s old;
- or a pending percept is a question opened for her (at once).

It sends nothing when nothing is pending. Pending percepts are de-duplicated by key, the newest kept, and the newest
32 are sent (the wire's cap). The view is built by `thalamus/observation.py` `build` as today, with the pending
percepts as its percepts and salience 0. Removed with the thalamus decision:

- arousal, habituation, novelty, threshold, refractory, boredom and the busy slow check;
- the plan-step urgency rewrite;
- the scorer run;
- `CLOCK_WAKES` and the stale-row skip.

The decision log keeps one line per view sent: time, percept count and kinds, observation id.

**H2. Percepts are changes, not judgments.** The Extractor's percepts stay. Its urgency marks are no longer read.
Need percepts come only on a band change, so the drift rule (`z >= 2.0` without a band change) goes. Interaction
surprise from learned durations no longer matters and is not sent.

**H3. A look.** When the acts sync answer carries `look: true`, the helper sends one view at once from the newest body
row, with one percept `{kind: "look", facts: {bucket: "asked"}}` (plus anything pending, which this view takes). With
no body row yet, it sends nothing and logs it.

**H4. Kept as they are.** Pace (half drain), the day record at sleep onset (always sent), the windows, the menu, the
acts, and the talk, overlay and director features.

## Wire changes (v1, both sides in one deploy)

- `POST /domus/acts/sync` answer: a new optional key `look` (boolean). The helper accepts it.
- Percept kind `look` (the Natalis wire already accepts any `[a-z0-9_]{1,32}` kind; the helper's contract checks
  this too).
- Nothing else. Salience stays in the wire, always 0 from now on.

## Verification

- **Natalis:** runtime tests for N1 (three views in one turn: one full, two briefs; a restart keeps it).
- **World tests for N2 and N3:**
  - each mode's wake decision;
  - a held window wakes her in `quiet`;
  - the mode is kept across a world restart;
  - `quiet` reverts when its time passes;
  - `look_every_minutes` asks for a look after the gap, not while attached-less;
  - `game_look` while detached is refused.
- **Helper:** coalescer unit tests (debounce, the cap at 8 s, a question at once, nothing pending sends nothing, dedup
  keeps the newest, 32 cap); bridge tests that a look flag sends one look view; the thalamus decision is no longer
  called.
- **Live (with the summoner):** during play, she sets `when_called` and is woken by a visitor's knock and by a
  recipe picker, and not by her hunger going down a band.
