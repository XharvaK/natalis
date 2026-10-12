# W12: what keeps her from playing (broad audit, 2026-10-12)

Six read-only investigations, each from a different angle, after the second live session: windows, the life of an
act, perception, a whole day, the pipes between the layers, and people. Evidence: probe 2.37.1 telemetry (six
sessions), the helper's spool and decision logs, her notebook and river, code at Domus 113f0c8 and Natalis c41833f,
and simulations that ran the real helper and probe functions on recorded rows. W11 items are not repeated.

Verdict: single acts work (bed, mirror, phone bills ran end to end). A day fails at the hand-offs. A window freezes
the clock and swallows her acts. The menu lags her body by minutes. The host words its own refusals as the game's.
Nothing wakes her for a need. Visitors are never on her menu long enough to greet.

Confidence: **C** confirmed by telemetry, simulation or exact code; **L** likely from code; **?** needs a live check.

## A. Windows and the clock (day stoppers)

| # | Failure | Mechanism | Conf |
|---|---|---|---|
| A1 | An act pushed while a window is open vanishes and reads "never in her queue"; the window holds the clock | The game keeps a pushed act out of the queue while a picker is open; `_reconcile_pushed` counts 5 misses and pops the record, so the real finish is dropped. 5 of 5 physical acts with a window open went unknown; 2 of 2 without finished | C |
| A2 | Numbered-button pop-ups (moments, job choices) can never be answered | An unknown response is named by its number, the helper sends guid64 "0", and `cmd_answer` reads digits as a row id: NO_ROW | C |
| A3 | A purchase picker answered by a bare row goes in the wrong shape | The single-row branch sends plain rows; counts are built only in the claim path | L ? |
| A4 | A window handed to the User still reads "open for you" | Release and not-answerable paths never rewrite `cause`; the helper and Natalis believe it is hers | C (code) |
| A5 | A window can be lost: `held` is popped before the respond call, and a failed send is logged only as FAILED; "ANSWERED" is written without checking that the window closed | `cmd_answer`, `_release_held`. Her notes saw a picker re-raise after each answer | L |
| A6 | Her answer can lift the User's own pause | The fallback restores the prior speed when no UI_MODAL request is hers | L |
| A7 | Choices past the 12th are dropped silently | Helper `DIALOG_ROWS_SHOWN = 12`; the probe keeps 40 | C |
| A8 | Her answers pass the new-act gates: acted_meanwhile and one act per turn | An answer is a `game_act` | C |
| A9 | The 180 s hold counts real time from the hold, and her answers took 25 to 55 s; a slow turn hands the window to the User | `PICKER_HOLD_S` | C |
| A10 | Only a few window kinds are recorded when released (TIMEOUT, IDENTITY_USER, NOT_ANSWERABLE); ARM, STOP, FAILED and pass-throughs are silent | `windows.py` accepts few codes | C |
| A11 | 2.38.0's 120 s rule may take a window the User opened by hand on her Sim | It depends on which source a hand click carries | ? |

## B. Knowing what her act did

| # | Failure | Mechanism | Conf |
|---|---|---|---|
| B1 | The question an act opens is never matched to it, so cook and phone acts end "unknown" | Helper `_asked` skips dialog ids it has seen before (8 kept, persisted), and the game reuses ids across sessions | L |
| B2 | Refs renumber under her (she meant the toilet and got the mirror) | `RefBook` resets on each attach flip, but the view's attachment stays the same, so Natalis's stale-ref guard never fires | L |
| B3 | Host refusals are worded as the game's, the probe's cmdbox refusals never reach her, and the game's own refusal sentence is dropped | `acts.ts` "the game refused it"; the helper never reads `cmd/outbox`; `reason` comes only from `reason_key` | C |
| B4 | A failed acts sync is silent and retries for ever; a later good sync trims old events | `_round_trip` returns None and logs nothing; `_events` is not cleared | L |
| B5 | A helper restart makes in-flight acts final unknowns, and their later finish is discarded | SESSION_ENDED is final; `syncActs` drops other attachments | C (code) |
| B6 | A withheld screen makes the act terminal before it is pushed | `_withheld` writes UNKNOWN before PUSHED | C |
| B7 | A plan step is aged from the request, so a long first act drops the rest | `planned_at_ms` | C (code) |
| B8 | Natalis can expire an act the helper already pulled, so it runs twice | `expireRequested` ignores a pull without a receipt | L |
| B9 | Answer and cancel commands leave no telemetry; 21 drops have no detail | `schema.COMMANDS` lacks both; `_drop_detail` is empty | C |
| B10 | The new LEFT_QUEUE words say "a phone act often runs this way", which is wrong for cooking (A1) | N2 wording | C |
| B11 | A refused or expired request still holds her other thread for 60 s | `actRequestedMeanwhile` ignores state | C |

