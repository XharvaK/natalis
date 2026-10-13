# W15: a map she can walk (design, 2026-10-13)

Status: design accepted (the User took all five recommendations, 2026-10-13), not built. Nothing here is live until it is built,
tested, deployed and seen in a live session.

## The problem, in numbers

Today every game view carries the whole house as a list of objects and acts:

- The probe tests every user-directed act of every object on the lot (`act_menu.MenuBuild`; 5,814 to 6,070 tests on
  HOME, 4 to 10 minutes for the first whole build before the far cache).
- The helper turns the whole menu into options: up to 160 objects and 32 KiB (`acts.options`, `OPTIONS_LIMIT`,
  `OPTIONS_OBJECTS_LIMIT`).
- Natalis renders all of it into the view text, up to 20,000 characters (`options.ts` `VIEW_TEXT_MAX`), and the view
  sits in the volatile "Current view of the game" block of every game turn (`entity/runtime.ts`).

What that costs her:

- Live views of 9K to 21K characters. She once believed she was stuck in the bathroom, because the near part showed
  only the bathroom and the rest of the house was a long list she could not place.
- Room names are "the room with the A and the B" (`reach._room_base`). They tell her what is in a room, not what it is
  for.
- To find food she has to read every object's acts and guess. Nothing in the view says which acts serve which need,
  although the game itself knows: every interaction advertises the needs it serves, and the game's own autonomy
  chooses by those advertisements.
- The current view changes on every look, so the biggest block of the turn never hits the prompt cache.

## The idea

Other projects that work give the model a small map plus ways to look closer, not the whole world:

- SayPlan collapses a scene graph and lets the model expand a node.
- Generative Agents keeps an area tree and names places by what they are for.
- Text game wrappers (the NetHack one) say "here" in full and "elsewhere" in a line.
- Factorio and Mindcraft agents ask the world with query commands (`nearest(...)`) instead of reading lists.
- The Sims' own autonomy picks objects by their advertisements.

So her game context becomes three layers:

1. **Here (every view, volatile):** her room in full, and what is within reach (4 m), with act refs. People, her
   phone, her queue and any question the game asks her stay here too.
2. **Home map (stable, cacheable):** one line per room: a ref, a name by function, its floor, what it offers in need
   words, a few of its things, and the ref of the act that walks her there. It changes only when the house changes.
3. **Look closer (tools, on demand):** `game_look room=<ref>` opens one room with all its act refs.
   `game_find need=<need>` or `game_find text=<words>` lists the nearest choices across the lot that serve a need or
   match the words. Both answer at once, from the newest view Natalis already holds. Neither asks the game.

The act path does not change. `game_act` still takes a ref from the newest view's options table. The helper still
sends the whole table with every view, as data. Only the text she reads is shaped differently. A ref she got from a
look or a find is a ref of the same table, so it works with `game_act` as it does now.

The User's rulings this follows (2026-10-12): rooms are named by function; far rooms are one line each; `game_look`
on a room opens it with refs; acts carry the game's advertisements; a find tool lists the nearest options. And the
standing rules: facts come from the game, she chooses, nothing is scripted, and nothing is withheld by judgement
(see `domus-plan.md`).

## What she reads

An example view, after W15 (invented names):

```
Your body now:
- ...as today...

The game shows:
- You moved rooms.

You are in r2, the kitchen (ground floor).
Choices here, by ref:
- Fridge (here, 1.2 m): a3 Have Quick Meal; a4 Cook; a5 Grab a Snack
- Counter (here, 2.0 m): a6 Prepare Food
- Your phone (with you): a1 Call...; a2 Invite...
- Mira Lane (here, 3.1 m): a7 Chat; a8 Hug
Other rooms: your home map lists them. game_look room=<ref> opens one; game_find finds what serves a need.
```

The home map, its own block before "Recent here":

```
Your home (map 7). Your room is marked with *.
- r1 the bathroom: toilet, washing (Toilet, Shower, Sink). Go there: a20
* r2 the kitchen: food, cooking (Fridge, Stove, Counter). Go there: a21
- r3 the living room: fun, company (TV, Sofa, Chess Table). Go there: a22
- r4 a bedroom upstairs: sleep (Double Bed, Dresser). Go there: a23
- r5 outside, on your lot: fun, cooking (Grill, Garden). Go there: a24
```

`game_look room=r4`:

```
r4, a bedroom upstairs (map 7), from the view seen at 14:02:
- Double Bed (9.4 m): a30 Sleep [sleep]; a31 Nap [sleep]; a32 Relax [comfort]
- Dresser (10.1 m): a33 Change Outfit; a34 Plan Outfit
The game sees no way for you to get there from where you are now.   <- only when it says so
```

`game_find need=sleep`:

