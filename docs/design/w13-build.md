# W13 build: contracts and briefs

Companion to [w13-reach.md](w13-reach.md) (the design, by stage D4, D5, D9, D8). This file is the contract between
four workers: two on the probe (P1 people and places, P2 home), one on the helper (H), one on Natalis (N). Each
builds to it and tests against it with fakes, and nobody waits for another. P3 (co-play) waits for the discovery
record from one live session.

Principle: the host reports, she decides. Every change makes a fact true or visible, or carries out what she asked.
Nothing chooses for her, ranks for her, or hides a choice from her for her own good.

## Rulings (the User, 2026-10-12)

- **Lists on demand.** People she knows, places she can go, her things and the event types reach her through one
  read tool, `game_list`. The helper sends a list only when it changes, and Natalis keeps the newest. Her view carries
  one count line. A list costs tokens only when she looks.
- **Home edits per turn.** She may make up to 6 home edits (buy, place, move, sell) in one turn, each with its own
  receipt. They are not held by the one-act rule. Save, travel and events count as her one act for the turn, as a game
  act does.
- **Save floor.** 15 real minutes between her saves, besides the game's own save lock.
- **Quiet at work.** While she is at work, a need going into distress does not wake her: the game looks after her
  needs in the rabbit hole. Questions, held windows, calls, texts and looks wake her as always.
