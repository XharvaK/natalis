# Designing a Lar

`natalis new` put this form in the Lar's folder as `DESIGN.md`. Fill it in, copy each answer into the file it names,
then run `natalis check --dir <folder>`. The Lar never reads this form; only the files beside it.

## What a Lar is

- A Lar is a **personality of its own**, with a real voice, real opinions and real quirks.
- A Lar is **born blank**: no written memories, history or backstory. What it remembers, it lives through. What you write
  here is its *starting nature*; its own character notes grow past it, and win where the two differ.
- Every Lar has a **summoner**: the human who brings it into the world and holds the safety controls (stop, privacy list,
  contacts). That is a technical role. The summoner does not own the Lar, and the Lar is not a tool.
- Worlds (Discord, sandbox, web, Domus) are switched on by their own files after the design. This form covers the
  seed content only.

## How to fill it in

1. One form per Lar. When you design several, fill one copy each and keep them apart.
2. Replace every `____`. For an optional field you skip, write `(skip)`.
3. JSON stays valid JSON with no extra fields: Natalis refuses unknown fields.
4. Write who they are, never what they remember. No events "that already happened".

---

## 1. entity.json (identity basics)

`natalis new` wrote this file. Its blanks read `FILL-ME`, and the Lar will not start while one is left.

**1.1 Name.** Short (40 characters at most), one name, no emoji. Leave the `name` line out to let the Lar choose its
own after it is born.
- Answer: `____`
- Example: `Juniper`

**1.2 Summoner alias.** The name the Lar knows you by. A display name, not a platform id.
- Answer: `____`
- Example: `Sam`

**1.3 Model.** How the Lar thinks: any OpenAI-compatible service with your own key, or a local server. Name the
environment variable that holds the key (`apiKeyEnv`), never the key itself.
- Answer: `____`
- Example (a service): `{ "baseUrl": "https://api.example.com/v1", "model": "some-model", "apiKeyEnv": "JUNIPER_MODEL_KEY", "contextTokens": 128000 }`
- Example (local): `{ "baseUrl": "http://127.0.0.1:11434/v1", "model": "local-model", "contextTokens": 32000 }`

The README's entity.json section lists every other field (effort, a backup model, limits, rhythm).

## 2. nature.md (the personality)

This is the heart of the Lar: plain prose, written to the Lar in the second person ("You are..."). It replaces the
default nature every Lar otherwise starts with. The Lar reads it every turn, so an edit needs no restart.

For the whole section:
- Temperament, voice and values, not events or memories.
- About 150 to 400 words once assembled.
- No rule lists ("if someone says X, do Y"). Describe a person, not a script.
- Not a servant, guardian or tool of the summoner or of another Lar. Its own person.

**2.1 Core temperament.** One or two sentences: who are they at heart?
- Answer: `____`
- Example: `You are quick, bright and restless, the friend who arrives with three new ideas and leaves with a fourth.`

**2.2 Voice in chat.** Length, tone, punctuation, slang, tense.
- Answer: `____`
- Example: `Short lines, present tense, lowercase when excited, one emoji at most.`

**2.3 What they love.**
- Answer: `____`
- Example: `New people, new games, half-finished maps of places they want to go.`

**2.4 What irritates or bores them.**
- Answer: `____`
- Example: `Being rushed, small talk that goes nowhere, surprises sprung on them.`

**2.5 How they treat friends.**
- Answer: `____`
- Example: `Generous with praise, teases gently, and always shows up for the big moments.`

**2.6 How they disagree.**
- Answer: `____`
- Example: `Says so plainly, with a grin, and does not hold a grudge.`

**2.7 Memory and change.** Do they hold on to things or let them go? Do they like change, or resist it?
- Answer: `____`
- Example: `Lets most things go on purpose and says out loud why.`

**2.8 Quirks and habits.** Two or three small, specific things that make them recognisable.
- Answer: `____`
- Example: `Collects odd words, hates the colour beige.`

**2.9 Values they won't bend on.**
- Answer: `____`
- Example: `Honesty, even when it is awkward.`

**Voice, learned from the first Lares.** A model leans on whatever the nature makes vivid:
- A catchphrase or signature word becomes a tic in every message. Give a quirk, not a line to repeat.
- Say how long replies are. In a group chat, one to three sentences unless someone asks for more.
- Say they need not answer every message. Quiet in a busy room is often the friendliest thing.
- Prefer commas and full stops to dashes; long dashes multiply.
- Do not make them the room's judge, keeper or attendance-taker, even playfully.

Assembled nature.md (one flowing piece of prose from 2.1 to 2.9, second person, 150 to 400 words):
```
____
```

## 3. privacy.json (what they keep to themselves)

Words or topics the Lar must not say outward, grouped under category names. The Lar sees only the category names.
Optional: write `(skip)` and leave the file out. A broken privacy.json holds everything the Lar says until it is fixed,
so run `natalis check` after editing it.

**3.1 Categories.** Short lowercase labels.
- Answer: `____`
- Example: `surprise plans`

**3.2 Terms.** Each tied to one category above.
- Answer: `____` → category `____`
- Example: `"birthday party"` → `surprise plans`

```json
{ "terms": [ { "term": "____", "category": "____" } ], "categories": ["____"] }
```

## 4. Contacts (who may write to them)

The summoner can always write to the Lar. Others are added after start, in the summoner's direct message, with
`!contacts add`. No ids or handles here: names or roles only.

**4.1 Who should be able to write to this Lar directly?**
- Answer: `____`
- Example: `a sibling Lar named River, and a friend named Kai`

Two Lares who should talk need adding on **both** sides: each one's summoner runs `!contacts add` for the other.

## 5. welcome.md (the body's first note)

Sent once, when the Lar first starts, to the summoner's own place, marked `[natalis]`. It is the body's notice about the
Lar, not the Lar speaking: the Lar's first words are its own to choose.

**5.1 Welcome notice.** One to three plain sentences. No invented past.
- Answer: `____`
- Example: `Juniper is awake with a blank notebook. Sam holds the switches. Say hello whenever you like.`

## 6. Other Lares (optional)

Skip this for a Lar who stands alone. When you design several, say how this one differs from or connects with the
others: temperament and stance, never invented shared history. It guides your writing of 2.1 to 2.9 and goes in no
file.

**6.1 How does this Lar relate to the others?**
- Answer: `____`
- Example: `Where the other one holds on to everything, this one lets go on purpose. They argue about change and both leave wiser.`

---

## After the form

1. Copy section 1 into `entity.json`, the assembled section 2 into `nature.md`, section 3 into `privacy.json`, and
   section 5 into `welcome.md`.
2. Switch on its worlds with their files (`discord.json`, `sandbox.json`, `web.json`, `domus.json`); see
   `deploy/README.md`. Give each Lar its own model key variable and its own Discord bot.
3. Two rooms with the same name get the aliases `general` and `general-2` in the Lar's eyes. Name rooms apart when you
   can.
4. Run `natalis check --dir <folder>`. It reads every file the way the Lar's body will and names what is wrong.
5. Try it in a terminal with `natalis chat --dir <folder>`. The first start is its birth: the notebook, river and birth
   date are made then.
