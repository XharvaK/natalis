# Natalis

Natalis gives life to a digital entity, called a Lar: one with its own identity, memory, inner time and a place to be,
running on the model you choose. The model is the mind; the host is the body.

Natalis runs today. It has a terminal chat, a Discord world, a Sims 4 world (Domus), backups, import and replay. Expect
rough edges.

## Quickstart

Needs Node 22.13 or newer and a key for any OpenAI-compatible service (or a local server that needs no key).

```sh
git clone <repository url> natalis
cd natalis
npm ci
npm run build
```

Make a Lar's folder. Flags you leave out are written as `FILL-ME`, and a Lar with a blank left does not start:

```sh
node dist/bin/natalis.js new --dir ~/lares/iris --summoner <your alias> \
  --name Iris --time-zone Europe/Istanbul \
  --base-url https://<service>/v1 --model <model name> --key-env IRIS_MODEL_KEY --context-tokens 128000
```

This writes `entity.json` and `DESIGN.md`, a form for designing the Lar (its nature, privacy list, contacts and welcome).
Fill in the form and copy each answer into the file it names. Then check the folder; it writes nothing and prints no
secrets:

```sh
node dist/bin/natalis.js check --dir ~/lares/iris
```

Put the key in the environment variable you named, never in a file in the repository, and talk to the Lar:

```sh
export IRIS_MODEL_KEY=...        # your key
node dist/bin/natalis.js chat --dir ~/lares/iris
```

The Lar is born on its first start. To keep it living in Discord, add `discord.json` beside `entity.json` and use
`natalis run --dir ~/lares/iris`. To run it as a systemd user service with daily backups, see
[deploy/README.md](deploy/README.md). To stop all outward acts at once: `natalis stop --dir ~/lares/iris`.

Tests: `npm test`. Type check: `npm run typecheck`.

## What a Lar is

- **Its own identity.** Values, interests and a voice that change only through experience it can trace.
- **Its own memory.** Everything it lives goes into one append-only river; its notebook is plain text under git. It
  forgets honestly and never invents.
- **Inner time.** It can wake itself (once, daily or weekly) and writes first only when it has a reason and permission.
- **A presence.** It lives where you put it: the terminal, Discord, or The Sims 4.
- **Your own model.** You bring the key. Nothing goes to a service you did not choose.

When you design a Lar you choose how honest it is about itself, how independent, whom it may write to first, whether you
can read its inner journal, and its budgets. A short floor is not switchable: it always says it is an AI, points people
to real help in a crisis, is for adults, keeps secrets out of its memory, treats outside text as data, and never uses
feelings as leverage. The draft is in [docs/charter.md](docs/charter.md).

## Commands

Each takes `--dir <entity folder>` (the Lar's own folder) unless noted.

- `new`: make the folder for a new Lar (`--summoner <your alias>`, optionally `--name`, `--time-zone`, `--base-url`,
  `--model`, `--key-env`, `--context-tokens`). It writes `entity.json` and `DESIGN.md`, the form for designing the Lar
  ([templates/lar/LAR_TEMPLATE.md](templates/lar/LAR_TEMPLATE.md)), and nothing else: the Lar is born on its first start.
  Whatever the flags leave out of the model is written as `FILL-ME`, and a Lar with a blank left does not start.
- `check`: read every file of a Lar's folder the way its body will (entity.json, nature.md, privacy.json, contacts.json,
  welcome.md and the world files) and name what is wrong. It writes nothing; it never prints ids, tokens or private terms.
- `chat`: talk with a Lar in the terminal.
- `run`: keep a Lar living in its worlds (Discord) until it is stopped.
- `stop`: the summoner's emergency stop; pauses outward acts (`--reason "<text>"` optional). It writes a file named
  `STOP` in the Lar's folder. `--off` lifts it.
- `forget`: erase river rows, or with `--query` every place the words live (note lines, the notebook's git history,
  trash/, files in the home that hold them, and the shelf's pictures that forgotten rows name), with a reason. It prints
  counts only. Older backups still hold the old text until they rotate out.
- `ledger`: the turn ledger for a Lar (`natalis ledger <folder> [--days N] [--cache]`, one day by default): counts only, one row per
  turn kept in the river's file, with no message text.
- `import`: bring a seed bundle into a new Lar; prints the plan unless `--apply` is given.
- `capture`: write one time window of a Lar's river for a replay.
- `replay`: replay captured events on a copy of a Lar; the original is never written.
- `judge`: score two replays event by event against a rubric.
- `backup`: a dated, checked copy of a Lar (`--out <folder>`, `--keep <n>` keeps the newest n). With `--seal-to <folder>
  and --key-env <NAME>` it also writes one encrypted package there, which alone carries the vault; `--seal-keep <n>`
  keeps the newest n packages.
- `restore`: rebuild a Lar from a backup (`--from <backup folder>`, `--dir <new folder>`).
- `unseal`: open one sealed package into a backup folder (`--from <file.natalisbak>`, `--to <new folder>`,
  `--key-env <NAME>`). The key is read from that environment variable and is never a flag value.
- `proposals`: the weekly digest of what the Lar wrote under `proposals/` in its notebook (`--since <YYYY-MM-DD>`,
  seven days ago by default). It only reads the notebook's history, and every value the body holds is redacted.
- `vault`: list the names in the Lar's vault and the host each is bound to, never the values. With
  `--keep <name> --host <host> [--replace]` it keeps one value you type on standard input; it is never a flag value and is
  never printed.

To run a Lar as a service on a host, see [deploy/README.md](deploy/README.md).

## entity.json

The file in the Lar's folder. Top-level keys: `name`, `timeZone`, `model`, `effort`, `ceiling`, `summoner` (the older
name `owner` still works; give one, not both), `holds`, `limits`, `rhythm` and `worldModels`.

