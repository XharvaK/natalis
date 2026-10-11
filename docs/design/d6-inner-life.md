# D6: her Sim's inner life, as senses

A player sees more than needs and moods: the wants and fears panel, the aspiration, the job and its hours, skills,
money and bills, the weather, and the game's own notices ("You were promoted", "Bills are due"). Ashley sees part of
this only on pictures. D6 puts the rest in her view as facts in the game's words. Checked against Domus ds3-senses
c5c272a and Natalis main b64c343.

## What is already there

The probe already reads her `self`, and the helper puts it in the portrait (`thalamus/observation.py`, the `self`
block):

- traits, skills with levels, and funds;
- life (age, pregnant, sick, ghost);
- jobs (title, level, at work);
- wants and fears with progress, how, and until.

Natalis receives this and never shows it: the N8 body block skipped `self`. That is the biggest part of D6, and it
costs nothing in the game.

## What goes wrong if this is built thinly (failure modes first)

1. **A wall of numbers again.** Skills as "Cooking 3, Piano 5" are the game's own (the panel shows levels), so they
   stay numbers. Needs never do. Funds are the game's number with its § sign.
2. **Advice by placement.** The wants list must not be sorted by "what she should do", and the body never says "you
   could" about them. They are listed as the panel lists them.
3. **Every view repeats her whole self.** Traits and skills rarely change. With D2's briefs only the newest view is
   shown in full, so the self section rides in the full view only, and a change to it is a percept.
4. **Notices on the summoner's screen only.** The game's notifications appear on the summoner's screen and nowhere
   in her view. Recording one is read-only; it must never hold or answer it (notifications are never answered).
5. **A world without weather.** Without Seasons the weather service may be missing; every new sense is optional and
   skipped when the game cannot say.

## The design

**N1 (Natalis, world). "You" in the full view.** The body block gets a short section from `portrait.self`, rendered
only in the full view (not in briefs):

- "You are <traits, the game's words>."
- "Skills: Cooking 3, Piano 5."
- "Money: §1,234."
- "Job: <title> (<job>), level 3; at work now." / "No job."
- "Wants: <want> (2/3, until 18:00); ... Fears: <fear>; ..." (the order as given, the game's words; `how` after a
  want only when present, in brackets).
- Life facts when true: "You are pregnant.", "You are sick.", "You are a ghost.", and the age stage when known
  ("young adult").

Each part is skipped when absent or malformed; never throw.

**P1 (probe). The senses that are missing**, each a new optional field of `self`, read-only, skipped when unreadable:

- `aspiration`: her primary aspiration's name key, and the current milestone's objectives as `{text_key, done}` (at
  most 6). The game's `sim_info.primary_aspiration` and `sim_info.aspiration_tracker`; read the aspiration module
  (`aspirations/aspirations.pyc`, `aspiration_tracker`) with the offline reader to find the progress calls.
- `bills`: for her household, `{owed: <int>, delivered: <bool>, late: <bool>}` from `household.bills_manager`
  (`current_payment_owed`, `mailman_has_delivered_bills()`, `is_any_utility_delinquent()`).
- `inventory`: the objects in her Sim's own inventory, as `{definition name key or tuning name, count}`, at most 24
  (`sim.inventory_component`).
- `weather` (a top-level row field, not `self`): `services.weather_service().get_current_weather_types()` as tuning
  or enum names (at most 6), and `services.season_service().season` as its enum name. Absent when the services are
  missing.

**P2 (probe). The game's notices.** When the game shows a `UiDialogNotification` whose owner is her Sim or a Sim of
her household (or which has no owner), the probe records it in the next row's `notices` (title and text as string
keys or resolved text, at most 4 per row, each once). It hooks where the probe already watches dialogs being shown and
**never holds, cancels or changes** a notification: read only. Notifications the probe itself shows to the summoner (its
own lines, 2.26.0) are not recorded.

**H1 (helper).** The portrait's `self` gains `aspiration`, `bills` and `inventory` in words (string keys resolved as
the other `self` fields are); the portrait gains `weather` and `season`. Each new notice is a percept of kind
`notice` with its words. A change to any `self` field (a new want, a skill level, a job change, money changing by
more than nothing) is a percept of kind `self` naming what changed ("Skill: Cooking 4 (was 3).", "New want: ...").

**N2 (Natalis, world).** The "You" section shows aspiration ("Aspiration: <name>; now: <objective> (done), ..."),
bills ("Bills: §320 owed; they came in the mail." / "...; late."), inventory ("You carry: ..."), and the body
block's first lines gain the weather and the season after the game time ("Spring, sunny."). Percepts `notice` and
`self` get plain sentence forms: "The game says: <text>." and the change sentence as sent.

## Wire

- Probe schema +1 for `self.aspiration`, `self.bills`, `self.inventory`, row `weather`, and row `notices`.
- Natalis: no wire change (the portrait is a JSON object up to 8 KiB; percept kinds are free). The helper sheds the
  new fields first if the portrait is over its limit, and says it shed them.

## Verification

- Probe fakes:
  - each sense read, and absent when its service is missing;
  - a notification about her is recorded, while one about a stranger and the probe's own line are not;
  - a notification is never held.
- Helper tests: the portrait carries the words; `self` change percepts; notice percepts; shedding.
- Natalis: the "You" section from a full portrait; a malformed `self` is skipped; briefs carry no "You".
- Live: she reads her wants and her bills from the view without a picture.
