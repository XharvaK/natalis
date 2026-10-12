# W13: her reach (people, places, work, home, co-play)

Roadmap stages D4 (people), D5 (leaving the lot, work), D9 (home and keeping) and D8 (co-play), plus three topics the
User added on 2026-10-12: upkeep, her creations, and her wardrobe. Everything here was checked against the game's own
code: the local index of the game's compiled Python, `E:\Domus\gameapi` (never committed). Two research reports from
2026-10-12 fed it. Tags: **READ** (seen in the game's bytecode), **INFERRED**, **LIVE** (needs a live check; the
discovery record below answers it in the first session).

User rulings that shape this (2026-10-12):

- Her save goes to the same slot as the Save button.
- She may buy and place, move and sell on her lot, but never destroy. Her household funds are the only limit.
- Placement is relational ("on the nightstand", "beside the bed, facing the room", "where the old chair is"), resolved
  by the game's own placement, with a plain-words result. A picture only if she asks.
- Furniture and decor first; house design grows later.
- Her home is her call.
- Visits plus work and school are in scope.
- Events start from a question.
- Co-play: the User's Sim is a frozen traveller (its household owns no lot), and each side controls only its own Sim.

## 0. Discovery record (probe, read-only, once per session)

A `discovery` record answers what the code cannot. It is read-only, every read is guarded, and it is written once
after the zone is running:

- **Phone pickers.** For each phone picker: its tuned picker minimums, filter, `include_*` flags, radius and tooltip.
  For each Sim she knows, the step at which `_get_valid_sim_choices_gen` drops them. For every phone affordance, its
  `TestResult` reason text (the game's debug reason, not shown to her) and tooltip key.
- **Needs off the lot.** `_off_lot_simulation` for each need commodity (needed for co-play).
- **Save.** `get_save_slot_proto_buff()`: whether `slot_id` is above 1, and whether a slot name is present. The
  values are not written. Also `SAVE_GAME_COOLDOWN` and the current save lock state.
- **Situations.** The user-facing situation types (party, date and the like), with name keys and costs.
- **Career.** Her career, its schedule, `can_work_early`, and `available_for_work`.

## D4. People

- **D4.1 A Sim picked by her.** A phone act that needs a Sim (call, text, invite over) is listed with
  `needs_sim: true`. She answers it with `game_act(..., sim: <name or ref>)`, naming any Sim she knows. Her view gets
  a "People you know" list from her relationships: name, how she knows them, and whether they are here.
  - The probe pushes the picker with `interaction_parameters={'picked_item_ids': frozenset({id})}` and
    `included_override=[sim_info]` (READ: `_test` passes these keyword arguments on to `has_valid_choice` and the
    candidate generator; whether the push path passes them is LIVE).
  - If the picker still refuses, the probe pushes its tuned continuation on her Sim with the same
    `picked_item_ids` (READ: `_push_continuation`; that path only works for a Sim on the lot).
  - The refusal names the step that failed, from the discovery code.
- **D4.2 Visitors.** A visitor waiting at her door is on her lot, so the W12 near part lists them. Socials and
  `ask_toLeaveLot` act on them. A greeting social lets a waiting visitor in (INFERRED from `_on_make_waiting_player_greeted`).
  Her view says "waiting at your door" from the visitor's situation job.
- **D4.3 Calls and texts.** An incoming call (`MSG_UI_PHONE_RING` through `dialog_show`) is held for her by the
  caller's id, not by its resolver. Its title names the caller (E6). A text arrives as a phone notification
  (`PhoneNotificationOp`). Her view says who texted, and the notified phone act is listed so she can open it.
- **D4.4 Events from a question.** `plan_event` asks her for:
  - the event type, from the user-facing situation types in discovery;
  - the guests (people she knows);
  - the start: now, or a time today or tomorrow.

  The probe calls the zone situation manager's `create_situation` with a `SituationGuestList` (her as host, guests
  INVITED), `user_facing=True`, and `scheduled_time` for later (READ). The cost comes from her funds through the
  game's own `try_remove` (READ). A refusal is reported as itself: not enough money, a zone that forbids it, or a
  failed create.

## D5. Leaving the lot, work and school

- **D5.1 Places.** Her view gets a "Places you can go" list:
  - home;
  - the households she knows that have homes;
  - venues by type, from `venue_service().get_zones_for_venue_type_gen` (READ), named by lot name and venue type.

  `game_go(place)` calls `world.travel_service.travel_sim_to_zone(her id, zone id)` (READ: it pauses the clock and
  asks the client to travel). A trip is refused with a reason when she is in a rabbit hole, a save is locked, or she
  is carrying a baby. The probe's sampling survives the zone change already (D41). The deny parts `travel`, `goto`,
  `go_to`, `go_here` and `leave` drop out of the act filter for phone travel acts only when `game_go` exists, so both
  routes are the game's own.
- **D5.2 Work.** At work time the game itself sends a player Sim to work (READ: `_start_work_callback` puts her in the
  career rabbit hole). That is the world, not a choice the host makes for her. Her view says "at work until <time>",
  and her game thread is quiet while she is away, except for events and her phone.
  - `game_act` on "go to work early" calls the same path as `career_commands.send_to_work` (READ).
  - "Leave work early" is the game's own act.
  - A career event (a work day on a lot) is an ordinary zone: she plays it with her normal acts.
- **D5.3 School.** For a child or teen Sim, school runs the same way. Ashley is an adult, so this is designed and
  tested with fakes only.

