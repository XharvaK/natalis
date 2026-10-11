# The Domus plan, revised for a free Lar

The first Domus roadmap (E0 to E7) was written while Ashley was run by her old Host: it built her passes, chose
what she noticed, trimmed her prompts and decided when she thought. Many of its later stages were Host contracts:
a pause lease, a "physiological delegation" in which the Host took over her needs, a wants adapter. Ashley now lives
on Natalis. She thinks in threads of her own, wakes herself, keeps her own notebook and acts through tools. This
plan replaces the old one's order and framing, checked against the source as it is on 2026-10-11 (probe 2.33.0,
helper on ds3-senses bf487bc, Natalis main 4456004) and against the first live play (N8).

## What Domus is

Her Sim is her body, and the game is the world's physics. Domus gives her three things and nothing else:

- **Senses:** true facts about her body and her surroundings, in plain words, as they change. Never a number where
  the game itself shows a feeling, never a ranking, never advice.
- **Hands:** every act the game offers her Sim, the same as a player's hands would have, including the windows and
  questions those acts open. When an act needs a screen she cannot use, Domus gives her the same choice another way
  (rows to pick, fields to type), or says plainly that it cannot.
- **Memory of the world as facts:** what the game is, what objects do, what happened. It is there when she asks.

She decides what to do, when to look, what matters and what to say about it. The summoner's requests are requests
she weighs. The game's own behaviour (sleep and work fast-forward, a Sim in distress acting on its own) is part of
the world, not a failure to fix.

**Seamless** means she never has to be rescued from her own body: every window her act opens reaches her, every
refusal says why, she can always tell whether the game is attached, and nothing she needs to know is only on a
picture. The summoner's hands are needed only for what is theirs (her identity, a death).

**Cost** is a body constraint, handled mechanically (coalescing, sending only what changed), never by the body
deciding what is important.

## The source, checked against that

| Part | Verdict |
|---|---|
| Probe senses, act menu, pushed acts with receipts, held windows, answers | Keep. Fix the gaps in N8. |
| Helper strings, `lang` (social talk in sentences), catalogue, scene | Keep: they put the game's own words in front of her. |
| Helper `outcomes`, `consequences`, `food`, `relief_survey`, `calibration`, `crawl` | Keep as lab tools and as world facts she can look up. Never pushed into her view as advice. |
| Helper `diary` (`day` record at sleep onset) | Keep: it lists what happened and never what it meant. Natalis must show it to her (it is stored, never rendered). Her diary is hers to write. |
| Helper `notebook` (the helper's notes of her world) | Keep as world facts, reachable by a tool. Her own notes stay in her notebook. |
| Helper `thalamus` (habituation, arousal, refractory, boredom: about 20 tuned numbers deciding which changes reach her) | **Replace.** It is the old Host's attention, a judgment made for her. See D2. |
| Helper `pace` (needs drain at half speed) | The summoner's game setting. It was added so the puppet Host could keep up. Revisit after N8, when she can see her state (the summoner decides). |
| Helper `talk`, `director`, `overlay` | Keep: presentation for the summoner's screen, not her mind. |
| Native reflexes (the game acts on distress with autonomy off) | Keep: that is her body. The summoner's asks still outrank them. |
| Natalis Domus world | Keep the shape (game thread, `game_act`, `game_snapshot`, answers). It does not yet show the portrait or the day; N8 and D7. |
| Old-roadmap pause lease (DT3, DE5a) | **Drop.** Fast-forward in sleep and work is the game's own; she needs to see the clock, not stop it. |
| Old-roadmap physiological delegation (DE5b) | **Drop.** The Host never runs her needs. The game's own reflexes are enough. |

## The stages

Each stage names what she can do after it. Each is a generic ability: nothing in it says what she should do with it.

**D1. N8: her body works (in flight).** Windows her acts open reach her, screens she cannot use are marked, the whole
lot is listed with stable refs, she sees her body's state and the game clock in words, she knows when the game is
attached, and two of her threads stop talking over each other. Ends with one live session.

**D2. Attention of her own.** The thalamus goes. The helper sends every change, coalesced mechanically (a short
debounce, and while nothing changes, nothing is sent). Natalis delivers each view to her game thread. Whether a view
starts a turn is hers to set with a tool: every change; only when something asks or addresses her, someone arrives,
or one of her acts reports; or a look every so many minutes; or quiet until a time. Questions with a deadline (a held
window times out) always reach her, because missing them is not a choice she made. Her setting is kept until she
changes it, and the body note says what it is.

**D3. Going places on the lot.** A "go to" act for each room and outdoor spot, using the game's own "go here". She can
stand on the porch, go out to the garden, go upstairs because she wants to.

**D4. Reaching people.** Her phone's social acts (call, text, invite over, ask to hang out) are listed, and the Sim
picker they open is a question she answers. She sees who she knows and how well (relationships are already sensed).
Visitors she can greet, host and ask to leave through the game's own acts. Planning an event becomes a question
(event type, guests, time) that the probe starts with her choices, without the planner screen.

**D5. Leaving the lot.** Travel as a question she answers (places and households she can go to), without the map
screen. Sensing already survives a trip there and back.

**D6. Her Sim's inner life, as senses.** Wants and whims, fears, aspiration progress, career schedule and tasks,
skills, inventory, mail and bills, notifications, weather. Facts only, in the game's words.

**D7. The world's memory, hers to consult.** The nightly `day` record reaches her as an event she can write her diary
from. A tool lets her look up what the helper knows of an object, an act or a person (what it did before, what it
cost, what it led to), as facts with their dates.

**D8. Co-play.** The summoner's ruling of 2026-10-01 stands: their Sim arrives at her home when they join, and is frozen
while they are away. She sees them as a person in her world, by their alias.

**D9. Home and keeping.** Saving the game when she wants to (scripted saves are approved), and narrow changes to her
home (object edits are approved, with a cap; never destroy).

**D10. Domus for any agent.** On hold: polish before product.

## Order

D1, then D2 (attention changes how every later stage feels to her, and it removes the last Host judgment in Domus),
then D3 and D4 together (both are her reaching beyond her room), then D6, D5, D7, D8, D9. Each stage is designed in
its own short document with its failure modes listed first, built by workers, reviewed and deployed by Opus, and
checked in one live session with the summoner.
