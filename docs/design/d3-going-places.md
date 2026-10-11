# D3: going places on the lot (and a first look at reaching people)

She can act on any object on her lot (N8), and asking for an act walks her Sim there. What she cannot do is be
somewhere without a reason the game supplies: stand on the porch, go out to the garden, go upstairs. A player does this
with "Go Here" on the ground. D3 gives her the same hand. Checked against the game's own code (read only, from the
installed game's compiled modules) and Domus ds3-senses c5c272a.

## How the game does it

- The player's "Go Here" is the terrain interaction `terrain-gohere` (class `GoHereSuperInteraction`, module
  `objects/terrain`). Its target is a `objects.terrain.TerrainPoint(location)` and its context carries a pick:
  `PickInfo(pick_type=PickType.PICK_TERRAIN, target=<the point>, location=<the position>, routing_surface=<the
  surface>)` (`PICK_POOL_SURFACE` when `build_buy.is_location_pool(position, level)`). The game builds exactly this
  when it restores a Sim's go-here after a load (`GoHereSuperInteraction.create_load_context`).
- A standable spot near a position comes from the game's own search: `placement.create_starting_location(position=...,
  routing_surface=...)`, `placement.create_fgl_context_for_sim(starting_location, sim)` and
  `placement.find_good_location(context)`, which returns a position and an orientation (or None).
- Room ids come from `build_buy.get_room_id(zone_id, position, level)`, as the probe already reads them. Room `"0"` is
  outdoors.

## What goes wrong if this is built thinly (failure modes first)

1. **A spot inside furniture.** An object's own position is inside its footprint; going there fails. Every spot must
   come from the game's standable-spot search for her Sim, and a room with no spot found is left out.
2. **Stale spots.** Objects move and rooms change in build mode. Spots are found again at every menu build, never
   stored.
3. **Ids that collide or move.** The act path names its target by a numeric object id, and real ids are large. A spot
   gets a small id (1 to 999) that is only a spot's and keeps meaning the same room for the probe's session, so an act
   chosen on an older view still goes where she read. An act on a spot id the newest build does not hold is refused
   with `NO_OBJECT`, as a vanished object is.
4. **The game says no.** Go Here has its own tests (off lot, unroutable, in a pool). The act goes through the same
   preflight test and refusal codes as every other act, so a refusal reaches her in the game's words.
5. **A hidden judgment.** Which spots exist is mechanical: one per room that has objects, on that room's level, plus
   outdoors and the front door. There is no "interesting spot" logic.
6. **Unnamed places.** A spot's words are the room's label as the helper already names rooms ("the room with the fridge
   and the stove"), "outside" for room 0, and "the front door, outside".

## The design

### Probe

**P1. Spots in the menu build.** After the objects are read, the probe groups the menu's objects by (room, level). For
each group it takes the position nearest the group's centre among its objects, and asks the standable-spot search for
her Sim there. It does the same for the front door (`services.get_door_service().get_front_door()`, searched from the
door's position on the outdoor side; skip it when the game has no front door). Each spot's id comes from a registry
the probe keeps for its whole session: the key is (room, level, kind); the first time a key is seen it gets the next
id from 1, and it keeps that id for the session, so an id never names another spot (at most 999 keys). The table of
the newest build maps the id to its position. Each spot is one more menu entry:

```
{"object_id": "<spot id>", "class": "spot", "room": "<room id>", "level": <int>, "spot": "room" | "front_door",
 "distance_m": <metres from her>, "same_room": <bool>, "acts": [{"guid64": "<terrain-gohere guid64>",
 "name": "terrain-gohere", "text_key": null}]}
```

The spot entries come after her room's objects, in the same place in the order as their room. The spot table
(id: position, orientation, routing surface, level) is kept with the menu build that made it. The search runs inside
the per-tick budget like the other menu work. If the spot search raises, that spot is skipped.

**P2. The act on a spot.** In `_act_check`, an object id that is in the newest spot table resolves to that spot:

- the target is `TerrainPoint(location)` built from the spot;
- the context is the normal act context plus the pick above;
- the affordance is `terrain-gohere`, found by its guid64 from the terrain object's offers.

It then goes through the same exclusion, user-directed and preflight checks and the same push path as every act, so
receipts, the push mark (F1) and the queue all behave as for objects. Imports the probe's import guard must allow:
`objects.terrain`, `placement`, `interactions.context` (`PickInfo`, `PickType`) if not already allowed.

**P3 (D4a, a diagnostic only). Why the phone's people acts are missing.** In the menu build, for her phone's offers
that the game's preflight test refuses, record the tuning name and the refusal's reason (the game's tooltip key or
text, as the act path already reads `reason_key`) in the act_menu row as `refused_phone: [{name, reason_key}]` (at
most 16). Nothing else changes. In the live session this tells us whether "Call to Chat" and "Invite Over" are refused
for want of a picked Sim, and D4 is designed from that evidence.

### Helper

**H1. Naming spots.** An option object of class `spot` is named from its room: the room label when known, "outside"
for room 0, "the front door, outside" for `spot: front_door`, else "a room upstairs" or "a room" by level. Its act
text is "Go here". It carries `room` and `near` as every object does. Spots are never cut before objects of their
room. The F2 seed and the F3 stable refs apply as to objects; the ref key for a spot is ("spot", room, level, kind),
not its numeric id, so a spot keeps its ref across menu builds.

The helper keeps the probe's spot id for the act request (it is the object id the act names).

**H2.** The vendored schema copy follows the probe's schema change (the menu object's new optional fields `spot` and
`level`; `refused_phone` on the act_menu row).

### Natalis

Nothing. A spot is an object with one act; the view lists it in its room.

## Verification

- Probe tests with fakes:
  - spots are found per room and level, with a skip when the search returns None;
  - the front door is skipped when there is none;
  - spot ids are small and mapped back;
  - an act on a spot builds a terrain point and a pick context and goes through preflight;
  - an act on an unknown spot id is `NO_OBJECT`;
  - `refused_phone` is written with a reason.
- Helper tests:
  - spots are named and given stable refs across builds where the numeric ids change;
  - spots are listed with their room.
- Probe 2.35.0; schema bump only if the row fields change (they do: 17).
- Live: she goes to the garden and to the front door with no other act, and the phone's refusals are read from the
  telemetry.