```
What the game says serves sleep, nearest first (from the view seen at 14:02):
- a30 Sleep, Double Bed in r4 a bedroom upstairs, 9.4 m
- a40 Nap, Sofa in r3 the living room, 6.0 m
2 more choices not checked by the game yet: they are tested when you pick one.   <- only with Q1 = hybrid
```

Rules for the words:

- Need words come from a fixed table, one word per advertised need (see "Advertisements"). They say what the game
  advertises. They are not advice, and nothing ranks one choice above another except distance.
- Distances, "no way from here", in-use and broken states are volatile. They appear in Here, in look and in find
  answers. They never appear in the map, so the map stays byte-stable.
- Refs keep today's form: `a<n>` for acts (the helper's RefBook, stable for one helper session). Rooms get `r<n>`
  refs from the same RefBook, keyed by zone and room id.

## Advertisements (probe)

The game's interaction classes carry the needs they advertise:

- `interactions.base.interaction.Interaction.commodity_flags` (a class property)
- `Interaction.static_commodities` and `static_commodities_data`
- `Interaction.autonomy_ads_gen(target, include_hidden_false_ads)`
- `objects.script_object.ScriptObject.commodity_flags`: the union over an object's affordances.

Plan:

1. **Phase 0, discovery (read only, before any word table).**
   - Read the bytecode in `E:\Domus\gameapi\dis\interactions.base.interaction.txt` for `commodity_flags`,
     `static_commodities` and `_update_commodity_flags`. Confirm what they return and that a read only fills the
     game's own class cache. The D42 lesson applies: some properties add components, so check before reading.
   - Then one live session with a debug record: the distinct names of the advertised statistics across HOME's whole
     menu. The word table is written from those real names, not from guesses.
2. **The probe adds `ads` to each act row of the menu.** These are short need keys from a probe table:
   - `hunger`, `energy`, `bladder`, `hygiene`, `fun`, `social`, `comfort` (if the game has it), and `skill:<name>`;
   - an advertised statistic with no key is dropped.

   The read is per affordance class, cached by guid64 for the probe session. It costs one class-property read per
   distinct affordance, not one per object. It is not part of the act test, so it adds no test time.
3. **The probe adds `floor` to each menu object**, the R3 `_item_floor` value it already computes. The map needs a
   room's floor.

Need words shown to her (helper table): hunger → food, energy → sleep, bladder → toilet, hygiene → washing,
fun → fun, social → company, comfort → comfort, skill:X → X practice. Acts with no advertised need show no word.

Fixtures in tests are invented. No game text is committed.

## The map (helper)

The new module `domus_helper/house_map.py` holds pure functions with no I/O. They take:

- the whole menu payload of the session's zone (the merged one the view uses);
- the things list (rooms exist there before the first whole menu is in);
- the resolver and the catalogue;
- the helper's RefBook;
- her room now.

They return:

```
map: {
  rev: "<8 hex>",            # a hash of the stable fields below; it changes only when they do
  lot: "home" | "other",     # whether this is her home lot (the zone is her household's)
  rooms: [ { ref: "r2", room_id: "7", name: "the kitchen", floor: 0,
             offers: ["food", "cooking"], things: ["Fridge", "Stove", "Counter"], go: "a21" } ],
  here: "r2" | null          # her room now; volatile, so it is sent beside the map and is not part of rev
}
```

### Room names by function

The name is computed from the advertised needs of the room's objects. Each object counts once per need.

