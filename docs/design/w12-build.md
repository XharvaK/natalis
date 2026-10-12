# W12 build: contracts and briefs

Companion to `w12-catalogue.md` (the failure modes, by letter and number). The User also brought into scope
(2026-10-12): **groceries and the doorstep** (G) and **her own words to Sims** (S). Four workers: two on the probe
(windows, menu), one on the helper, one on Natalis. This file is the contract between them: each worker builds to
it and tests against it with fakes, and nobody waits for another.

Principle: the host reports, she decides. Every change makes a fact true or visible. Nothing chooses for her,
ranks for her, or hides a choice from her for her own good.

## Contract (probe 2.39.0, telemetry schema 20)

Every new key is optional: absent or None on older rows, so a newer helper reads an older probe.

**Act events**
- `ACT_PHASES` gains `WAITING` and `NOTED`. Neither is terminal.
  - `WAITING` with code `WINDOW_OPEN`: a pushed act that is missing from her queue while any window is open. `detail`
    names the window ("dialog <id>"). Written once per wait.
  - `NOTED` with code `SCREEN_WITHHELD`: the act opened a screen she cannot use, which was cancelled. It replaces
    today's UNKNOWN written before PUSHED.
- A FINISHED answer has code `ANSWERED` only when the window has closed. When the response was sent but the window
  is still open on the next presence sample, the code is `ANSWER_SENT_OPEN`.

**Dialogs**
- A custom response with no ButtonType name is named `response_<N>`, never a bare number. `cmd_answer` accepts
  `pick = "response_<N>"` and responds with id N.
- A held window carries `hold_left_s`, the integer seconds until the fallback hands it to the User.
- When a window is released, shown or passed through, its `cause` becomes `user`. Each such event writes a speed
  event (phase `DIALOG_SHOWN`) with a code: `TIMEOUT`, `IDENTITY_USER`, `NOT_ANSWERABLE:<class>`, `ARM`, `STOP`,
  `FAILED:<name>`, `PASS_THROUGH`.

**People**
- The body carries `gender` ("F", "M" or None). Each presence item and the body carry `first_name` and `last_name`,
  read from the game's own name fields (strings, at most 64 characters, or None).

**Act menu (`act_menu` record)**
- Each object entry gains:
  - `on_lot` (bool or None);
  - `acts_cut`: passing acts not listed because of the per-object cap, after folding identical texts;
  - `refusals`: for objects near her only, at most 8 `{"text_key", "reason_key"}` of the acts the game refused.
- Each act entry may carry `variant`, a small int (see G1). A variant is a choice inside a pie-menu act: one entry
  per choice, and its `text_key` is that choice's own name.
- Part 0 gains:
  - `dropped`: `{"objects": int, "rooms": [room ids]}`, what the object cap left out;
  - `spot_stages`: a dict of counters such as `{"anchors": 3, "placement": true, "terrain": true, "offers": 0}`.
- The `MENU_MAX_OBJECTS` cap goes to 512.
- A near part (her room, her phone, the Sims on her lot, and the objects within NEAR) is written on every build, on
  each change of her room, and on a `menu_near` command. Its distances are read when it is written.

**Commands**
- `schema.COMMANDS` gains `answer`, `cancel` and `menu_near`. `menu_near` takes no arguments and is idempotent.
- The `act` command may carry `variant` (int).

## Contract (helper ↔ Natalis)

- Act sync events gain the phases `waiting` and `noted`, both non-terminal. Their `detail` carries `code`, and
  `window` when there is one.
- Refusals carry `detail.by`, one of `game`, `probe`, `helper`, `host`, and `detail.text` (the game's own sentence
  when there is one, cleaned and cut to 240 characters).
- An option whose act has a variant uses the guid64 string `"<guid64>v<variant>"`. Natalis treats it as opaque and
  accepts the pattern `^[0-9]{1,20}(v[0-9]{1,3})?$`. The helper splits it back when it publishes the act.
- A requested act may carry `words` (a string of 1 to 240 characters): her own words to the Sim the act targets.
- A dialog in the view may carry `hold_left_s`.
- A company entry may carry `relationship` (`known`, `labels`, `track`) and `role` (plain words). The helper
  already builds these, and Natalis renders them.

## G: groceries and the doorstep

