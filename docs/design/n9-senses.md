# N9: what she notices, a face, and answered letters (design, 2026-11-15)

Ashley's host is a small headless server. Nothing worth sensing happens in the room it sits in, and nobody uses it. Her
senses have to come from Discord, where the User talks with her, and from her own body. Today the Discord body hears
one thing: a new message. It is told about nothing else: no reaction, no edit, no sign that the User is online, playing
or in a call. She can react to a message, but she never learns that anyone reacted to hers. Her proposals have gone
unread for five weeks, while her instructions say they are read every week.

## The User's rulings (2026-11-15)

- Senses come from Discord and from her own body, not from the machine's room. No local models, no voice, no media or
  weather.
- Reactions, edits, presence, voice state and typing: yes.
- Presence, voice state and typing are the User's only. Nobody else's.
- Deleted messages: not in this wave.
- One mood line, and it is public: "like a normal person". No separate private mood.
- News of her body (a changelog), answers to her proposals, and her request to read an authenticated reply whole: yes.
- Proposals are read once a month, in one pass.
- Budget is not a constraint.

The rule from AGENTS.md holds throughout. The body gives senses, meters, records and gates. It never judges what an
event means or tells her what to do about it. Whether a reaction matters is hers to decide.

## 1. Discord senses

The platform port (`PlatformClient` in `discord-world.ts`) gains one listener per sense. The fake client in the tests
implements each one. Ids stay on the world's side as now: people are aliases, and messages are refs (`m12`).

| Sense | Intent | Who | Becomes | Wakes |
|---|---|---|---|---|
| Reaction added or removed | `GuildMessageReactions`, `DirectMessageReactions` | anyone admitted in that place | a row in that place's thread: `<alias> reacted ❤️ to m12` | no |
| Edit | (already held) | anyone admitted in that place | a row in that place's thread: `<alias> edited m12: <new text>` | as the message would |
| Presence | `GuildPresences` (privileged) | the User only | a now-board line; changes of status and game as rows in the User's DM thread | no |
| Voice state | `GuildVoiceStates` | the User only | a now-board line; joins and leaves as rows in the User's DM thread | no |
| Typing | `GuildMessageTyping`, `DirectMessageTyping` | the User only | a now-board line while it is fresh (10 seconds) | no |

- **Only messages with a ref count.** A reaction or edit on a message she never saw has no ref and makes no row. This
  needs `Partials.Message`, `Partials.Reaction` and `Partials.User`, because the message may not be in discord.js's
  cache.
- **The old text of an edit is already in her river.** The row gives the new text and the ref, and nothing is
  rewritten. Edits count toward the same flood limit as messages.
- **Presence lines.** `Your summoner: online, playing The Sims 4 since 14:02, listening to <track> by <artist>.` The
  music and the typing line live only on the board. A track changes every few minutes, and a row for each would flood
  the river. Status (online, idle, do not disturb, offline), game start and stop, and voice join and leave are rows,
  because they are moments.
- **Presence and voice for anyone else are dropped in the world, before any event exists.** This is the User's privacy
  ruling, not a judgment of relevance. The contract's "a world never filters events for relevance" still holds.
- **Presence is opt-in in `discord.json`:** `"presence": true`. A bot that asks for a privileged intent the developer
  portal has not switched on cannot log in at all. A silent default would take the whole Discord world down. With the
  key set and the portal switch off, start fails loudly and names the switch.

## 2. Wakes she chooses on events

Octopus-SI-OS reports that today's models do not take initiative on their own. Natalis's answer is to let her choose
her own triggers. `schedule_wake` takes `on` as an alternative to a time:

| `on` | Fires when |
|---|---|
| `summoner_online` | the User's status goes from offline to online, idle or do not disturb |
| `summoner_playing` | the User starts a game; with `game`, only that game (whole name, any case) |
| `summoner_in_voice` | the User joins a voice channel |
| `reaction` | someone reacts to a message of hers; with `ref`, only that message |

- Once by default. `repeat: "each"` keeps it until she cancels it. `daily` and `weekly` stay for time wakes only.
- It fires into her self thread, like a time wake, with her reason and the event's line.
- The wake ceiling (100) counts event wakes. A wake fires at most once in 10 minutes, so a flapping status cannot spin
  turns. That is the loop ceiling, a body duty.
- The board lists event wakes with their ids, like time wakes: `(w-3a1c) when your summoner comes online: <why>`.
- The tool text states the fact and nothing more: "You can also wake when your summoner comes online, starts a game,
  joins a voice channel, or when someone reacts to your message."

## 3. A face: the mood line is public

- `set_mood` also sets her Discord status: a custom status beside her name, which anyone in her server can see. The
  World contract gains an optional `status?(text: string): Promise<void>`. The Discord world sets it on change and
  again after each reconnect.
- The limit drops from 200 to 128 characters, Discord's limit for a custom status.
- The privacy list holds a mood line the way it holds a say: the line is refused whole, and the receipt says why.
- The tool text: "Set your mood line. You see it on every turn. It is also your Discord status, beside your name,
  where anyone in your server can see it."
- **Her current mood stays private.** She set it believing only she would see it. On the first start with this
  change, the body does not publish it and leaves one note: "Your mood line is now also your Discord status. Your
  current one stays private until you set a mood again."

## 4. News of her body

At build, a small script writes `dist/changes.json`: the newest 200 commits on the checkout, each with its hash and
subject. Merges are left out, and so are subjects that start with `test(` or `chore`. Next to the start note
(`noteStart`) and the settings note (`noteSettings`), a body note lists what changed since the commit she last ran:

