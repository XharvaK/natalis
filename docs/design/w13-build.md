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
- **Home edits per turn.** She may make any number of home edits (buy, place, move, sell) in one turn, each with its
  own receipt (the User removed the cap of 6, 2026-10-12). They are outside the turn's slot: they never hold it and
  are never refused by it.
- **The turn's slot.** Save, travel and a planned event hold the turn's one slot: one of them is refused after a game
  act or another of them in the same turn, and a game act is refused after one of them (`turn_slot_held`). Game acts
  are not limited to one a turn (cage ruling Q-3, 2026-10-12).
- **Save floor.** 15 real minutes between her saves, besides the game's own save lock.
- **Quiet at work.** While she is at work, a need going into distress does not wake her, in every attention mode: the
  game looks after her needs in the rabbit hole. When work ends with a need still in distress, she wakes once.
  Questions, held windows, calls, phone notifications and looks wake her as always (audit ruling, 2026-10-12).
- **Cage rulings** (the User, 2026-10-12; the cage lens: Domus is a map she navigates freely, and a host refusal that
  encodes judgement is a cage). Quiet means quiet: in quiet mode a need in distress does not wake her (Q-1). The 60 s
  hold across threads stays (Q-2). Plans may have up to 6 steps (Q-4). Her phone's "invite to" is offered;
  ask-on-date and hang-out wait for the live check (Q-5). Off-lot Sims she cannot see stay unoffered (Q-6). The lab
  drivers run only with `--lab`, never on HOME (Q-7). The career leave-early acts are shown (Q-a). The rabbit-hole
  and save-lock travel refusals stay until the live check (Q-c). Events take the game's limits: a start up to 99
  days ahead and the event type's own `max_participants` (a wire bound of 64) (Q-d). Vehicles are in the catalogue
  (Q-f). A window on her Sim that another Sim's script opened is hers; the User's hand stays the User's (Q-g). Home
  edits stay on her lot (Q-i). The emergency stop refuses acts, not reads: lists, the catalogue, memory questions,
  looks and pictures still run (Q-j). The Create-a-Sim line in the things answer is gone (Q-k). Screens stay
  withheld (Q-e); the other bounds stay (Q-l).
- **Reads before the live record** (audit ruling, 2026-10-12). 2.40.0 reads what the game index shows safely: place
  names from the household, relationship track values, the rabbit-hole refusal. Venues, event scheduling, off-lot
  facts and career early/available wait for the live discovery record; until then they are absent or None, and the
  lists say so.
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

In 2.40.0, `off_lot`, `population`, the scheduling flag of `situations` and the career's `can_work_early` and
`available_for_work` are not read yet (the reads ruling above). The record's `unread` section names them, so the
record says what it does not hold.

The helper stores each discovery record as one JSON file in its data folder (`discovery/<telemetry session>.json`)
and logs one line. It is evidence for the lead, not part of her view.

**`lists`** (P1 people, places, events; P2 things). One record kind with `kind` in `people`, `places`, `things`,
`events`, written in parts like `act_menu` (`list_rev`, `part`, `parts`, at most 128 items per part). The probe checks
each list at most once every 60 real seconds, and writes it only when its content digest changed, on each zone load,
and on a `lists_now` command.