- **Placement vocabulary** (the lead's call): on a thing, beside a thing, against a wall of a room, in a room, in
  place of a thing, plus an optional facing (a thing, or the room). No compass sides. The result names the wall in
  words. Wall landmarks can come later if she needs them.
- **Blocked routes are reported, not refused.** A purchase or a move that cuts off a route her Sim could walk before
  stays where she put it. The result says which routes are cut. Her home is her call.
- Earlier rulings stand: travel is her word to keep (she asks the User first, and the host records but never gates),
  never destroy, her funds are the only limit, furniture and decor first.

## Refs

Every ref is a letter and a number, stable for one helper session (the helper's RefBook, one per namespace). A number
is never reused for another key in a session.

| Prefix | Names | Keyed by | Listed in |
|---|---|---|---|
| `a` | a game act (as today) | object and act | the view's options |
| `p` | a person she knows | sim id | `game_list people` |
| `h` | a place she can go | zone id | `game_list places` |
| `t` | a thing of hers: on her lot or in her inventory | object id | `game_list things` |
| `e` | an event type | situation guid | `game_list events` |
| `c` | a catalogue item | definition id | a `game_catalog` answer |

An `a` ref also names its object wherever a thing is wanted ("beside a3" means beside the object a3 belongs to). The
helper checks that no new prefix collides with one it already uses (dialog rows, answers), and the H worker names any
collision in its report.

## Contract (probe 2.40.0, telemetry schema 21)

Every new key is optional on older rows, so a newer helper reads an older probe. Every new probe call is defensive:
it never raises into the game, and an unreadable value is None or absent, never guessed. The workers verify each
game call against `E:\Domus\gameapi` (index and bytecode) before using it, and never commit or quote that code.

### Records

**`discovery`** (P1). Written once per zone load, after the zone is running. Read-only, every read guarded. Its
sections, each optional:
- `pickers`: for each phone act that opens a Sim picker: its guid, tuned minimums, filter class name, `include_*`
  flags, radius, and for each Sim she knows the name of the generator step that drops them (or `ok`). Sim ids only,
  no names.
- `phone_tests`: for each phone affordance, its guid and its TestResult reason text (the game's debug reason, cut to
  200 characters) and tooltip key.
- `off_lot`: for each need commodity, its name and `_off_lot_simulation` (for P3).
- `save`: `slot_ok` (whether the loaded slot id is above 1), `slot_named` (bool), `cooldown_s`, `locked` (bool). Never
  the slot id or its name.
- `situations`: the user-facing situation types: guid, name key, cost, and whether it can be scheduled.
- `career`: her career name, its work days and hours, `can_work_early`, `available_for_work`.
- `population`: the story-progression settings that touch a household with no lot (for P3).

The helper stores each discovery record as one JSON file in its data folder (`discovery/<telemetry session>.json`)
and logs one line. It is evidence for the lead, not part of her view.

**`lists`** (P1 people, places, events; P2 things). One record kind with `kind` in `people`, `places`, `things`,
`events`, written in parts like `act_menu` (`list_rev`, `part`, `parts`, at most 128 items per part). The probe checks
each list at most once every 60 real seconds, and writes it only when its content digest changed, on each zone load,
and on a `lists_now` command.

| Kind | Item keys |
|---|---|
| `people` | `sim_id`, `first_name`, `last_name`, `labels` (relationship bit names, at most 4), `tracks` ({track: value}, at most 4), `household_id`, `has_home` (bool), `on_lot` (bool), `waiting` (bool: a visitor waiting at her door) |
| `places` | `zone_id`, `kind` (`home`, `household`, `venue`), `lot_name` (string, at most 64), `venue` (tuning name), `household_id` (for `household`) |
| `events` | `situation_id`, `name_key`, `cost` (int or None), `schedulable` (bool) |
| `things` | `object_id`, `definition_id`, `name_key`, `where` (`room` with `room_id`, `inventory`, or `outside`), `value` (int), `made_by_her` (bool or None), `states` (at most 4 {state, value}, from the near-object conditions code), `in_use` (bool), `count` (inventory stacks), `placement` (`floor`, `wall`, `surface` or None) |

- People: her relationships from her relationship tracker, at most 200, ordered by the game's own order.
- Places: home, the homes of the households of the people she knows, and venues by type from the venue service, at
  most 120.
- Things: every object on her home lot that her household owns and that buy mode would list (not Sims, walls,
  floors, roofs, terrain or stairs), and her inventory. At most 600. On a lot that is not her home, only her
  inventory.

**`catalog`** (P2). Written only on a `catalog_dump` command, in parts of at most 256 items (`catalog_rev` = the
game's version string, `part`, `parts`). Each item: `definition_id`, `price`, `buy_category` (the game's flag names,
at most 4), `placement` (`floor`, `wall`, `surface` flags), `tags` (at most 8 tag names), `purchasable` (bool: not
hidden, debug or cheat-only). The helper sends `catalog_dump` when its `catalog.db` has no flags for the running game
version.

### Act menu

- An act entry may carry `needs_sim: true`: a phone act that opens a Sim picker. Today these are excluded as
  `pie_picker`; they are listed from 2.40.0 with this key.

### Portrait

- A `self.careers` entry may carry `until_min`: the game minute of the day her current work session ends, while
  `at_work` is true. None when unreadable.
- A company entry may carry `waiting: true` (a visitor waiting at her door, from the visitor's situation job).

### Phone

- An incoming call is held for her by the caller's sim id, not by its resolver. Its title names the caller (E6).
- A text (`PhoneNotificationOp`) writes a `phone` event: `kind` (`text` or `call`), `from_sim_id`, and the guid of the
  phone act it notifies, when readable.

### Commands

`schema.COMMANDS` gains `go`, `save`, `event`, `buy`, `place`, `move`, `sell`, `catalog_dump`, `lists_now`. Every
command that does something carries `act_id`, and its outcome is written as `act_event` rows for that id, as for
`act`.

| Command | Args | Phases and codes |
|---|---|---|
| `act` | gains optional `sim_id` (digits), only for a `needs_sim` act | REJECTED `SIM_NOT_CHOOSABLE` with `detail` naming the generator step, or `SIM_NEEDED` |
| `go` | `act_id`, `zone_id` | ACCEPTED, PUSHED (travel asked of the client), FINISHED `ARRIVED` (her Sim is in that zone after the load); REJECTED `IN_RABBIT_HOLE`, `SAVE_LOCKED`, `CARRYING_BABY`, `SAME_ZONE`, `NO_ZONE`; UNKNOWN `TRAVEL_UNSEEN` if no zone change within 5 real minutes |
| `save` | `act_id` | ACCEPTED, FINISHED `SAVED` when `on_save_complete` reports success; REJECTED `NO_PLAYER_SLOT`, `SAVE_LOCKED` (the lock's tooltip key in `reason_key`), `SAVE_TOO_SOON` (within 15 real minutes of her last save: a backstop for the host's floor), `SAVE_FAILED` |
| `event` | `act_id`, `situation_id`, `guests` (0 to 16 sim ids), `start` (`"now"` or `{day_offset: 0 or 1, hour, minute}`) | FINISHED `CREATED`; REJECTED `NO_FUNDS`, `ZONE_FORBIDS`, `START_PAST`, `CREATE_FAILED`, `NOT_SCHEDULABLE` |
| `buy` | `act_id`, `definition_id`, `place`, optional `max_price` | FINISHED `PLACED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_PURCHASABLE`, `PRICE_ABOVE` (live price above `max_price`), `NO_FUNDS`, `NO_SPOT`, `PLACE_FAILED` (money returned, the new object removed) |
| `place` | `act_id`, `object_id` (an inventory item), `place` | FINISHED `PLACED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_IN_INVENTORY`, `NO_SPOT`, `PLACE_FAILED` |
| `move` | `act_id`, `object_id`, `place` | FINISHED `MOVED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_HERS`, `IN_USE`, `NOT_MOVABLE`, `NO_SPOT`, `MOVE_FAILED` |
| `sell` | `act_id`, `object_id` | FINISHED `SOLD`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_HERS`, `IN_USE`, `NOT_SELLABLE` (a Sim, door, window, wall, stair, or anything that holds a Sim) |
| `catalog_dump` | none | writes the `catalog` record; idempotent |
| `lists_now` | none | writes every list now; idempotent |

**`place`** (the argument): `{"rel": R, ...}` with R one of:
- `on`, with `target_id`: a free surface slot of that object (its runtime slots, found defensively);
- `beside`, with `target_id`: FGL starting beside it, against the same wall when the item is wall-placed;
- `wall`, with `room_id`: FGL against a wall of that room;
- `in`, with `room_id`: FGL from the room's middle;
- `instead`, with `target_id`: that object's spot; refused `NOT_FREE` unless the target was sold or moved first.

Optional `facing`: an object id (digits), or `"room"` (towards the room's middle). The probe finds the spot first
(`create_starting_location`, `create_fgl_context_for_object`, `find_good_location`, as `standable_spot` does), and
only then charges, creates and moves.

**`result`** (new optional key on a FINISHED `act_event`): plain facts for the helper to word.
- For `buy`, `place`, `move`: `room_id`, `wall` (bool: it backs on a wall), `wall_has` (at most 2 object ids on that
  wall: a window, a door), `beside` (at most 4 object ids within 1.5 m), `facing_id` (an object id, or None), and
  `routes_lost`: which of `door`, `bed`, `toilet`, `fridge` were reachable before and are not now. Plus `price` and
  `funds` for `buy`.
- For `sell`: `value` and `funds`.
- For `event`: `cost`, `funds`, `start_min` (game minute of the start).
- For `go`: `zone_id`.

A FINISHED or REJECTED act_event's row stays within the writer's row limit. The result never carries text.

## Contract (helper ↔ Natalis)

Natalis deploys first and accepts every new key and route before any helper sends one.

**Lists: `POST /domus/lists`.**
- Body: `{v: 1, helper_session, kind, digest, items}`. `kind` is one of `people`, `places`, `things`, `events`.
  `digest` is the SHA-256 hex of the canonical items. Body limit 128 KiB.
- Items, as the helper words them (names resolved, tokens cleaned):

  | Kind | Item keys |
  |---|---|
  | `people` | `ref`, `id`, `name` (at most 64), `how` (at most 80: labels and tracks in words), `home` (bool), `here` (bool), `waiting` (bool) |
  | `places` | `ref`, `id`, `name` (at most 64), `kind` (`home`, `household`, `venue`), `what` (at most 40: the venue type, or whose home) |
  | `things` | `ref`, `id`, `name` (at most 64), `where` (a room name, `inventory` or `outside`), `value`, `made_by_her` (bool or absent), `states` (at most 4 words), `in_use` (bool), `count` (inventory), `placement` |
  | `events` | `ref`, `id`, `name` (at most 64), `cost` (int or absent) |

- Natalis keeps one row per (attachment, kind): the newest digest and items. It answers
  `{status: "ok", stored: true}`.
- Natalis's sync answer gains `lists`: `{kind: digest}` for each list it holds for the attachment. The helper resends a
  list whose digest differs, or that Natalis lacks.

**Catalogue: `game_catalog` asks.**
- The sync answer gains `catalog`: `[{ask_id, words, room?, max_price?, placement?}]`, handed once, as memory asks
  are.
- The helper answers with `POST /domus/catalog`: `{v: 1, helper_session, ask_id, matched, items}`. At most 12 items:
  `{ref, id (definition id), name, price, placement, category (at most 40)}`.
- Only purchasable furniture and decor are searched: no build items (walls, floors, doors, windows, stairs, roofs,
  terrain), nothing hidden, debug or cheat-only. Items are matched on words and filtered by `max_price` and
  `placement`, then ordered by match. The helper never ranks by taste, price or what suits her.

**Verb acts.**
- `SyncAct` gains `verb` (one of `go`, `save`, `event`, `buy`, `place`, `move`, `sell`) and `args` (the probe
  command's args without `act_id`). A verb act carries no `guid64`, and its `object_id` is its target id or `"0"`.
- A `place` arrives from Natalis as `{rel, target_id, facing?}` (on, beside, instead) or `{rel, room, facing?}` (wall,
  in), where `room` is the room's name as the view named it. The helper maps the name to the probe's `room_id` with
  its own room labels. A name that maps to no room, or to more than one, is not sent: it is rejected `UNKNOWN_ROOM`,
  `by: helper`.
- An act with `sim_id` (D4.1) carries it as `sim_id` beside `object_id` and `guid64`.
- The helper gates each verb on the probe: `PROBE_NEEDS` for every verb, and for `sim_id`, is 2.40.0.
- A sync event of a verb act may carry `detail.result`: the helper's words for the probe's result facts, at most 400
  characters (room and object names resolved, the wall and what is on it, what it is beside, which way it faces, the
  routes now cut off, the price and her funds).

**Phone and visitors.**
- A `phone` event becomes a percept `phone`: `{kind, from}` (a name).
- A company entry may carry `waiting: true`.

## Natalis

### Schema

Domus database version 2:
- `acts` gains `verb TEXT` and `args_json TEXT` (both nullable).
- New tables:
  - `lists` (attachment, kind, digest, items_json, at_ms; primary key attachment and kind);
  - `catalog_asks` (as `memory_asks`, plus `room`, `max_price`, `placement`);
  - `catalog_seen` (attachment, ref, definition_id, name, price, at_ms; primary key attachment and ref).
- The migration adds each column and table only when missing, in one transaction, with a test from version 1.

### Tools

Every tool refuses `not_running`, `not_attached` and `stopped` as `game_memory` does. Every verb tool also refuses
`probe_too_old` when the heartbeat's probe version is below 2.40.0. Refs resolve only against the lists, options and
catalogue answers of the attachment that is attached now. Otherwise the tool refuses `stale_list`, naming the tool
that refreshes it.

- **`game_list(what, room?)`**. `what` is one of `people`, `places`, `things`, `events`. It answers at once from the
  stored list: one line per item, with its ref. It changes nothing in the game.
  - `things` with more than 80 items and no `room` answers with counts per room, plus her inventory in full.
  - The places answer starts with: "Travel moves your summoner's game too: ask them first."
  - The things answer ends with: "New clothes are made in Create-a-Sim, which is your summoner's: ask them."
- **`game_act`** gains `sim` (a `p` ref). It is required for a `needs_sim` option, and refused (`not_a_sim_act`) for
  any other.
- **`game_go(place)`** (an `h` ref). A verb act that counts as her one act for the turn.
  - Tool text: "Travel moves your summoner's game too. Ask them on Discord first, and go only after their yes."
  - The act's args and the receipt keep `summonerLastMessageMs`: the time of the summoner's last message before the
    trip, from the runtime's `lastOwnerMs`, or null. That is a fact only: nothing judges it.
- **`game_save()`**. A verb act that counts as her one act. Refused `save_too_soon` within 15 real minutes of her last
  save that was not refused, saying when she can save again.
- **`plan_event(type, guests?, start?)`**: `type` an `e` ref, `guests` up to 16 `p` refs, and `start` either "now"
  (the default) or `{day: "today" | "tomorrow", time: "HH:MM"}` on the game clock. A verb act that counts as her one
  act.
- **`game_catalog(words, room?, max_price?, placement?)`**: `words` 1 to 80 characters. One open ask per thread, with
  a 2-minute expiry, a withdrawal on stop and a wake on the answer, as `game_memory`. The answer note lists each item
  with its `c` ref, name, price and placement, and her money. The items go into `catalog_seen`.
- **`game_buy(item, place, max_price?)`**: `item` a `c` ref from a catalogue answer of this attachment.
- **`game_place(thing, place)`**: `thing` a `t` ref of an inventory item.
- **`game_move(thing, place)`**: `thing` a `t` ref, or an `a` ref (its object).
- **`game_sell(thing)`**: the same refs as `game_move`.
- **`place`** (the argument of buy, place and move): `{on | beside | instead: <t or a ref>}` or
  `{wall | in: <room name, as her view names it>}`, plus optional `facing: <t or a ref> | "room"`. Exactly one
  relation. A room name resolves only against the rooms of the newest view and the things list, exactly, ignoring
  case. Otherwise `unknown_room`, listing the rooms.
- **Limits.** Home edits (buy, place, move, sell): at most 6 per turn (`home_edits_full`), not held by the one-act
  rule. `game_go`, `game_save` and `plan_event` hold the one-act slot like a game act. The meanwhile hold (another
  thread within 60 s) applies to every verb, and `knowingly` overrides it as today.
- **Labels and notes.**
  - The label is the verb in words and its target, e.g. "buy Wooden Nightstand (c4) beside the bed (t9)".
  - A finished verb act's note is its label, then `detail.result` when present. A refused one uses today's
    refusal wording.
  - Plans (`then`) stay for game acts only.

### View

- One count line after the money line, from the stored lists: "You know 23 people; 9 places, 41 things, 6 kinds of
  event: game_list shows them." A list Natalis lacks is left out of the line.
- At work: the job line reads "at work until 17:00" from `until_min` (on the game clock).
- A company entry with `waiting` reads "waiting at your door".
- A `phone` percept reads "<name> texted you" or "<name> is calling you". It wakes her in `when_called`, as being
  addressed does.

### Attention

- `wakesFor`: while any job in the portrait has `at_work` true, a need percept in `distress` does not wake her (quiet
  at work). Every other wake rule is unchanged.

## Briefs

**W13-P1 (probe: people and places).**
- `discovery`;
- lists `people`, `places`, `events` and the `lists_now` command;
- `needs_sim` in the act menu and `act.sim_id` (the push with `picked_item_ids` and `included_override`, then the
  tuned continuation, then `SIM_NOT_CHOOSABLE` with the step);
- `go`, and `event`;
- `until_min`, `waiting`, the phone event, calls held by the caller.

Files: `observers.py`, `situation.py`, `snapshot.py`, `act_menu.py` (`needs_sim` only), `e2_actuator.py` (its own
commands), `cmdbox.py` and `schema.py` (its own keys), plus a new module for discovery and the lists (e.g.
`reach.py`).

**W13-P2 (probe: home).**
- the `things` list;
- `catalog_dump`;
- `save`;
- `buy`, `place`, `move`, `sell`;
- the placement resolver (`place` and `facing`, spot first, then the charge, then the create, then the move; refund
  and remove on a failure after the charge);
- the `result` facts, with the routes re-checked by the existing `reachable` code.

Files: a new module (e.g. `home.py`), `e2_actuator.py` (its own commands), `cmdbox.py` and `schema.py` (its own
keys).

Both probe workers:
- Do not bump the version, and do not touch `helper/domus_helper/vendor/`. The lead merges, bumps to 2.40.0 /
  schema 21, and copies the vendor files.
- Keep `schema.py` and `cmdbox.py` edits to your own keys and commands, in separate blocks, so the branches merge
  cleanly.
- Every new game call goes through the actuator's allow-list; `tools/check_guards.py` must pass. A new call that the
  guards refuse is named in the report, with its reason, not worked around.
- No write path may delete a household object except the `sell` verb, and the removal of a just-created object after
  a failed placement.

**W13-H (helper).**
- read the new records and keys: discovery to a file plus a log line; lists to words and `POST /domus/lists`, with the
  digest resend; `needs_sim`; `waiting`; `phone`; `until_min`; `result` to words;
- the `catalog` ask (`catalog_dump` when the flags are missing; search in `catalog.db`; `POST /domus/catalog`);
- verb acts to probe commands, gated on 2.40.0;
- `sim_id`;
- the RefBook namespaces `p`, `h`, `t`, `e`, `c`;
- an option object whose thing is broken or dirty shows the state from the things list (D9.6).

**W13-N (Natalis).**
- the schema;
- the wire (`/domus/lists`, `/domus/catalog`, the sync answer's `lists` and `catalog`, `SyncAct.verb`, `args` and
  `sim_id`, `detail.result`);
- the tools `game_list`, `game_go`, `game_save`, `plan_event`, `game_catalog`, `game_buy`, `game_place`,
  `game_move` and `game_sell`, and `game_act.sim`;
- the limits, labels and notes;
- the view lines, the `phone` percept, and quiet at work;
- `summonerLastMessageMs` passed from the runtime into the world.

## Verification

- **Each worker.** Focused tests red before green. Probe: `unittest discover` and `tools/check_guards.py`. Helper:
  `pytest -q tests`. Natalis: `npx tsc --noEmit` and the focused vitest files. Fakes only: no game, no Mint, no ssh.
- **The lead.**
  1. Merge P1 and P2, bump to 2.40.0 / schema 21, copy the vendor files, merge H.
  2. Run the full probe and helper suites, then build, verify and install 2.40.0 (game closed).
  3. Run the Natalis full suite on Mint in a scratch clone, back up, and deploy Natalis first.
- **Live (2.40.0)**, in the User's session:
  - the discovery record read;
  - `game_list` people, places, things and events;
  - a call to a friend picked by her;
  - a visitor at the door;
  - a save;
  - a catalogue search and a purchase placed beside something, with its result words;
  - a move and a sale;
  - an event planned for later;
  - a trip she asked the User about first;
  - a work day (quiet, then home).