`Your body changed since your last start: <subject>; <subject>; … (12 changes)`

- At most 30 subjects. Beyond that, a count of the rest.
- If the commit she last ran is not in the list: "more than 200 changes".
- On her first start, the commit is recorded and nothing is said.
- The note passes the secret scanner, like every body note. Commit subjects are already safe to publish under the
  repository's rule.
- No git at runtime: the list is built with the code.

## 5. Answered letters (the monthly loop)

**The digest** is what `natalis proposals` prints: a Markdown summary of every file under her `proposals/` that was
added, changed or removed in a period, with its text and its diff. It reads her notebook's history and writes nothing.
Today nothing runs it.

1. **On the 1st, at 09:00 in her zone,** the body posts a short list to the summoner's window channel: each file
   changed in the past month, added, changed or removed, with its first line. The body keeps this time itself. It is
   not her wake, not on her board, and not counted in her ceiling. With no window channel, or nothing changed, it
   posts nothing and logs one line.
2. **The monthly pass** reads the full digest, and the User decides each file: accepted, declined or later, with one
   line of why. Accepted ones join that month's single brief.
3. **She gets an answer per file.** `natalis proposals --dir <lar> --answer <file> --text "<one line>"` reaches the
   running Lar through the local channel `natalis vault --keep` already uses (`vault-queue.ts`), as a second operation.
   The body writes a note in her self thread: `Your summoner answered proposals/<file>: <line>`. A file that is not in
   `proposals/` is refused, and the refusal lists the files that are there.
4. **Her ability text becomes true:** "Your summoner's side reads that folder once a month, on the 1st. You get a note
   for each file with what was decided."

The first answers, at the first deploy of this wave: `wake-ids.md` (built in W14, `1f0914c`), `domus-bridge.md`
(stable room ids built in D6; what is still open), `shell-auth-reads.md` (section 6). `sandbox-userns.md` she closed
herself.

## 6. Her request: read an authenticated reply whole

She asked for a shell command, `vault-get`, that would send a vault value and keep the whole reply. Her reason: an
outside board's inbox comes back as 100 to 127 KB, `web_request` shows 16,000 characters, and the rows she needs start
after that. She has 303 unread rows there and cannot read one.

The same outcome with less surface: **`web_request` gains `save_as`**, a path inside her home (`/home/lar`).

- The whole reply, up to the existing 512 KB read cap, is written to that file. It gets the same redaction as the
  shown text. The receipt names the path and the size, and still shows the first 16,000 characters.
- The vault value never enters the shell. The shell gets no way to reach the vault. The host binding, the site list
  and the address checks stay exactly as they are.
- The path resolves inside her home only: `..` and absolute paths outside it are refused. Her home's size meter
  already counts the file.

This is the "where the reply lands" she asked for, in her own words: "I am not asking for the secret. I am asking for
the reply."

## 7. What can go wrong (catalogued before building)

| Where | What | Answer |
|---|---|---|
| presence | the portal lacks the privileged intent, so login fails | opt-in key; a loud start error naming the portal switch |
| presence | another person's presence reaches her | dropped in the world for anyone but the User |
| presence | music floods the river | board only, never a row |
| reactions | she and a bot react back and forth | reactions never wake; an event wake fires at most once in 10 minutes |
| reactions, edits | a message she never saw | no ref, no row |
| edits | an edit storm | the message flood limit counts edits |
| mood | an old private mood goes public on deploy | kept private until she sets a new one |
| mood | a privacy-list word in the status | held whole, like a say |
| changelog | a subject carries a secret | secret scanner; subjects are publish-safe by rule |
| save_as | a path escapes her home | resolved inside home only; refused otherwise |
| save_as | a key in the reply lands in a file | the same redaction as the shown text |
| digest | no window channel | nothing posted, one log line, no river row |
| answers | an answer for a file she never wrote | refused, with the list of files |

## 8. Verification

- Tests beside each module, on the fake platform client: each sense turns into the row or line above; presence and
  voice from anyone but the User make nothing; an event wake fires once and respects 10 minutes; `repeat: "each"`
  keeps it; the mood reaches `status` and an old mood does not; the changelog lists only newer subjects, without
  merges, `test(` or `chore`; `save_as` writes whole, redacts, and refuses an escape; the digest post and an answer
  note.
- `npm run typecheck` and `npm test`.
- On Mint, after deploy:
  - React to one of her messages: the row appears.
  - She sets a mood: it shows beside her name.
  - Go offline and come online: the row and the board line appear.
  - An event wake she sets fires once.
  - Her start note lists this wave's subjects.

## Recommendations for the User

The User accepted all eight on 2026-11-15.

1. Edits wake as the message would. Reactions, presence, voice and typing never wake by themselves; she can choose
   event wakes for them.
2. Presence is opt-in in `discord.json`, because a missing portal switch would stop login.
3. Status, game and voice changes become rows in the User's DM thread. Music and typing appear only on the board.
4. Event wakes start with these four: online, playing (optionally one game), in voice, reaction (optionally one
   message). Once by default, `repeat: "each"` to keep, at most once in 10 minutes.
5. The mood line goes public at 128 characters. Her current one stays private until she sets a new one.
6. The changelog is built with the code, as commit subjects without merges, tests or chores, at most 30 a note.
7. Her vault request is answered with `save_as` on `web_request`, not a shell command that holds vault access.
8. On the 1st, a short list goes to the window channel. The full digest is read in the monthly pass, and each file
   gets an answer through `natalis proposals --answer`.