- **G1 (probe, menu worker): pie-menu acts.** Today `act_excluded` drops every pie-menu act because a pushed pie act
  vanished live (2.19.1). The game builds a pie act's choices with `affordance.potential_interactions(target,
  context)`. Each choice it yields becomes its own act entry with a `variant` and its own name. At push time, the
  probe enumerates again and picks the choice whose name key matches; if none matches, it refuses with
  `VARIANT_GONE`. Read defensively, never raising. Tests use fakes: a fridge whose snack act yields three choices.
- **G2 (probe, menu worker): find the food routes.** Read the helper's atlas (`E:\Domus\atlas.db`, read-only; copy it
  to a scratch folder first) and the telemetry for every act on her lot that buys food or ingredients, or picks up a
  delivery: grocery orders from the phone, fridge or computer, and taking or eating a meal left on the lot. Report
  which exist, how each is offered, and what blocks each today. If a route is blocked only by our own filter (a pie
  menu, a deny part, the cap), G1 or C12 opens it. Do not add any rule that picks food for her.
- **G3 (helper): what lies outside.** An object on her lot outside the house (`on_lot` True, room 0) is listed as
  "outside, on your lot", so a meal left at the step is visible as a thing with acts.

## S: her own words to Sims

- **S1 (Natalis):** `game_act` takes optional `words` when the chosen act targets a Sim (the option is a person). It
  is stored with the act (a new nullable column, added by migration), passed to the helper in the act list, and her
  act line shows it ("you said: …"). It is refused with a reason when the option is not a person.
- **S2 (helper):** when an act with `words` is PUSHED, the helper publishes one `talk` line in her name: her first
  name, a colon, and her words in quotes. The game shows it on the User's screen, as talk does today. The words also
  go into the outcome record and the day record, so she can remember what she said.
- The game's own social act still decides what happens between the Sims. Her words are hers, shown and remembered;
  they do not change the game's outcome, and nothing claims they do.

## Briefs

**W12-PW (probe, windows):** A1 (WAITING; the record is kept until the window closes, and its finish is kept); A2;
A3; A4; A5 (pop `held` only after a successful send, ANSWER_SENT_OPEN); A6; A10; B6 (NOTED); B9 (COMMANDS, drop
detail always); E4 and E5 (gender, first and last names); `hold_left_s`. Files: `e2_control.py`, `observers.py`,
`cmdbox.py`, `schema.py` (its own keys), `writer.py`, `situation.py`/`snapshot.py` for the people fields.

**W12-PM (probe, menu):** C1 (near part on every build, on room change and on `menu_near`); C3 (share only a passing
outcome by definition; a refusal is per object); C6 (a wall-placed object's False reach reads None; find the
placement flag defensively); C8 (cap 512, `dropped`); C10 (`on_lot`); C11 (`spot_stages`); C12 (fold texts before
the 8-act and 16-candidate caps, `acts_cut`); C4 (probe side: `refusals` for near objects); G1; G2 (report). Files:
`act_menu.py`, `probe.py` (menu functions only), `e2_actuator.py`, `schema.py` (its own keys).

Both probe workers: do not bump the version, and do not touch `helper/domus_helper/vendor/schema.py` (the lead
merges, bumps to 2.39.0 / schema 20 and copies the vendor file). Keep `schema.py` edits to your own keys, so the two
branches merge cleanly.

**W12-H (helper):**
- A7 (all rows, "N of M");
- A10 (`windows.py` accepts every code);
- B1 (asked conversion keyed per telemetry session and first-seen time);
- B2 (no RefBook reset on an attach flip; the refs epoch goes in the view, and the attachment changes when refs
  reset);
- B3 (read `cmd/outbox` replies for her act, answer and cancel commands, and turn a refusal into a REJECTED event
  with `by: probe`; the helper's own refusals carry `by: helper`; the game's sentence goes to `detail.text`);
- B4 (log each failed sync, quarantine an event Natalis refuses, never trim unsent events);
- C2, C4 (render refusals for near objects as "refused: <reason in the game's words>"), C9 ("outside");
- E3 (names on the dialog and notice paths);
- E8 (money tokens);
- F1–F6:
  - acts before views, and a view waits while a sync fails;
  - at most 500 rows per tick, one commit per batch;
  - on expiry keep the newest state, never the whole window;
  - re-enqueue percepts on a refused view;
  - gate every command on the probe version;
  - one log line per failed round trip;
  - prune `cmd/done` older than 7 days, keeping the replay ids the probe still checks. Delete only through a
    reviewed function that names each file; no globs, no shell.
- Read the new probe keys: WAITING/NOTED → `waiting`/`noted`; `hold_left_s`; names and gender into `tokens.Words`;
  `on_lot` (off-lot objects say so); `dropped` and `acts_cut` in the cut line; `spot_stages` to `bridge.log`; the
  variant guid64 form.
- Send `menu_near` on a look (probe ≥ 2.39.0).
- S2 and G3.

**W12-N (Natalis):**
- A8 (an answer to an open held window is exempt from acted_meanwhile; one answer per held window per turn);
- A9 (time left on a held window in her portrait);
- B3 (wording by `by`, with the game's own text);
- B5 and B6 (SESSION_ENDED and a pre-push unknown can be replaced by a later event);
- B7 (a step aged from the previous step's end);
- B8 (a pull recorded by the helper counts as a receipt);
- B10 (LEFT_QUEUE, WAITING and NOTED worded by fact);
- B11 (the meanwhile hold counts only requests that are still live);
- C7 (room and near in the choices signature);
- D1 (a need entering distress wakes her in every attention mode: the body's alarm, as a held window is; she may
  still do nothing);
- D2 (a look that changed nothing answers in one line, with the clock);
- E2 (relationship and role in "With you");
- E7 (a finished social act's result line);
- the `waiting` and `noted` phases and the variant guid64;
- S1.
- Schema migration with a test.

## Verification

- Each worker: focused tests red before green; probe `unittest discover` and `tools/check_guards.py`; helper
  `pytest -q tests`; Natalis `npx tsc --noEmit` and the focused vitest files.
- The lead: merge both probe branches and the helper, bump, run the full probe and helper suites, then build,
  verify and install 2.39.0. Then the Natalis full suite on Mint in a scratch clone, and the deploy. Natalis
  deploys first: it accepts the new phases before any helper sends them.
- Live (2.39.0):
  - a delivery from start to finish, every window hers;
  - an act while a window is open reads waiting, then finishes;
  - a numbered pop-up answered;
  - a snack from the fridge;
  - a grocery order;
  - a meal picked up at the step;
  - a greeting with her own words;
  - a visitor invited in;
  - the spot stages read from the log.