## C. What she sees

| # | Failure | Mechanism | Conf |
|---|---|---|---|
| C1 | The menu lags her body by minutes: after a move, the room she stands in reads "nearby, 22 m"; a visitor is offered only if they are there at both the start and the end of a whole-lot build; a look does not refresh | Only the first build writes a near part; later builds write at the end (about 4 min at 8 ms a tick); room and distance are taken at build start | C |
| C2 | Outdoors, the whole street is "near" | The helper's `_in_her_room` has no guard for room 0 (the probe's has one) | C |
| C3 | (2.38.0 P3) One occupied far object hides all its identical kin for 120 s | The definition key shares a refusal | C (sim) |
| C4 | A refused act has no "why", so a broken, dirty or occupied toilet just looks missing | Refusal reasons are kept only for the phone; nothing reads them | C |
| C5 | The fridge offers only Cook; the snack route is a pie-menu act the probe excludes | `act_excluded` returns `pie_picker` (a 2.19.1 live loss) | C |
| C6 | Wall objects (mirrors, wall lights) read "no way"; an identical mirror reads ok at 0.9 m and no way at 4 m | The connectivity check, as for doors | C ? |
| C7 | "Choices: the same as in the last view" hides a move | The choice signature lacks room and near | L |
| C8 | The 256-object cap silently drops whole rooms (7 and 9 were never in any menu) | `act_menu` slice | L |
| C9 | Rooms have no names; outside is not called outside | Labels come only from her notebook | C |
| C10 | Off-lot objects (a neighbour's plants) appear unflagged | The payload has no `on_lot` | C |
| C11 | "Go here" spots have never appeared (0 in 117 menus), so she cannot walk to a room or the front door | One of six silent exits in `_spot_offers` | C ? |
| C12 | The 8-act and 16-candidate caps per object are spent on duplicate words, and acts cut per object are not counted | Guid cap before text fold | C |

## D. Her day and attention

| # | Failure | Mechanism | Conf |
|---|---|---|---|
| D1 | A need in distress never wakes her outside every_change; the owed look is in wall minutes while the game runs about 25 game minutes per wall minute | `wakesFor` has no need; the helper's `urgency` is never read | C |
| D2 | Waiting on an errand, she spent her turns on looks: 14 in 10 minutes, about 37 KB each, while bladder and social went red | A look always resends the whole view | C |
| D3 | Work and school cannot be reached (no go-to-work act; travel is out) | Parked travel (D5) | C |
| D4 | Social cannot be met alone: plain phone Call and Invite are absent, and the pickers are refused | Phone social gate unknown | C ? |
| D5 | Food runs out with no grocery act, and the doorstep meal needs the door | No grocery act offered | C |

## E. People

| # | Failure | Mechanism | Conf |
|---|---|---|---|
| E1 | A waiting visitor's Invite In is never offered (follows from C1) | | L ? |
| E2 | Relationship and role (known, labels, the friendship track, neighbour, courier) are built and then dropped | Natalis `companyLines` renders none of it | C |
| E3 | Other Sims become "someone" in dialog and notice text | `Words.fill` blanks tokens past index 0 on that path | C (sim) |
| E4 | Her pronouns are always the first form | The probe never reports gender | C |
| E5 | Three-word names give the wrong last name ("III") | `split()[-1]` | C |
| E6 | An incoming call may go to the User (source rule on the caller), and its caller reads "someone" | Untested ring shape | ? |
| E7 | A finished social act tells her nothing (the relationship change goes only to the diary) | | L |
| E8 | Money tokens are dropped ("brought home today") | `_fill` formats only `.Number` | C |
| E9 | The sight rule for Sims off her lot is inconsistent: 4 m outdoors, room id indoors | | C |

## F. Pipes

| # | Failure | Conf |
|---|---|---|
| F1 | One tick runs every hop in sequence with 10 s timeouts (about 43 s with Natalis slow); a view can show an act's effect before its finish is synced | L |
| F2 | Catch-up after a restart reads every unread row in one tick (16 to 45 s per hour of backlog), with one commit per row | C (sim) |
| F3 | A Natalis outage over 10 minutes expires every queued view; the first view after a start can come from a stale row ("expired" wake) | C |
| F4 | A refused view drops its percepts, an asked look included, with no retry (six refused on 10-11) | C |
| F5 | Version skew only warns: pace, talk and camera go silently UNKNOWN_COMMAND on an older probe | L |
| F6 | No failed round trip is logged anywhere, and command folders grow without bound | C |

## W12 build plan (three bundled workers, then one install and one deploy)

Principle: the host reports, she decides. Every fix below makes a fact true or visible. None chooses for her.

**W12-P (probe 2.39.0)**
- A1: a pushed act that misses the queue while any window is open stays WAITING_WINDOW (not LEFT_QUEUE) until the
  window closes, then counts misses again. Its finish is kept. A window on the User's screen that holds the clock is
  recorded with its title.
- A2: answer numbered responses by response id (`resp:N`), never as rows.
- A3: a row pick on a counted window goes through the claim path.
- A4: rewrite `cause` when a window is released or shown.
- A5: pop `held` only after the respond succeeds; ANSWERED only when the window has closed, else ANSWER_SENT_OPEN.
- A6: restore speed only for a pause her answer released.
- A10: a speed event for every release and pass-through.
- C1: a near part (her room, phone, Sims on her lot) on every build, on each room change and on a look request;
  room and distance read at write time.
- C3: share only pass outcomes by definition.
- C6: a wall-placed object's False reach reads None.
- C8: cap 512 objects and record dropped counts and rooms.
- C10: carry `on_lot`.
- C11: stage counters for spots.
- C12: per-object fold by text before the cap; count acts cut.
- E4, E5: gender and the first and last name fields.
- B9: answer and cancel in `COMMANDS`; drop detail always.

**W12-H (helper)**
- A7: all rows, with "N of M".
- B1: asked conversion keyed per telemetry session and first-seen tick.
- B2: no RefBook reset on a flip; the refs epoch goes in the view.
- B3: read cmdbox replies and map each code to plain words with who refused; carry the game's `detail`.
- B4: log and count failed syncs, quarantine refused events, never trim unsent ones.
- C2: room 0 is outside, never near by room.
- C4: per-object refusal reason keys for near objects.
- C9: say "outside".
- E3: names on the dialog and notice paths.
- E8: money tokens.
- F1–F6: hop order (acts before views, a view waits for a failed sync), rows-per-tick cap and batched commits, keep
  the newest state on expiry, re-enqueue percepts on refusal, gate each command on probe version, one log line per
  failed round trip.

**W12-N (Natalis)**
- A8: answers exempt from acted_meanwhile, one answer per held window per turn.
- A9: the hold's time left shown in the portrait.
- B3: wording by who refused.
- B5: SESSION_ENDED is a replaceable guess.
- B6: a pre-push UNKNOWN is replaceable.
- B7: a step aged from the previous end.
- B8: a pull counts as a receipt.
- B10: LEFT_QUEUE and WAITING_WINDOW words by fact, not family.
- B11: the hold counts only live requests.
- C7: room and near in the signature.
- D1: a need entering distress wakes her in every mode, and the owed look counts game time.
- D2: a look that changed nothing answers in one line.
- E2: relationship and role in "With you".
- E7: one result line for a social act.

**Live checks owed (2.39.0 session):**
- A11: a hand click during her errand.
- C5: the snack route (test one pie act push behind a flag first).
- C11: which spot stage fails.
- D4: phone Call and Invite with a known Sim on her lot.
- E1: Invite In for a waiting visitor.
- E6: an incoming call.
- A1: whether a held act re-enters the queue once the window closes.

**Scope decisions for the User:** travel to work or school (D3), groceries and the doorstep (D5), and free words
to Sims in game (people 11) stay parked unless the User says otherwise.
