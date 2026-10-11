# N7: pictures (design, 2026-10-11)

N4–N5 left one thing out on purpose: "pictures are not delivered anywhere in this step (a later step gives worlds
attachments)". This is that step. A Lar can keep pictures, send them, and look at them when its model can see.

Facts that shape it:

- The Domus helper can already take a picture of the game: the listener lists requested `snapshots` in the
  `acts/sync` answer, and the helper posts a PNG (or why it could not) to `/domus/snapshot`. Natalis parses that
  route already (`src/worlds/domus/wire.ts`) and answers 404 because nothing is ever requested.
- The Discord world already shows attachments as handles (`attachment:a1`) with the URL kept by the world.
- Probed 2026-10-11: the Command Code provider drops image parts (an image request reports 28 prompt tokens and
  the model guesses). So a Lar on that provider cannot see pictures; another provider may. Seeing is a property of
  the model, declared in `entity.json`, never assumed.

## 1. The shelf (body)

`<entity>/media/`: files the Lar holds, each `<id>.<ext>` with a sidecar `<id>.json`
`{ id, mime, bytes, name, from: { world, place }, atMs }`. Ids are `m-` plus 8 base32 characters.

- Only `image/png`, `image/jpeg`, `image/gif`, `image/webp`, checked by magic bytes, at most 8 MiB each.
- The now board shows the shelf's count and size. Nothing is pruned automatically. A summoner command
  `!media` lists the newest 10, and `!media forget <id>` removes one file.
- Worlds put pictures on the shelf through a body function passed in `start` context (the same way they emit
  events), never by writing the folder themselves.
- Backups carry `media/` (allowed names `media/<id>.<ext>` and `media/<id>.json` only).

## 2. Sending: `say` with `attach`

`say` gains `attach`: up to 4 shelf ids. The World contract's `say(place, text)` gains an optional third argument
`files: Array<{ path, name, mime }>`.

- A world that can carry files (Discord) sends them with the text.
- A world that cannot refuses the whole say with a plain reason ("this place cannot carry pictures"), so the Lar
  never believes a picture went where it did not.
- An unknown id refuses the say with the list of the newest shelf ids.
- The privacy list and the scanner still read the text. Pictures are not read: what the Lar sends is its own
  choice, as with words.

## 3. Pictures in from Discord

An image attachment of up to 8 MiB on a message the Lar sees is fetched by the Discord world from Discord's own
attachment hosts only (`cdn.discordapp.com`, `media.discordapp.net`, https) and put on the shelf. The event line
names it: `[picture m-xxxxxxxx: <name>, <KB> KB]`. Other attachments keep today's handle line. A failed fetch
keeps the handle line and adds "(not kept: <reason>)".

## 4. Pictures from the game: `game_snapshot`

Domus tool `game_snapshot {}` (no arguments; what the picture is for is the Lar's own business).

- Requested against the attached helper session; refused when the game is not attached or the stop is on.
- At most one open request at a time per game thread. A new request while one is open is refused, with the open
  one's age.
- Listed in the next `acts/sync` answer as `snapshots: [{snapshot_id}]` (v1 shape).
- `/domus/snapshot` with a PNG: checked as v1 (base64, size, PNG signature, the right session, still
  requested), put on the shelf, and the request is marked taken. A body row on the game thread says "Your
  picture of the game is on your shelf as m-xxxxxxxx." and wakes the thread.
- With `failed` (`game_minimized`, `no_game_window`, `capture_failed`): a body row says it could not be
  taken, and why, and wakes the thread.
- Not taken within 10 minutes: expired, with a body row that does not wake.
- The requests live in `domus/domus.sqlite` (new table `snapshots`, schema step).

## 5. Looking: `look` (only with a seeing model)

`entity.json` `model.vision: true` (default false) offers the tool `look {id}`. It returns the picture to the
model as an image part on the next model call, once (not repeated in later context). The model port and the
contract's message content gain an image part (`{ type: "image", mime, dataBase64 }`), which the
OpenAI-compatible port sends as `image_url` with a data URL. Without `vision`, no `look` tool exists, and the
ability text says plainly: "You cannot see pictures with your current model; you can keep and send them."

## 6. What can go wrong (catalogued before building)

| Where | Failure | Answer |
|---|---|---|
| shelf | A non-image or a huge file | magic-byte check, 8 MiB cap, only four types |
| shelf | Path tricks in a name | the file name on disk is always `<id>.<ext>`; the original name is data only |
| shelf | The disk fills | the board shows count and size; the summoner can forget; no silent pruning of hers |
| say | She thinks a picture was sent where it cannot go | the whole say is refused with the reason |
| say | A stale or invented id | refused with the newest ids |
| discord | SSRF through an attachment URL | fetch only from Discord's attachment hosts over https; redirects not followed |
| discord | A picture from a contact holds something private | it is the Lar's to keep or not; the summoner can forget it |
| domus | Requests pile up while the game is away | one open at a time, 10-minute expiry, refused when not attached |
| domus | The helper posts a picture nobody asked for | v1 rules: unknown 404, not requested 409, wrong session 409 |
| domus | The stop is on | `game_snapshot` refused, like every world tool |
| look | A model without vision is sent images | `look` exists only when `vision: true` |
| look | The same picture fills every later call | sent once, on the call after `look` |
| backup | Media missing from a restore | `media/` in the manifest allow-list, round-trip tested |

## 7. As built (2026-10-11)

- `World.say(place, text, { replyTo?, files? })`: files ride in the options object beside `replyTo`.
- `World.start(emit, body)`: the body (with `keepPicture`) is the second argument; worlds that keep nothing ignore it.
- Pictures reach the model as `images` on a user message (not an array content part), so every text reader of
  `content` stays a string reader. The OpenAI-compatible port sends each as an `image_url` data URL. `look` returns
  them on its receipt; the loop strips them from the river and the tool message and sends them once, in one extra
  user message on the next call.
- The CLI and replay worlds refuse a say with pictures ("this place cannot carry pictures").
- A say's river row keeps `[picture m-…: name]` lines and `data.pictures`, so the Lar remembers what it sent.
- The emergency stop also withdraws waiting picture requests (a note that does not wake).
- Shelf ids never contain "env", because backups refuse any such name.