| The room's objects advertise | Name |
|---|---|
| energy (a bed) | a bedroom |
| bladder or hygiene, and no energy | the bathroom |
| hunger, with a cooking skill ad | the kitchen |
| hunger, with no cooking | the dining room |
| fun or social only | the living room |
| one skill only | the room for X practice |
| room id 0 | outside (on your lot / off your lot) |
| nothing advertised, but things in it | the room with the X (today's fallback, the first notable thing) |
| no things | not listed (a passage). Its Go-here spot is still in Here when she is in it. |

The floor is said after the name: nothing on the ground floor, "upstairs" for floor 1, "on floor N" above that, and
"in the basement" below ground.

When two rooms get the same name and floor, each adds its first notable thing that the other room lacks: "the
bedroom with the double bed" and "the bedroom with the single bed". Only if they share every notable thing do the
names get " (2)", in room id order. The articles follow the counts: "the" when the name is unique, "a" when it is not.

Notable things are at most 3 per room: the objects with the most distinct advertised needs, then the most acts, then
by name. Folded kin (W11 H1) count as one.

These names replace `reach._room_base` everywhere a room is named. That covers the options' `room`, the things list
`where`, `game_list things room=` and the place args of buy, place and move (`acts._place_args`). One naming source
means a name she reads is a name the tools accept. The tools also accept the `r` ref.

### Revision and churn

- `rev` hashes: the room ids, names, floors, offers, notable things and go refs. It leaves out distances, reach,
  in-use, states, her room and the clock.
- A whole menu that differs only in volatile fields keeps the same `rev`. Natalis then reuses the same map text, so the
  map block stays in the cache.
- A build or buy, or a sale or a move that changes a room's things or offers, makes a new `rev`. That is correct: the
  house changed.

### Before the first whole menu

The map comes from the things list. Rooms are named the same way when the things list carries ads per definition.
Until it does, it uses the fallback names and the line ends with "(what it offers comes with the game's choices)".
This replaces today's "The game has not sent its choices yet" for the far rooms. Here is shown as soon as the near
part comes, as today.

### Wire

- `map` is added to the observation body. It is optional, and an older helper does not send it.
- Natalis `wire.ts` keeps a whitelist of observation keys (line 122) and must accept `map`.
- Each option entry gains `room_ref`. Each act may carry `ads` (need words). `answers.ts` `OptionAct` already lets
  unknown fields pass. Type them anyway.

## Natalis

1. **Store.** The newest map per helper session. The map is in the observation's normalized data, and the view index
   (`view-index.ts`) finds the newest view. Nothing new is needed in the database unless a test shows the lookup is
   slow.
2. **Render Here** (`options.ts` `renderView` / `choicesBlock`):
   - With a map: her room and the near objects in full, the phone, people, queue and questions, then the one line
     "Other rooms: your home map lists them…". The other rooms' objects are not rendered.
   - Without a map (an older helper): today's rendering, unchanged.
   - `VIEW_TEXT_MAX` stays as a guard.
3. **The map block.**
   - A new optional world hook: `World.stablePart?(thread): { name, text } | undefined`. The runtime places it with
     cls `"page"` before "Recent here" (`entity/runtime.ts` near line 958). `layoutRequest` keeps the class order, so
     the map sits in the stable prefix.
   - The Domus world returns the newest map's text for any thread whose turn carries a current game view, and nothing
     for other threads.
   - The text is a pure function of `rev`, and is identical while `rev` is.
4. **`game_look room=<r ref or room name>`** answers from the newest view's options, at once. It sends no look to the
   game:
   - the room's objects with all their act refs and the act's need words;
   - distances from that view;
   - the room's no-way sentence when the game said so.

   `game_look` with no field keeps today's meaning: a fresh view from the game. If the newest view is older than 2
   minutes, the answer says so and offers the fresh look in the same words as today.
5. **New tool `game_find`.**
   - Fields: `need` (an enum of the need words) or `text` (up to 40 characters, matched case-insensitively against
     object names and act words). Exactly one of the two.
   - It answers from the newest view's options: up to 8 acts, nearest first. Objects the game sees no way to are
     listed after the others and marked.
   - Each line: act ref, act words, object, room ref and name, distance.
   - When nothing matches: "Nothing on this lot advertises <need> in the newest view." It gives no suggestion.
   - It is `safeWhenStopped`, like the other reads, and takes no act slot.
6. **`game_act`** is unchanged. A ref from a look or a find is in the newest view's table. A newer view keeps the same
   ref for the same act on the same object (RefBook), so the usual stale rules apply as they do today.
7. **Guidance.** One short paragraph in the Domus world text: what Here, the map, `game_look room` and `game_find`
   are. It must not say "if you are hungry, find food" or anything like it (`domus-no-scripted-play`).

## A faster whole build (Q1: accepted)

Most of the probe's build time is the act test (`preflight_test` / `test_super_affordance`) on far objects. A push
runs the game's own test anyway, and a refusal comes back with the game's reason (`act_rejected`).

The hybrid proposal:

- Near objects are tested on every build, as today.
- Far objects are enumerated, without the test: their user-directed acts that the guard does not exclude. They are
  written into the whole menu at once with `checked: false`. The far tests then run in the background, as today with
  the far cache, and update the acts to `checked: true` or drop them.
- She sees an unchecked act in a look or a find, marked "not checked by the game yet: it is tested when you pick it".

Effect: the first whole map arrives in seconds, not minutes. Cost: she can pick an act that the game then refuses,
with its reason. That is the game saying no, which is not a cage. Without this, W15 still works: the map shows rooms
from the things list until the whole menu is in.

## Failure modes, checked against the design

| # | Case | What happens |
|---|---|---|
| F1 | Her room unknown, or she is outside | Here shows the near objects by distance. The map marks outside. |
| F2 | Rooms with no things (halls) | Not in the map. Their spot is in Here when she stands there. |
| F3 | Two rooms with the same function | Named apart by a notable thing, else by (2). |
| F4 | Map churn from volatile facts | Kept out of `rev`. Test: the same house with a moved Sim gives the same map text. |
| F5 | Choices still pending | The map comes from the things list, with fallback names. Here comes from the near part. |
| F6 | Visiting another lot | `lot: other`. The heading says "This lot (not your home)". Her home map is not shown. |
| F7 | Several floors | Floor words in the name. "No way" stays volatile (Here, look, find). |
| F8 | Refs across sessions | RefBook per helper session, room key (zone id, room id). Needs the zone_id fix first. |
| F9 | Build/buy changes the house | A new `rev`. The block changes once and is then stable again. |
| F10 | A need nothing serves | find says so, as a fact. |
| F11 | A huge lot (more than 20 rooms) | The map shows 20 rooms, then "and N more rooms: game_look room=<name>". |
| F12 | Phone and people | Never in the map, always in Here. |
| F13 | Acts that advertise nothing (Clean, Change Outfit) | Listed without need words. find by text still finds them. |
| F14 | An advertisement does not equal relief | The words say "the game says it serves", never "it fixes". |
| F15 | Threads with no game view | No map block. Nothing changes for them. |
| F16 | Two threads, one body | Both read the same map and table. The 60 s cross-thread hold stays as it is. |
| F17 | Game questions (dialogs) | Unchanged. They come first in Here. |
| F18 | "Stuck in the bathroom" | Here names her room by its function and ref, the map marks it, and every other room is one line away. |
| F19 | An older helper or probe | No map: today's view, unchanged. The `ads` are absent: no need words, and find by need says the game sent none. |
| F20 | Map and view from different views | The look and find answers name the view time they read. The map block names its `rev`. |

## Build plan

The work comes in small parts. Each part has its own focused tests, and one deploy happens at the end.

- **P0:** Phase 0 discovery: the bytecode read and one live debug record of ad names. Write the word table.
- **P-zone:** Fix `zone_id` first. `_menu_near_part(build, zone)` and `build.payload(..., zone_id=build_zone)` pass the
  game's Zone object, but `act_menu.zone_text` takes an int, so every part goes out without `zone_id`. Pass the
  zone's id: read `id` through `tuned._plain`, as the other id reads do. Add a test for it.
- **P1:** The probe: `ads` per act (cached by guid64), `floor` per object, guards updated (`tools/check_guards.py`),
  and a version bump (2.42.0). Remember the version pins (README in 3 places, test_d10, test_d11 and others; see the
  2.41.1 bump commit a2da7ab for the full list).
- **H1:** The helper: `house_map.py` with names, `rev`, notable things and the go ref. Then `room_ref` and `ads`
  words in `acts.options`, one naming source in `reach.room_labels`, and `map` in the observation. Re-vendor
  `schema.py` from the probe.
- **N1:** Natalis: wire `map`, the Here rendering, the `stablePart` hook and its runtime placement, `game_look room`,
  `game_find` and the guidance paragraph.
- **P2:** The hybrid far build (the User said yes to Q1). Build it after P1, H1 and N1 work, as its own part.

Tests that must exist:

- The map text is byte-identical for two views that differ only in distances, her room and in-use states.
- Room names for each row of the naming table, and duplicate rooms told apart.
- A ref from `game_find` or `game_look room` is accepted by `game_act`.
- A view with a map renders no far objects. A view without one renders as today.
- The prompt prefix through the map block is byte-stable across two turns in one Recent page.
- An older helper (no `map`, no `ads`) still works.

Measures, before and after, counts only:

- View characters (p50 and p95);
- prompt tokens and cache hits on game turns (Mint ledger);
- time from load to the first map, and to the first whole menu;
- `game_look` and `game_find` calls per turn.

The live tasks for the User's session:

1. From upstairs: "go take a shower".
2. "Cook something and eat it".
3. "Find something fun to do".
4. "Go to bed".

She should do each without asking for a fresh look first.

## Questions for the User

**Answered 2026-10-13: the User accepted all five recommendations.** Q1 is yes, so the hybrid far build (P2) is in
scope.

- **Q1 (build speed):** May far acts be listed before the game has tested them? They would be marked "not checked yet"
  and tested when she picks one, so the whole map comes in seconds. The other choice is to keep testing everything
  first, as today. *Recommended: yes (hybrid).*
- **Q2 (names):** Is the naming table right: bedroom, bathroom, kitchen, dining room, living room, room for X practice,
  outside? And should duplicates be told apart by a thing in them ("the bedroom with the single bed") rather than by a
  number? *Recommended: yes to both.*
- **Q3 (where the map shows):** Should the map show only on turns that carry a game view (the game threads, and
  another thread only when it shows a view)? *Recommended: yes.*
- **Q4 (find order):** Should find list nearest first, with the rooms the game sees no way to placed last and marked?
  *Recommended: yes. Distance and "no way" are both the game's facts.*
- **Q5 (map detail):** Should each room show at most 3 notable things and no counts? *Recommended: yes. The count of
  things stays in `game_list things`.*