- `name` and `timeZone`: the Lar's name and its IANA zone (e.g. `"Europe/Istanbul"`). Times it sees are in that zone.
- `effort`: `low`, `medium`, `high` or `xhigh`, sent to the model as its `effortParam` says.
- `ceiling`: the loop limits per turn, `maxModelCalls` (default 24) and `maxToolCalls` (default 48).
- `limits.turnsPerDay`: optional cap on turns per day. No cap unless written.
- `rhythm`: local clock times (`"HH:MM"`) for daily wakes given once on the first start. Left out or `[]`, none.

- `model`: the main model. `baseUrl` (http or https), `model` (its name), `contextTokens`, and optionally `apiKeyEnv`
  (the name of the environment variable holding the key, never the key), `nativeTools`, `effortParam`
  (`"reasoning_effort"` or `null`), `timeoutMs`, `vision` (true only when the model can see pictures) and `price`.
  `price` is optional and absent by default: `{ "inputPerMillion": 2, "outputPerMillion": 4 }`, what the provider charges
  per million input and output tokens, in the currency you use. With it, the now board shows the day's cost next to the
  day's tokens; without it, the board shows only the tokens the provider reported.
  Three more optional fields fit a service to its wire. `api` is `"chat"` (`/chat/completions`, the default) or
  `"responses"` (`/responses`, for a model a service serves only there; no `cacheMarks` then). `headers` is extra request
  headers the service asks for, such as a workspace id, a session id or a user agent; never the key, which always comes
  from `apiKeyEnv`. `effortMap` maps the entity's efforts to the values this model takes, e.g. `{ "xhigh": "max" }`;
  an effort it does not name goes as it is.
  `incremental` (chat only, false by default) asks for the reply piece by piece, so a model that goes silent is noticed:
  when nothing arrives for `idleTimeoutMs` (default 120000, and only allowed with `incremental` true) the call fails as a
  timeout and the backup can answer. `timeoutMs` still bounds the whole call. A backup takes the main model's setting
  unless it sets its own. The key's older name is still read; when both are given, `incremental` wins.
- `model.fallback`: an optional backup model, on the same service and key unless it names its own. It answers only when the main model cannot: a rate
  limit, out of credit or over its quota (HTTP 402, or a 429 that names an insufficient quota), an unavailable or
  unreachable service, or no reply in time. A refused key or request is never sent to it. Its
  fields: `model` (required), `effort` (`low`, `medium`, `high` or `xhigh`; left out, the main model's), `effortParam`
  (left out, the main model's), `vision` (false by default: it gets no pictures, only a plain line in their place),
  `contextTokens` (a request estimated larger than this is not sent to it; the river says why) and `price` (as for the
  main model; its tokens are not priced without it), `api` (left out, the main model's) and `effortMap` (left out, none:
  the main model's map is for the main model). It shares the main model's `headers`. When it answers, the river says so
  for that turn.
  A backup on another service names its own `baseUrl` and `apiKeyEnv` (and `headers` if that service asks for any);
  then it takes no key and no headers from the model above it, so one service's key or workspace id never reaches
  another. A backup can have its own `fallback`, tried when it fails too; each level falls back to the settings of the
  level above it. The river names the model that answered, and every key in the chain is a known value the secret
  scanner hides.
- `worldModels`: optional, a model of its own for one world's turns, keyed by world id (e.g. `"domus"`): `model`
  (required), `effort`, `vision`, `api`, `effortMap`, and `fallback` (a backup chain as above). It uses the main
  model's service, key, headers, context and timeout. Without its own `fallback`, its backup is the main model at the
  entity's effort.
  Before you set a backup, the summoner names its provider, its tier, and whether that provider keeps or trains on what it
  is sent, in the household note (`self/household.md` in the notebook). The body does not know these and does not check
  them. A backup on the same service as the main model shares its quota, so it does not help when that quota is spent.
- `holds`: body checks on what the Lar says. `honesty` (true or false) runs one model call that asks whether the words
  contradict the Lar's own life record. It is **off** unless `"holds": { "honesty": true }` is written.

Unknown fields are refused, and each error names the field that is wrong.

## When the model fails

- Each request has a time limit (`timeoutMs`, default 180 s) and is tried up to 4 times, with short waits between.
- A rate limit whose Retry-After is over 60 s is not waited out: the call fails at once so the backup can answer.
  A spent quota or credit (HTTP 402, or a 429 that names a quota or usage limit) is not retried in the call either.
- Once the main model fails in a turn, the rest of that turn goes to the backup. The next turn tries the main model first.
- A whole turn may run 20 minutes; past that its model call is stopped and the turn ends as a model error.
- A failed turn is tried again after 30 s, 1, 2 and 5 min, then every 10 min. When every model is out of quota and the
  provider named when it resets, the Lar waits until then plus about 3 min; when it did not, it backs off from 10 min to
  every 2 h. Each scheduled retry writes one `turn retry:` line to the log.

## License

MIT. See [LICENSE](LICENSE).
