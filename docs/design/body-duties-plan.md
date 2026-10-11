# Body duties: what the liberation debate found, and what we do about it

The team debated the move to a free Lar (`Ashley/_Internal/orchestra/outbox/R_LIBERATION_DEBATE_2026-10.md`, 2026-10-11)
and agreed it was right to drop the old Host's judgment, and that the body now gives too little. Opus checked the main
finding in source (any DM author reaches a full turn; recall and the note index ignore the thread) and live config
(one Discord person known so far, one room, no daily cap, sandbox on the walled internet). The summoner decided
the open questions the same evening. This plan is what follows from those decisions.

## The rule this adds

AGENTS.md keeps its test ("would a better model make this unnecessary? then it belongs to the mind") and gains a
second one beside it: **can the mind notice and correct this from inside? If not, the body owes it.** An injected
instruction, a wake loop, a spent credit, a leaked secret: she cannot see these from inside, so the body holds a gate,
a meter or a record for them. A gate is a fact or a ceiling, never a judgment about what she should do.

## Decisions (the summoner, 2026-10-11)

1. **Audience: contacts, full memory.** Only the summoner and the people the summoner names can reach her in a DM.
   Rooms stay as they are (a room the summoner opened admits its members). With a contact she keeps her whole memory
   and every tool: what she shares is hers to judge.
2. **Spend: a meter and a wake-loop limiter, no hard cap.**
3. **Sandbox: the internet stays, and the privacy check runs over everything that leaves.**
4. **No stopgap tonight.** The bot's server is trusted. The fixes ship with the next deploy.
5. **Self-forget: the words go at once, the acts stay.** The record that a tool ran, when and with what outcome
   cannot be self-forgotten. The summoner's forget reaches everywhere the words live.
6. **The Lar nature is a default** every new Lar starts with, which its summoner can replace for that Lar.
7. **Plain backups leave the vault out.** Only the sealed package holds it, and the deploy README says so truly.

## The work, in order

**B1. Contacts.** A summoner command `!contacts add <name or mention> | remove <name> | list`. A DM from anyone who
is not the summoner or a contact is not admitted: no event, no turn, one line in the body's log (no text kept). The
list lives in the Lar's folder, and the now board names the contacts. Test: a DM from a non-contact makes no row and
no turn; after `!contacts add` it does; a room member is admitted as before.

**B2. The privacy check on every exit, failing closed.**
- The same check `say` uses runs over every exit:
  - a `web_request`'s URL, headers and body;
  - a sandbox `run` command and the files it is given;
  - a picture's name.
- A hit refuses the act with the reason, as `say` does.
- A damaged or unreadable privacy list blocks every exit until it is fixed, instead of counting as empty. The
  summoner hears it once in their DM.

Tests:
- a listed term in a URL, a header and a command is refused;
- invalid `privacy.json` blocks `say`, `web_request` and `run`, and the summoner is told.

**B3. A meter and a wake-loop limiter.**
- Each turn's end row records the model, its effort and the tokens the provider reported. The now board shows the
  day's tokens (and cost, when the model's price is configured) as a fact, with no advice.
- `schedule_wake` takes at least 1 minute.
- The limiter: after 6 turns in a row woken only by her own wakes, with nothing from outside between them, her next
  self-wake fires no sooner than 15 minutes after it was set, and the receipt says so.

Tests: a mock model that always schedules a 1-minute wake gets at most 6 quick turns and then 15-minute spacing; a
turn's end row holds token counts.

**B4. Out of credit is an outage.**
- A 402 from the provider is treated as an outage, not a bad request, so the backup is tried.
- When both fail, the summoner gets one alert in their DM, not one every retry.
- The backup's provider and tier are named in the config doc, with whether it trains on her data. Opus checks the
  current backup.

Test: a faked 402 tries the backup, then sends one alert.

**B5. Forget.**
- Self-forget removes the words. A forgotten tool call or receipt row keeps its kind, tool, time and outcome, with
  "(forgotten)" for the words.
- The summoner's forget also reaches note history (git), `trash/`, the sandbox home, the picture shelf and the next
  backup rotation.

Test: a canary word gives 0 hits across the river, history, trash and home after the summoner's forget; a self-forgotten
`say` keeps its receipt's shape.

**B6. What she saw is kept.** Receipts keep their data (up to 2 KB, with a hash of the whole) in the river, so the
record shows what a tool returned. Test: turn 2 can recall turn 1's receipt text.

**B7. Honest notes.** On start, a body note says when she was last running and how long she was down. A restore
writes a note with the backup's time, and the stop keeps its state across a restore. Test: a restart after a fake gap
and a restore both show their notes; a restore with the stop on keeps it on.

**B8. A ledger without words, and an alert.** One row per turn: thread kind, outcome, model, tokens, backup used, with
no message text. After 5 failed turns in a row, the summoner gets one alert. The team (and Opus) read counts from it,
never her words. Test: a dead model address gives one alert within 10 minutes.

**B9. Say what was cut, and who is thinking.**
- A turn says when older rows were left out ("23 older messages here are not shown").
- Lines from bots and from flooded or loop-held bursts say so.
- Every turn's "who you are" names the model and effort actually serving it, game turns included.

**B10. Small truths.**
- AGENTS.md gets the second test.
- The plain backup leaves out the vault and the deploy README is corrected.
- The Lar nature becomes a default with a per-Lar replacement (an optional `nature.md` in the Lar's folder replaces
  it; an empty one removes it).
- AGENTS.md says the repository is private until its owner publishes it.

## What this plan does not do

It does not cap her spending, gate her by who woke a turn, or quarantine her forgetting: the summoner decided against
those. It does not add a per-reply honesty check. The campaign's S0 questions (consent, published error rates,
public claims) wait for their own decision; the team's public-claim limits stand until B1, B2 and B5 pass.

## How it ships

B1 to B10 are Natalis changes, built by workers in one wave with focused tests, reviewed by Opus, then one full suite
and one deploy (with the Domus N8 to D3 work that is ready by then), then the live session with the summoner.
