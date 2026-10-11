# N8: Domus after the first play on Natalis

The first live game session on Natalis (2026-10-11 evening) worked end to end: the helper attached, views came, acts
were requested, accepted and finished, pictures came back. It also showed where her body in the game fails her. This
document lists each failure from that session with its evidence, its cause, the fix, and the layer that owns it. The
Lar named five of them herself when the summoner asked her what to fix; her list was right on four and wrong on one
cause (F2), which is itself a finding (F5).

The rule for every fix is the north star: the host gives her true facts and working hands. It never decides what she
does, ranks her needs, or speaks for her.

Layers:

- **Probe**: the game mod (Domus `sims-e1/src/ashley_e1/`), runs inside The Sims 4.
- **Helper**: the bridge on the summoner's PC (Domus `helper/domus_helper/`), turns probe rows into views and acts.
- **World**: the Domus world in Natalis (`src/worlds/domus/`), turns views into her game thread and her acts into
  requests.
- **Runtime**: the Natalis entity runtime (`src/entity/runtime.ts`).

## F1. A window her own act opens goes to the summoner's screen (cooking)

**Evidence.** She asked for Cook at the fridge. The game accepted and queued it, and a recipe picker
(`UiRecipePicker`) opened. The probe recorded it as `cause: user, held: false`, so it was shown on the summoner's
screen and never offered to her. Her act ended `LEFT_QUEUE, never seen in her queue`, and the game sat on the picker
until the summoner closed it. The same thing happened with the event planner (`phone_PlanEvent`, the
`MSG_SITUATION_PREPARE` screen): it opened on the summoner's screen and blocked the game.

**Cause.** The probe decides whose a window is (`_decide_window` in `e2_control.py`) from her pushed acts: a frame of
one of them on the call stack, or the window's resolver interaction being one of them. Her act is recorded in
`self.pushed` only after `push_super_affordance` returns (`_watch_act`), but a picker interaction shows its window
during that call. Nothing is recorded yet, so the window falls through to "user". The event planner's screen is
withheld only when her act's frame is on the stack (`_withhold_screen`), which it was not.

**Fix (probe).** A window or screen is hers when it is about her Sim and comes from her act, including while the act
is being pushed:

1. Before the push call, the probe marks "pushing for her" (act id, her Sim id, affordance), and clears it after.
   A window or screen that arrives while the mark is set, and whose owner or resolver Sim is her Sim, is hers for that
   act. The mark is cleared in a `finally`.
2. A window whose resolver interaction is not in `self.pushed` but whose interaction was pushed by the probe's own
   context (the `InteractionContext` the probe created, or a continuation that carries it) is hers too. The worker
   checks in the game's code which link survives (context identity, `source`, the continuation's `_parent`) and uses
   the one that does; it says which in the commit.
3. `MSG_SITUATION_PREPARE` and the other screens in `SCREEN_MESSAGE_NAMES` use the same rule, not only the stack frame.

Identity windows stay the summoner's, as now. A window that is not hers by these rules is still the summoner's.