## D9. Home and keeping

- **D9.1 Save.** `game_save` calls `PersistenceService.save_using(save_game_gen, SaveGameData(slot_id, slot_name,
  True, None), send_save_message=True, check_cooldown=False)` with the current slot from `get_save_slot_proto_buff()`
  (READ). The game shows its own "saved" message.
  - Refused when the slot id is 1 or less (no player slot is loaded), when a save lock holds it (the game's own lock
    tooltip is the reason), or within 10 real minutes of her last save.
  - The probe writes the save's result when `on_save_complete` reports it.
- **D9.2 Catalogue.** The probe writes a `catalog` record once per game version: each buyable definition's id, name
  key, price, buy category flags, placement flags (floor, wall, surface) and tags (READ: `Definition.price`,
  `build_buy.get_object_buy_category_flags` and `get_object_placement_flags`). The helper stores it in `catalog.db`
  (which exists) and answers `game_catalog(words, room, max_price)` with matches in the game's own names and prices.
- **D9.3 Buy and place.** `game_buy(item, place)`, where place is a relational intent:
  - `on <object>`: a free surface slot of that object;
  - `beside <object>`: FGL starting beside it, against the same wall when the item is wall-placed;
  - `against the <side> wall of <room>`;
  - `in <room>`: FGL from the room's middle;
  - `in place of <object>`: that object's transform, after it is sold or moved.

  The probe finds the spot first: `placement.create_starting_location` → `create_fgl_context_for_object` →
  `find_good_location` (READ, as `standable_spot` does today). Slots use the target's own runtime slots, found
  defensively. Only then does it charge `household.funds.try_remove(price, reason, sim, require_full_amount=True)`
  (READ), create the object with `objects.system.create_object` (READ), and move it into place.
  - If anything fails after the charge, the money goes back with `funds.add` and the new object is removed. That is
    not her home being destroyed: it never stood there.
  - The result is said in words: the room, the wall it backs on, what it is beside, which way it faces, and whether
    the routes to doors, beds, toilets and the fridge she could reach before are still reachable (`reachable`
    re-checked).
- **D9.4 Move.** `game_move(object, place)` resolves the same intents, then `obj.move_to(routing_surface, transform)`
  (READ). The result reads as for a purchase.
- **D9.5 Sell.** `game_sell(object)` pays `obj.current_value` into her funds and removes the object (READ). It cannot
  be used on a Sim, a door, a window, a wall or a stair, on anything that holds a Sim, or on something in use.
- **D9.6 Upkeep.** Broken and dirty states are shown on objects in her view (the near-object conditions from 2.32,
  extended to every listed object). Repair and clean acts are the game's own. Hiring help goes through the services
  picker that already works. W12's C4 says why an act is refused.
- **D9.7 Her creations.** A painting or craft she made sits in her inventory. "Your things" in her view lists her
  inventory (name, value, made by her). `game_buy`'s place step also works on an inventory item: `game_place(item,
  place)`. Selling and gifting are the game's own acts.
- **D9.8 Wardrobe.** Changing outfits is a pie act. G1 (W12) lists each outfit category as its own variant. New
  clothes and outfit planning are the Create-a-Sim screen, which stays the User's hands. She can ask the User, and
  her view says so.

## D8. Co-play (the User's Sim visits)

- **The traveller.** The User's Sim lives in its own household, which owns no lot (the game allows this). While the
  User is away:
  - aging is off for that Sim, through `sim_info.set_aging_enabled(False, update_callbacks=True)` (READ:
    `AgingMixin`);
  - needs do not change, because the Sim is not instantiated and needs do not low-level simulate unless tuned to
    (READ: `_can_low_level_simulate`). Discovery confirms that per need.
  - **LIVE:** story progression may demote or cull a household with no lot ("homeless played demotion"). Marking the
    household played (`set_played_household`) may protect it. Discovery logs the population settings, and the first
    co-play test watches it.
- **Join.** The User types `/coplay join` on Discord, or a game command. The probe spawns the User's Sim at her front
  door with `SimSpawnRequest` placed at the front-door spot that D3 already finds. It makes that Sim selectable with
  `client.add_selectable_sim_info`, and makes it the active Sim so the camera and controls are the User's.
- **Her body stays hers.** Today the probe refuses her acts when the active Sim is not her (W5d BODY_MISMATCH).
  During co-play her body is her Sim's id, whoever is active. That is the main change, and the main risk.
- **Leave.** `/coplay leave` makes her Sim active again, removes the User's Sim from the selectable list, and sends it
  away: despawned, its sim_info kept, and still frozen.
- **Hands.** Each controls their own Sim. Her view names the User's Sim by the User's alias. Socials between them are
  ordinary acts.
- **Her visiting the User's home** does not exist: a traveller has no home.

## Build plan

- **W13-P1 (probe, people and places):** discovery, D4.1–D4.4, D5.1, D5.2.
- **W13-P2 (probe, home):** D9.1–D9.7, the catalogue record.
- **W13-P3 (probe, co-play)** waits for discovery from one live session (needs off the lot, population).
- **W13-H:** the "people you know", "places", "your things" and catalogue lists, the new commands, and the result
  words.
- **W13-N:** the tools `game_go`, `game_save`, `game_catalog`, `game_buy`, `game_place`, `game_move`, `game_sell` and
  `plan_event`, and the `sim` argument of `game_act`.

Each new probe call is defensive and never raises into the game, and has a test with fakes. Live checks follow the
discovery record.