| Kind | Item keys |
|---|---|
| `people` | `sim_id`, `first_name`, `last_name`, `labels` (relationship bit names, at most 4), `tracks` ({track type name: int value}, the visible tracks, at most 4), `household_id`, `has_home` (bool), `on_lot` (bool), `waiting` (bool: a visitor waiting at her door) |
| `places` | `zone_id`, `kind` (`home`, `household`, `venue`), `lot_name` (string, at most 64: a home's household name), `venue` (tuning name), `household_id` (for `household`) |
| `events` | `situation_id`, `name_key`, `cost` (int or None), `schedulable` (bool, None in 2.40.0) |
| `things` | `object_id`, `definition_id`, `name_key`, `where` (`room` with `room_id`, `inventory`, or `outside`), `value` (int), `made_by_her` (bool or None), `states` (at most 4 {state, value}, from the near-object conditions code), `in_use` (bool), `count` (inventory stacks), `placement` (`floor`, `wall`, `surface` or None, from the definition's placement flags as for the catalogue) |

- People: her relationships from her relationship tracker, at most 200, ordered by the game's own order.
- Places: home, the homes of the households of the people she knows, and venues by type from the venue service, at
  most 120. Venues are not read in 2.40.0.
- Events: only the user-facing types in this list can be planned (`NOT_AN_EVENT` otherwise).
- Lists are written through one writer per kind (one `list_rev` counter); a list counts as written only when all its
  parts were. The `digest` on a probe record is the probe's own change check.
- Things: every object on her home lot that her household owns and that buy mode would list (not Sims, walls,
  floors, roofs, terrain or stairs), and her inventory. At most 600. On a lot that is not her home, only her
  inventory.

**`catalog`** (P2). Written only on a `catalog_dump` command, in parts of at most 256 items (`catalog_rev`, `part`,
`parts`). `catalog_rev` is the probe's target build, for information only: the helper keys its flags by the game
build it detects. Each item: `definition_id` (digits), `price`, `buy_category`, `placement`, `tags` (at most 8 tag
names), `purchasable`.
- `buy_category`: the names of the set bits of `build_buy.get_object_buy_category_flags(definition id)` among
  APPLIANCES, ELECTRONICS, ENTERTAINMENT, LIGHTING, PLUMBING, DECOR, KIDS, STORAGE, COMFORT, SURFACE, VEHICLE (the
  unused bits and DEFAULT are ignored); None when unreadable.
- `placement`: a list of one word from `build_buy.get_object_placement_flags(definition id)`: `wall` when a wall flag
  is set (CENTER_ON_WALL, EDGE_AGAINST_WALL, ADJUST_HEIGHT_ON_WALL, GROUNDED_AGAINST_WALL, ON_WALL_TOP), else `surface`
  when REQUIRES_SLOT is set, else `floor`; None when unreadable.
- `purchasable`: the price is an int of 0 or more, the item has a buy category (buy mode lists it), and no tag says
  hidden, debug or cheat. Only purchasable items are written and bought.

The helper sends `catalog_dump` when its `catalog.db` has no flags for the running game build.

### Act menu

- An act entry may carry `needs_sim: true`: a phone act that opens a Sim picker. Today these are excluded as
  `pie_picker`; they are listed from 2.40.0 with this key.

### Portrait

- A `self.careers` entry may carry `until_min`: the game minute of the day her current work session ends, while
  `at_work` is true. None when unreadable.
- A company entry may carry `waiting: true` (a visitor waiting at her door, from the visitor's situation job).

### Phone

- An incoming call is held for her by the caller's sim id, not by its resolver. Its title names the caller (E6).
- A `phone` event has `kind`, `from_sim_id` and `notifies`:
  - `notice`: her phone shows a notification. The game's `PhoneNotificationOp` carries the phone owner's sim id and
    the guid of the phone act it notifies (`ui_send_phone_notification`), and no sender. It is written only when the
    owner is her Sim; `from_sim_id` is None and `notifies` is that guid.
  - `call`: a call held for her; `from_sim_id` is the caller when readable.

### Commands

`schema.COMMANDS` gains `go`, `save`, `event`, `buy`, `place`, `move`, `sell`, `catalog_dump`, `lists_now`. Every
command that does something carries `act_id`, and its outcome is written as `act_event` rows for that id, as for
`act`.

| Command | Args | Phases and codes |
|---|---|---|
| `act` | gains optional `sim_id` (digits), only for a `needs_sim` act | REJECTED `SIM_NOT_CHOOSABLE` with the game's own refusal reason in `detail` (the game's test decides, never a host guess), or `SIM_NEEDED` |
| `go` | `act_id`, `zone_id` | ACCEPTED, PUSHED (travel asked of the client), FINISHED `ARRIVED` (her Sim is in that zone after the load); REJECTED `IN_RABBIT_HOLE`, `SAVE_LOCKED`, `SAME_ZONE`, `NO_ZONE`, `TRAVEL_PENDING` (a trip of hers is still pending), `PUSH_FAILED`; UNKNOWN `TRAVEL_UNSEEN` if no zone change within 5 real minutes, `SAMPLER_STOPPED` |
| `save` | `act_id` | ACCEPTED, FINISHED `SAVED` on the game's manual-save callback (the game calls it only for a successful save to a player slot); REJECTED `NO_PLAYER_SLOT`, `SAVE_LOCKED` (the lock's tooltip key in `reason_key`), `SAVE_BUSY` (a save is already running), `SAVE_TOO_SOON` (within 15 real minutes of her last save: a backstop for the host's floor), `SAVE_FAILED`; UNKNOWN `SAVE_UNCONFIRMED` when no callback came within 120 s |
| `event` | `act_id`, `situation_id`, `guests` (0 to 64 sim ids; a guest named twice is one), `start` (`"now"` or `{day_offset: 0 to 99, hour, minute}`) | FINISHED `CREATED` (result `cost`: the money that fell over the game's call); REJECTED `NOT_AN_EVENT` (not in her newest events list), `NO_FUNDS` (below cost plus hire), `START_PAST`, `TRAVEL_PENDING`, `CREATE_FAILED` (detail `cost unread` or `funds unread` before anything, `too many guests (at most N)` with N the type's `max_participants` or 64, `create` when nothing was made and nothing fell, `refunded <n>` or `refund failed` when the money fell and no event was made); `ZONE_FORBIDS` and `NOT_SCHEDULABLE` wait for the live record. The game takes the price (cost plus the guest list's hire cost) itself; the probe never charges an event (T5). A free event needs no money read |
| `buy` | `act_id`, `definition_id`, `place`, optional `max_price` | FINISHED `PLACED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_PURCHASABLE`, `PRICE_ABOVE` (live price above `max_price`), `NO_FUNDS`, `NO_SPOT`, `NOT_FREE`, `SPOT_FAILED` (the spot search raised; nothing charged, the object removed), `PLACE_FAILED` (money returned, the new object removed); UNKNOWN `CHARGE_UNKNOWN` when the money could not be read after the charge (the object removed, no refund); UNKNOWN `REMOVE_UNCONFIRMED` with the object id when a just-made object could not be removed (no refund then) |
| `place` | `act_id`, `object_id` (an inventory item), `place` | FINISHED `PLACED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_IN_INVENTORY`, `NO_SPOT`, `NOT_FREE`, `PLACE_FAILED` (the item back in her inventory) |
| `move` | `act_id`, `object_id` (on the lot or in her inventory), `place` | FINISHED `MOVED`; REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_HERS`, `IN_USE` (detail `unreadable` when its use cannot be read), `NOT_MOVABLE`, `IN_INVENTORY` (use `place`), `NO_SPOT`, `NOT_FREE`, `MOVE_FAILED` |
| `sell` | `act_id`, `object_id` (on the lot or in her inventory) | FINISHED `SOLD` once the object is gone (she is paid then, as earnings); REJECTED `NOT_HOME`, `BUILD_MODE`, `NOT_HERS`, `SELL_PENDING` (a sale of it is waiting for the game), `IN_USE` (detail `unreadable` when its use cannot be read), `NOT_SELLABLE` (a Sim, door, window, wall, stair, or anything that holds a Sim), `SELL_FAILED`; UNKNOWN `SELL_UNCONFIRMED` (not gone within 30 s; not paid) |
| `catalog_dump` | none | writes the `catalog` record; idempotent |
| `lists_now` | none | reads every list now and writes each one whose digest (or total) changed; idempotent (REACH2-9) |

Every verb may also be REJECTED `NOT_SAMPLING`, `E2_UNAVAILABLE`, `BODY_UNAVAILABLE` or `BODY_MISMATCH`, or end
UNKNOWN `E2_EXCEPTION:<type>`. When the probe cannot write a verb's row (its schema refuses it), it writes UNKNOWN
`ROW_INVALID` without a result, so no act is left without an outcome.

**`place`** (the argument): `{"rel": R, ...}` with R one of:
- `on`, with `target_id`: a free surface slot of that object (its runtime slots, found defensively);
- `beside`, with `target_id`: FGL starting beside it, against the same wall when the item is wall-placed;
- `wall`, with `room_id`: FGL from the room's border cells nearest its middle, facing into the room;
- `in`, with `room_id`: FGL from the room's middle;
- `instead`, with `target_id`: that object's spot; refused `NOT_FREE` while the target still stands (sell or move it
  first).

A room is found by sampling the lot about every metre with the game's `build_buy.get_room_id`, cached per zone and
level and cleared after a home edit: its middle is the mean of its cells (an empty room works), its border the cells
next to another room or outside. Optional `facing`: an object id (digits), or `"room"` (towards the room's middle); it
is the start orientation given to the search, never a turn after it. The probe makes a buy's object unplaced first,
to measure its footprint, then finds the spot, then charges, then moves it; the object is removed on every miss before
the charge. A placement from her inventory takes the item out of the inventory the way the game does
(`try_remove_object_by_id`), and puts it back if the move fails.

**`result`** (new optional key on a FINISHED `act_event`): plain facts for the helper to word.
- For `buy`, `place`, `move`: `room_id`, `wall` (bool: the spot is within a metre of its room's border), `wall_has`
  (at most 2 object ids on that wall: a window, a door) with `wall_kinds` (`door` or `window` for each), `beside` (at
  most 4 object ids within 1.5 m, on the same level, no Sims, nothing in an inventory), `facing_id` (the object it
  faces, or None), and `routes_lost`: which of `door`, `bed`, `toilet`, `fridge` were reachable before and are not
  now. Plus `price` and `funds` for `buy`.
- For `sell`: `value` and `funds`.
- For `event`: `cost`, `funds`, `start_min` (game minute of the start).
- For `go`: `zone_id`.

A FINISHED or REJECTED act_event's row stays within the writer's row limit. The result never carries text.

## Contract (helper ↔ Natalis)

Natalis deploys first and accepts every new key and route before any helper sends one.

**Lists: `POST /domus/lists`.**
- Body: `{v: 1, helper_session, kind, digest, items, total}`. `total` (T1) is a whole number at least the items sent:
  the probe's count of the things the game holds before its 600 cut (her inventory first, then the lot), or the count
  before the helper's byte cut; Natalis's count line reads "<total> things (<n> listed)" when they differ. `kind` is one of `people`, `places`, `things`, `events`.
  `digest` is the SHA-256 hex of the canonical JSON (sorted keys, no spaces, UTF-8) of the items as the helper sends
  them. It is the helper's change marker: Natalis stores and compares it as a string and does not recompute it. Body
  limit 128 KiB; the helper cuts a list at 120 KiB, her inventory kept first.
- The helper assembles a probe list only when every part of one `list_rev` carries the same digest and count and the
  items number `count`.
- Room labels belong to the helper and come from the newest things list: each room is "the room with ..." its
  things; equal labels get " (2)", " (3)" in room id order; a room with no thing has no label. A thing's `where` is its
  room's label. The helper maps a label back to the probe's `room_id` (a digit string) from the same table.
- Items, as the helper words them (names resolved, tokens cleaned):

  | Kind | Item keys |
  |---|---|
  | `people` | `ref`, `id`, `name` (at most 64; "unnamed" when unreadable), `how` (at most 80: labels and tracks in words), `home` (bool), `here` (bool), `waiting` (bool) |
  | `places` | `ref`, `id`, `name` (at most 64), `kind` (`home`, `household`, `venue`), `what` (at most 40: the venue type, or the owner's name) |
  | `things` | `ref`, `id`, `name` (at most 64), `where` (a room name, `inventory` or `outside`), `value`, `made_by_her` (bool or absent), `states` (at most 4 words), `in_use` (bool), `count` (inventory), `placement` |
  | `events` | `ref`, `id`, `name` (at most 64), `cost` (int or absent) |

- Natalis keeps one row per (attachment, kind): the newest digest and items. It answers
  `{status: "ok", stored: true}`.
- Natalis's sync answer gains `lists`: `{kind: digest}` for each list it holds for the attachment. The helper resends a
  list whose digest differs, or that Natalis lacks.

**Catalogue: `game_catalog` asks.**
- The sync answer gains `catalog`: `[{ask_id, words, max_price?, placement?}]`, handed once, as memory asks are.
  (An ask has no room: the catalogue cannot filter by room.)
- The helper answers with `POST /domus/catalog`: `{v: 1, helper_session, ask_id, matched, items}`. At most 12 items:
  `{ref, id (definition id), name, price, placement (one word), category (at most 40)}`.
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
  routes now cut off, the price and her funds). An event's start is worded "Starts at HH:MM today" (or "tomorrow", or
  "in N days", from the act's own `day_offset`), or "Starts now". A sale's value reads "Sold for §N". Natalis cuts a longer result to 400 rather than refuse the sync.
- An envelope the helper's command box refuses is rejected `ARGS_INVALID` with the box's code in `detail`.

**Phone and visitors.**
- A `phone` event becomes a percept `phone`: `notice` (with `act`, the name of the phone act it notifies, when the
  current act menu has it) or `call` (with `from`, a name).
- A company entry carries `waiting: true` when the visitor's presence or any of its situations says so.

## Natalis

### Schema

Domus database version 2:
- `acts` gains `verb TEXT` and `args_json TEXT` (both nullable).
- New tables:
  - `lists` (attachment, kind, digest, items_json, at_ms; primary key attachment and kind);
  - `catalog_asks` (as `memory_asks`, plus `room` (kept for old rows, no longer written), `max_price`, `placement`);
  - `catalog_seen` (attachment, ref, definition_id, name, price, at_ms; primary key attachment and ref);
  - `list_marks` (one row: the helper session her last `game_list` or catalogue answer named; her refs resolve only
    while that session is attached).
  - Forgetting a word a stored list holds deletes that list row; the helper sends the list again.
- The migration adds each column and table only when missing, in one transaction, with a test from version 1.

### Tools

Every tool refuses `not_running`, `not_attached` and `stopped` as `game_memory` does. Every verb tool also refuses
`probe_too_old` when the heartbeat's probe version is below 2.40.0 or unknown. Refs resolve only against the lists,
options and catalogue answers of the attachment that is attached now, and a list ref only while the attachment that
answered her last `game_list` or `game_catalog` is still attached (the helper numbers refs per attachment).
Otherwise the tool refuses `stale_list`, naming the tool that refreshes it. Forgetting a word that a stored list
contains drops that list; the helper sends it again.

- **`game_list(what, room?)`**. `what` is one of `people`, `places`, `things`, `events`. It answers at once from the
  stored list: one line per item, with its ref. It changes nothing in the game.
  - `things` with more than 80 items and no `room` answers with counts per room, plus her inventory in full.
  - The places answer starts with: "Travel moves your summoner's game too: ask them first."
- **`game_act`** gains `sim` (a `p` ref). It is required for a `needs_sim` option, and refused (`not_a_sim_act`) for
  any other.
- **`game_go(place)`** (an `h` ref). A verb act that holds the turn's slot.
  - Tool text: "Travel moves your summoner's game too. Ask them on Discord first, and go only after their yes."
  - The act's record (kept beside its args, never sent to the game) and the receipt keep `summonerLastMessageMs`: the
    time of the summoner's last message before the trip, from the runtime's `lastOwnerMs`, or null. That is a fact
    only: nothing judges it.
- **`game_save()`**. A verb act that holds the turn's slot. Refused `save_too_soon` within 15 real minutes of her last
  save that was not refused, saying when she can save again.
- **`plan_event(type, guests?, start?)`**: `type` an `e` ref, `guests` up to 64 `p` refs (the game's own cap per
  type is the probe's to say), and `start` either "now" (the default) or a `day_offset` (0 to 99) and a time on the
  game clock. A verb act that holds the turn's slot.
- **`game_catalog(words, max_price?, placement?)`**: `words` 1 to 80 characters. One open ask per thread, with
  a 2-minute expiry and a wake on the answer, as `game_memory`. A read: the stop does not withdraw it (Q-j). The answer note lists each item
  with its `c` ref, name, price and placement, and her money. The items go into `catalog_seen`.
- **`game_buy(item, place, max_price?)`**: `item` a `c` ref from a catalogue answer of this attachment.
- **`game_place(thing, place)`**: `thing` a `t` ref of an inventory item.
- **`game_move(thing, place)`**: `thing` a `t` ref, or an `a` ref (its object).
- **`game_sell(thing)`**: the same refs as `game_move`.
- **`place`** (the argument of buy, place and move): `{on | beside | instead: <t or a ref>}` or
  `{wall | in: <room name, as her view names it>}`, plus optional `facing: <t or a ref> | "room"`. Exactly one
  relation. A room name resolves only against the rooms of the newest view and the things list, exactly, ignoring
  case. Otherwise `unknown_room`, listing the rooms.
- **Limits.** Home edits (buy, place, move, sell) have no cap in a turn and are outside the turn's slot. `game_go`,
  `game_save` and `plan_event` hold the slot (`turn_slot_held`), against game acts and each other. The meanwhile
  hold (another thread within 60 s) applies to every verb, and `knowingly` overrides it as today.
- **Labels and notes.**
  - The label is the verb in words and its target, e.g. "buy Wooden Nightstand (c4) beside the bed (t9)".
  - A finished verb act's note is its label, then `detail.result` when present. A refused one uses today's
    refusal wording.
  - Plans (`then`) stay for game acts only, up to 6 steps (`PLAN_MORE` 5), and a plan step cannot name a Sim
    (`sim_needed`).

### View

- One count line after the money line, from the stored lists: "You know 23 people; 9 places, 41 things, 6 kinds of
  event: game_list shows them." A list Natalis lacks is left out of the line.
- At work: the job line reads "at work until 17:00" from `until_min` (on the game clock).
- A company entry with `waiting` reads "waiting at your door".
- An option that needs a Sim says so: "(needs a Sim: name one with sim)".
- A `phone` percept reads "Your phone shows a new notification." (plus "It is about: <act>." when known) or "<name>
  is calling you." It wakes her in every mode, at work too, as being addressed does.

### Attention

- `wakesFor`: while any job in the portrait has `at_work` true, a need percept in `distress` does not wake her, in
  every attention mode (quiet at work). When `at_work` turns false and a need is still in distress, she wakes once.
  Every other wake rule is unchanged.

## Second repair wave (2026-10-12)

The seams the second audit found, as built (the lead's FIX_PLAN2):
- **T1 things total.** The probe reads her inventory first, then the lot, before the 600 cut, and the things record
  carries `total`; the helper's list post carries it; Natalis stores it (Domus database version 4, `lists.total`).
- **T2 `left_out`.** Her phone's option object may carry `left_out`: at most 12 strings of at most 160 characters,
  "<act>: left out: <reason>" and "<act>: refused: <reason>", the 12th "and <n> more" past that. When every phone act
  is left out there is no phone object to carry the line (on the list of what she could not reach).
- **T3 rendering.** Natalis renders `refused`, `states` and `left_out` under each object, and they are part of the
  choices signature.
- **T4 codes.** New REJECTED `SELL_PENDING` and `SPOT_FAILED`; `CHARGE_UNKNOWN` now removes the made object with no
  refund; the event details above. Natalis words every code the probe and the helper send (one table, in second
  person; an unknown code shows as itself).
- **T5 event money.** The game charges an event; the probe pre-checks, reads the money around the call, and gives back
  what fell when no event was made (`count_as_earnings=False`).
- The helper asks the probe for fresh lists (`lists_now`) after a verb act ends, at most once per 10 s.
- Rollback note (NATALIS2-14): Domus database versions 3 (`work_watch`) and 4 (`lists.total`) are additive; an older
  Natalis ignores them, so a rollback needs no down-migration. Back up `domus.sqlite` before the deploy.

## Briefs

**W13-P1 (probe: people and places).**
- `discovery`;
- lists `people`, `places`, `events` and the `lists_now` command;
- `needs_sim` in the act menu and `act.sim_id` (the push with `picked_item_ids` and `included_override`, then the
  tuned continuation, then `SIM_NOT_CHOOSABLE` with the game's reason);
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
  - a work day (quiet, then home);
  - added by the audit (2026-10-12): what the ring dialog's `target_sim_id` names; a phone notice; how long a sold
    object takes to go; an inventory placement; the room sampling's cost on her lot; the buy-category and placement
    flags of a few catalogue items; a trip refused in a rabbit hole.

The pre-smoke audit (six read-only audits, the lead's checks in the game bytecode, the verdicts and fix briefs) is
kept with the lead's working notes, outside this repository.