**Verify.** Unit tests with fakes for each route (window during the push, window from a continuation, screen during
the push, identity window during the push stays the summoner's). Live: Cook at the fridge shows the recipe picker in
her view as "The game asks", not on the summoner's screen.

## F2. A full screen she cannot use is offered as a normal act

**Evidence.** "Plan a Social Event" (event planner), "Change Sim" (Create a Sim), "Plan Outfit" and "Try On Outfits"
are offered as plain acts. After F1, such a screen is withheld and the act ends `SCREEN_WITHHELD`, but she learns that
only after she tries.

**Fix (helper).** The helper already marks an act with `opens: "a screen only the User's hands can use"` once the
notebook has seen it end on one (`withheld` in `acts.py`). The helper starts that list from a short, fixed seed of
interaction names known to open such a screen (the event planner, Create a Sim, outfit planning), so it is marked the
first time. The act stays listed and marked: she may still try it, and she knows what it does.

**Later, not in this wave.** The summoner told her she will be able to pick guests. Planning an event herself (event
type, guests, time) needs its own design: the probe would start the situation with her chosen guests rather than
drive the planner screen. See F9 for the cheaper route to company.

## F3. Refs move between the view she read and her act

**Evidence.** She chose the ref she read for the toilet and got "Freshen Up" at the mirror. She cancelled a queued
item by its ref and hit a different one. Refs are positions (`a1`, `a2` ... in list order). The probe rebuilds its menu
every 20 s, nearest first, and a new view can arrive between her reading one and acting on it.

**Fix (helper + world).**

1. **Stable refs (helper).** A ref names one act on one object for the life of the helper session: the first time
   `(object id, act guid)` is listed it gets the next free ref, and it keeps that ref in every later view. A ref is
   never reused for something else in that session. The queue and the question rows get stable refs the same way
   (keyed by interaction id, dialog id and row id).
2. **Check before the act (world).** `game_act` takes an optional `expect`: the words of the act as she read them. If
   the ref in the newest view names something else, the act is refused with what the ref is now. The receipt always
   names the act and its object (it does now).

**Verify.** Helper unit tests: a ref keeps its meaning across views where objects reorder, appear and vanish. World
tests: `expect` mismatch is refused with the current label.

## F4. Most of the house is out of her reach

**Evidence.** Upstairs, the fridge was listed but the mailbox and the front door were not, so "check the mail" was
impossible. The probe's menu takes the 30 nearest objects (`CANDIDATE_OBJECTS`), and the helper then drops the farthest
objects until the view fits 7,800 bytes (`OPTIONS_LIMIT`). Lights alone filled eight acts ("All Lights" four times).

**Cause.** The view is built for nearness, not for the lot. She does not need to walk: in the game, asking for an act on
any object makes her Sim walk there. She only needs the object to be in her list.

**Fix (probe + helper + world).**

1. **Probe.** The menu covers every object on the active lot that has acts for her, not the 30 nearest. Each object
   keeps its room. The rebuild budget stays bounded: the worker measures the rebuild time on a full lot in a unit
   fake and keeps it under the current per-rebuild budget, scanning across ticks if it must.
2. **Helper.** Identical act texts on one object are listed once. The view lists near objects in full and the rest
   grouped by room. The byte limit grows to fit a lot, and anything still cut is named by count and room, never
   silently dropped.
3. **World.** The rendered view gives the near objects first, then "Elsewhere on the lot", grouped by room.
   `VIEW_TEXT_MAX` grows to match.

**Verify.** A fixture lot of 150 objects: every object with acts is listed once, grouped by room, with stable refs.

## F5. She cannot tell a detached game from a failed act

**Evidence.** When the summoner saved and quit, her acts came back `NOT_ATTACHED`, and earlier an act came back
`LEFT_QUEUE` (really F1). She spent most of an hour building wrong explanations ("a hidden dialog holds her queue").
Her own words: "Show attached or detached in the view and I won't invent explanations for it."

**Fix (world).**

1. Every rendered view starts with whether the game is attached, and the game time when the helper sends it.
2. `game_act` refuses at once with `not_attached` when no helper session is attached, instead of queuing a request
   that expires. The receipt says when the game was last attached.
3. When the helper's session ends, the game thread gets one event saying the game is no longer attached.

## F6. The view reads like a log, so she talks like one

**Evidence.** Percepts are rendered raw: `need: band distress, bucket distress, subject social, value 5`,
`presence: ... doing <class 'sims4.tuning.instances.sim-stand'>`, `moodlet: bucket Mood_Flirty, from Mood_Sad`. She
repeated them to the summoner as status reports ("social still 5, mood back to Sad"), which reads like a bot.

**Fix (world).** `renderView` says each percept kind in plain words:

- Needs by their band, in words, never a number: "Social: very low", "Hunger: low".
- Mood: "She feels flirty now (she felt sad before)."
- Interactions by a readable name: tuning class strings are reduced to the tuning name and humanised
  (`sim-stand` becomes "standing").
- People: "Vivian Lewis arrived, 49 m away, standing", "Nancy Landgraab left".
- Kinds the renderer does not know stay as they are, so nothing is lost.

The words are a fixed mapping of the game's own facts, not an interpretation.

## F11. Her body's state never reaches her (the biggest gap)

**Evidence.** The helper sends a `portrait` with every view: her needs with bands, posture, what is running and
queued, the room by name, the game time, clock speed and pause, her mood and moodlets with the game's own words,
company, who is talking to her, open windows and whose they are (`asked`, with `whose` and `held`), the place and its
situations. Natalis checks it on the wire and stores it, but `renderView` never shows it. She read her needs from
screenshots and learned of state only from change percepts, so she polled with pictures and reported numbers.

**Fix (world).** Every rendered view starts with a short "Your body now" block from the portrait: attached or not, the
game time and whether the game is paused, the room, what she is doing and what is queued, her mood with its moodlets'
own words, each need by its band in words, who is with her, and every open window with whose it is ("a window from
your act is open on your summoner's screen" is how she learns of F1-type failures). The percept lines after it stay,
rendered as in F6. Old Ashley's renderer (Ashley repo `apps/agent-service/src/core/domus/` and
`core/cognitive-v021/thought/input.ts`, read only, frozen) shows which portrait fields mattered; the new block is plain
words, with no advice.

## F7. Two of her threads answer the summoner at once

**Evidence.** Her game thread, her DM thread and a wake thread ran in parallel and each answered the summoner, so they
got pairs of messages saying the same thing ("on it" twice; two answers to "would you like to add anything"). The now
board lists other threads' recent speech, but only what was said before the turn began.

**Fix (runtime).** When another thread spoke in a place after this turn began, `say` to that place does not send. It
returns what the other thread said and when, and she sends with `knowingly: true` if she still wants to. This is a
fact she did not have, not a rule about what to say: she decides.

## F8. A picture of an old moment

**Evidence.** Her first snapshot of the evening showed an earlier game time with a different Sim selected; the next
one was current.

**Fix (helper).** The worker finds how a snapshot is taken and picked up, and makes the helper take only a file made
after the request (by time and by name). A snapshot that cannot be confirmed fresh is not sent; the receipt says why.

## F9. No way to call or invite anyone

**Evidence.** Her phone offered Browse Web, Play Game, Pay Bills, Plan a Social Event and Call Sadness Hotline, but no
"Call to Chat" or "Invite Over", so lonely and alone she had no move.

**Fix (probe, investigate first).** The worker finds why the phone's social interactions are missing from her menu
(they may be filtered as picker acts, or live in a sub-menu the menu walk skips) and reports. If they are pickers of
Sims, F1 makes their picker hers to answer, and they can be listed.

## F10. Small

- `Assign {2.String} Bed to`: an unresolved string token reaches her. The helper fills tokens it can resolve and
  otherwise drops the token, never shows braces.

## Order and owners

1. Domus worker (probe + helper): F1, F2, F3 (helper part), F4 (probe + helper), F8, F9 (investigate, then fix if
   small), F10. Probe version 2.34.0, schema bump only if the wire changes.
2. Natalis worker (world + runtime): F11, F3 (`expect`), F4 (render), F5, F6, F7.
3. Opus reviews, merges, builds and installs the probe, deploys the helper and Natalis, and asks for one live session
   to check F1 to F9 together.
