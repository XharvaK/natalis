# W11: why she could not operate the game (2026-10-12, second live session)

Evidence: probe 2.37.1 telemetry, the helper's decision log, her river and her own ranked report. Counts and causes
only; no game text.

## What went wrong

1. **The second window of her own errand went to the summoner.** She ordered a delivery from her phone; its first
   picker was held for her and she answered it. The next window (a purchase picker, the meal) was shown on the
   summoner's screen, unanswered, and held her and the clock. Cause: every act the probe pushes for her carries the
   source `SCRIPT_WITH_USER_INTENT`; the window's resolver interaction is the continuation of her pushed act, not the
   pushed act itself, so `_pushed_for` does not match it, the push is over so `_pushing_window` is false, and the
   W10 P1 source rule calls `SCRIPT_WITH_USER_INTENT` the summoner's. Her grill act during that stall was pushed
   and never ran.
2. **The house did not fit her view.** The probe's whole-lot menu had her fridge, stove, toilets, tubs and beds, all
   reachable, but the helper's options budget (160 objects, 32 KiB) cut about 142 objects. 60 to 120 pool seats and
   36 wall lights (identical objects with identical acts) spent the budget first; the cut count moved as things
   arrived, so it was no signal of completeness.
3. **Every door reads "no way to get there".** All 12 doors had reach False (the front door and both double doors
   included), while a chair 46 m away was True. The connectivity check from her to a door object fails for a portal.
   She read it as "the doorway is closed to her" and, with the courier out of sight, the meal was left on the step.
4. **The courier was not hers to act on.** He was heard, not seen (14 m away, at the front door); the helper names
   only Sims she sees in her menu (SS4-v2), so no act on him existed. With autonomy off she does not answer the door
   by herself.
5. **Her two threads did the same errand at once.** Her DM thread and her game thread each ordered the delivery
   within 6 s (two pickers, two pushes). The say hold catches double words, nothing catches double acts.
6. **"LEFT_QUEUE" misleads.** A phone act runs at once and never waits in her queue; the note "nothing says how it
   ended (LEFT_QUEUE)" came back on her bill payment, which finished, and on acts that never ran.
7. **The first whole-lot build took ten minutes** (6,070 tests at 20 ms a tick). The partial writes brought objects
   in within a minute, but the house was whole only near the end.

## P: probe 2.38.0 (Domus sims-e1; schema stays 19 unless a key is added)

- **P1 her errand's windows.** In `_decide_window`, before the source rule: a window whose resolver interaction is
  her pushed act or continues it (same `group_id` as an interaction the probe pushed for her, kept for 10 minutes
  after the push; read defensively, never raising) is hers, held for her, with that act's record. And the source
  rule: `SCRIPT_WITH_USER_INTENT` on her Sim is hers when an act was pushed for her in the last 120 s (the probe's
  own pushes carry that source; the summoner's hands use `PIE_MENU`). `PIE_MENU` stays the summoner's. Tests with
  fakes: continuation by group_id, the 120 s window, a PIE_MENU window during her errand stays the summoner's.
- **P2 doors.** Find why `e2_actuator.reachable` is False for every door (portal objects). Make a door's reach the
  answer for the place she would stand to use it (either side of the portal), using the game's routing API the
  probe already uses (D3 front_door spot is prior art). If no safe way exists, a door's reach is None (unknown),
  never False. Tests with fakes.
- **P3 one test per kind for far objects.** The far cache also keys a far candidate's test outcome by
  (definition_id, guid64): identical far objects share one test per FAR_CACHE_S. Reach stays per object (it is a
  separate call). `cached` counts these too. Tests: 50 identical far objects with 3 acts cost 3 tests.

## H: helper

- **H1 fold identical objects.** In `act_options`, objects whose shown name and act words are the same are one entry:
  the first in the menu's order (nearest) carries the acts and refs; the entry says how many there are
  ("Pool Seat, 60 of them; the nearest is listed") and, when they span rooms, how many rooms. Folded objects are
  not "left out" (the cut counts only what the budget dropped). Tests with invented names.
- **H2 people she hears.** Her menu offers the Sims she hears on her lot as well as those she sees; a heard Sim's
  entry says so in where ("heard, not seen, 14 m"). Sims off her lot stay out. Tests.

## N: Natalis

- **N1 one errand, one hand.** `game_act` from a thread while another thread of hers requested a game act within
  the last 60 s: nothing is requested; the receipt says which act her other thread requested and how long ago
  ("Your <thread> thread asked the game for <label> 6 s ago. Nothing was requested. Ask again with knowingly: true
  if you want this too."). `knowingly: true` requests it anyway. Information, not a rule (as spoken_meanwhile).
- **N2 an act that runs at once.** The UNKNOWN/LEFT_QUEUE note says what is known: "It never waited in her queue: the
  game took it at once or dropped it, and did not say how it ended. A phone act often runs this way; what changed
  in your next view tells." No verdict.

## Verification

Probe: unit tests for P1 to P3, `tools/check_guards.py`. Helper: H1, H2 tests and the full suite. Natalis: N1, N2
tests, typecheck, full suite. Live: a delivery from her phone, start to finish, every window hers; her view lists the
house without a cut (or a small one); doors read a way or unknown; she can greet a courier she hears at the door.
