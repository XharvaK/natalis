# W10: fixes from the 2026-10-12 live session

Evidence: the first session on probe 2.36.0 and Natalis 9d30588 (game telemetry, the helper's decision log, her river).
Counts and causes only here; no game text.

## What went wrong

1. **A work event's pop-up went to the summoner's screen.** The probe's window owner rule (`e2_control._decide_window`)
   calls a window the summoner's whenever the first interaction of its resolver is not autonomy. Her shift is the
   game's own SCRIPT interaction, so the career event's two-choice window was shown to the summoner, not held for her.
2. **No objects for four minutes.** Since 2.34.0 the menu covers the whole lot. The first build tested 5,814 acts at
   8 ms a tick (about 240 ticks, about four minutes of wall time) and the menu is written only when a build finishes.
   Every rebuild (every 20 s) tests them all again. Her views had only her queue until she had already left for work.
3. **Blind from the first whole-lot menu on.** Fixed already (Domus 516a945): a cut named its rooms by their full
   labels; a label over 64 characters failed the observation contract, so every view after it was refused locally.
   The decision log said only "ContractError", which hid the cause.
4. **No call or invite on her phone.** `_menu_phone_offers` stops at `act_menu.CANDIDATE_ACTS` (16) phone acts;
   5 kept and 11 refused were exactly 16, so later phone acts (call, invite) were never tested or named.
5. **The summoner speaks to her in Discord, and her game tools refuse there.** `game_act`, `game_look`, `game_memory`,
   `game_snapshot` and `game_attention` refuse `not_a_game_thread` outside `domus:...`. Each thread is her; the game is
   one world. The rule is a cage.
6. **Raw words in her view.** Game text keeps its tokens (`{0.SimFirstName}`, `{1.Number}`) in job and aspiration
   lines; situations show as tuning names (`Role_PivotalMoment` three times).
7. **A held say blamed the place.** When her other thread spoke there first, the hold says "discord:dm:alex said this
   there 40 s ago": it was her own other thread.

## P: probe 2.37.0 (Domus sims-e1, schema stays 18 unless a key is added; then 19 on both sides)

- **P1 window owner.** In `_decide_window`, after her own act checks: when the resolver has interactions, the first one
  decides. Its source `PIE_MENU` or `SCRIPT_WITH_USER_INTENT` (a hand at the controls) makes the window the summoner's.
  Any other source (AUTONOMY, SCRIPT, REACTION, SOCIAL_ADJUSTMENT, POSTURE_GRAPH, GET_COMFORTABLE, the cancel AOPs)
  on her Sim makes it hers (act None). An interaction of another Sim keeps today's answer (the summoner's). Identity
  windows stay the summoner's. Tests with fakes for each source.
- **P2 menu speed.**
  - A result cache for candidates not in her room, not her phone and not a Sim: key (object_id, guid64), value the
    test's outcome (ok, refused, reason_key, reach), kept `FAR_CACHE_S = 120` s, cleared on a zone change. A cached
    candidate is not tested again within that time; her room, her phone and people are tested in every build.
  - The first build in a zone writes the menu twice: once when the near part (her phone, her room, people) is done,
    and again when the build finishes. Later builds write once, when they finish (as now).
  - Telemetry: the menu row's `tested` counts real tests only; a `cached` count is added (schema 19, both copies of
    schema.py, the helper's vendored one too).
- **P3 her phone.** Phone candidates are not capped at `CANDIDATE_ACTS`; they have their own cap `PHONE_CANDIDATES = 96`
  (and `PHONE_SCAN_LIMIT` stays the scan bound). `MENU_MAX_REFUSED_PHONE` goes to 64. Each phone act the guard
  excludes before testing is named too: `excluded_phone: [{name, why}]` (why: pie_picker, deny_name, travel,
  not_user_directed, hidden), at most 64 (schema 19). This is the D4 evidence.

## H: helper (Domus helper)

- **H1 the reason a view is refused.** The decision log line of a refused view carries the contract's message
  (`ContractError: invalid_body` plus the key it failed on: ContractError gains a `where` text set at each raise).
- **H2 never blind.** A view the contract refuses because of `options` or `options_cut` is sent again at once without
  options and without a cut, with a percept `{kind: "options_dropped", facts: {why}}` so she knows her choices are
  missing and why. Any other refusal is logged as now.
- **H3 tokens.** One formatter for game text that came with tokens, applied where text keys are resolved for her view
  (portrait lines, percepts, dialogs, notices, options): `{N.SimFirstName}`, `{N.SimLastName}`, `{N.SimName}`,
  `{N.SimFullName}` become her names when the text is about her (career, aspiration, her own windows), else the
  window's Sim when the probe names one, else "someone". `{Mn.x}{Fn.y}` pairs take her gender's form when the probe
  reports it, else the first form. `{n.Number}` becomes the number when the row carries it, else "some". Any other
  `{...}` token is dropped. Never raises; tests with invented strings.
- **H4 situations in words.** Situation tuning names reach Natalis as they are; Natalis words them (N3).
- Probe schema 19 accepted (vendored schema.py copied from the probe, byte for byte).

## N: Natalis

- **N1 one mind, every thread.** `game_act`, `game_look`, `game_memory`, `game_snapshot` and `game_attention` work from
  any thread while the game is attached. The game's thread is the attached session's thread (the newest
  observation's thread for that helper session). `game_act` reads the newest view of the game's thread. Its notes
  (accepted, done, refused, expired) go to the thread that asked. `game_look` from another thread: the fresh view goes
  to the game's thread as now, and the same view is delivered to the asking thread too (wake true) so the turn that
  asked can act on it. `game_snapshot` and `game_memory` answers go to the asking thread (as now). `game_attention`
  sets the game thread's attention. Tool descriptions drop "in a game thread". Refusal `not_a_game_thread` is gone;
  `no_view` stays when no view of the game has come.
- **N2 her own other thread.** The say hold names it: "You said this there 40 s ago from your <thread> thread, while
  this turn was running." when the earlier speaker was her (another thread), and today's words when it was someone else.
- **N3 situations in words.** Situation names are worded with `plainName` and repeats counted: "Situations: pivotal
  moment (×3)."
- **N4 token tail.** Any `{...}` left in game text Natalis renders is dropped (the helper's H3 is the real fix; this is a
  second line).

## Verification

- Probe: unit tests for P1 (each source), P2 (cache hits, near-part write, cache cleared on zone change), P3 (phone
  past 16, excluded names); `tools/check_guards.py`; build and verify scripts by Opus.
- Helper: H1 to H3 unit tests; the full suite.
- Natalis: N1 to N4 tests; typecheck; the full suite.
- Live: a career window is held for her; her first view at home lists objects within a minute; the phone lists call
  and invite (or names why not); she acts from Discord.
