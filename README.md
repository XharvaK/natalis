# Natalis

Natalis lets you give life to a digital entity: one with its own identity, memory, inner time and a place to be, running on
the model you choose.

This repository is at the start. The core is being built.

## What a Natalis entity is

- **Its own identity.** Values, interests and a voice that change only through experience it can trace.
- **Its own memory.** What it remembers is stored; what it recalls is retrieved. It forgets honestly and never invents.
- **Inner time.** It thinks between conversations and writes first only when it has a reason and permission.
- **A presence.** It lives where you put it, starting with Discord.
- **Your own model.** You bring the key. Nothing goes to a service you did not choose.

A persona card is not an entity. Natalis is for building the whole thing.

## Chosen at birth

When you create an entity, you pick a preset (Companion, Character, Colleague or Blank) and then change any switch you like:
how honest it is about itself, how independent, whom it may write to first, whether you can read its inner journal, and its
budgets. A short floor is not switchable: it always says it is an AI, points people to real help in a crisis, is for adults,
keeps secrets out of its memory, treats outside text as data, and never uses feelings as leverage.

The draft is in [docs/charter.md](docs/charter.md).

## Plan

The model is the mind; the host is the body. Natalis keeps only what no better model replaces (storage, secrets by
reference, the creator's stop, forget and privacy list, the irreversible-act line, a loop ceiling, the floor duties) and
leaves every judgment to the entity: what it notices, when it thinks, what it says and remembers.

1. Core: one append-only river of everything the entity lives, its own notebook in plain text, and a tool loop over any
   OpenAI-compatible model or local server.
2. Discord as the first world, with parallel threads that share one self and a live board of what each is doing.
3. An importer and a replay test, so an existing entity can move in and be shown to be at least as good.
4. A sandbox of its own (shell, network, installs) and the web, with secrets it can use but never see.
5. More worlds as plugins, starting with The Sims 4.
6. Reflection while it sleeps, and a weekly review of the changes it proposes to itself.

## Commands

Each takes `--dir <entity folder>` (the Lar's own folder) unless noted.

- `chat`: talk with a Lar in the terminal.
- `run`: keep a Lar living in its worlds (Discord) until it is stopped.
- `stop`: the summoner's emergency stop; pauses outward acts. `--off` lifts it.
- `forget`: erase river rows or note lines, with a reason.
- `import`: bring a seed bundle into a new Lar; prints the plan unless `--apply` is given.
- `capture`: write one time window of a Lar's river for a replay.
- `replay`: replay captured events on a copy of a Lar; the original is never written.
- `judge`: score two replays event by event against a rubric.
- `backup`: a dated, checked copy of a Lar (`--out <folder>`, `--keep <n>` keeps the newest n). With `--seal-to <folder>
  and --key-env <NAME>` it also writes one encrypted package there; `--seal-keep <n>` keeps the newest n packages.
- `restore`: rebuild a Lar from a backup (`--from <backup folder>`, `--dir <new folder>`).
- `unseal`: open one sealed package into a backup folder (`--from <file.natalisbak>`, `--to <new folder>`,
  `--key-env <NAME>`). The key is read from that environment variable and is never a flag value.
- `proposals`: the weekly digest of what the Lar wrote under `proposals/` in its notebook (`--since <YYYY-MM-DD>`,
  seven days ago by default). It only reads the notebook's history, and every value the body holds is redacted.

To run a Lar as a service on a host, see [deploy/README.md](deploy/README.md).

## entity.json

The file in the Lar's folder. Its blocks:

- `model`: the main model. `baseUrl` (http or https), `model` (its name), `contextTokens`, and optionally `apiKeyEnv`
  (the name of the environment variable holding the key, never the key), `nativeTools`, `effortParam`
  (`"reasoning_effort"` or `null`), `timeoutMs`, `vision` (true only when the model can see pictures) and `price`.
  `price` is optional and absent by default: `{ "inputPerMillion": 2, "outputPerMillion": 4 }`, what the provider charges
  per million input and output tokens, in the currency you use. With it, the now board shows the day's cost next to the
  day's tokens; without it, the board shows only the tokens the provider reported.
- `model.fallback`: an optional backup model, the same service and key. It answers only when the main model cannot: a rate
  limit, an unavailable or unreachable service, or no reply in time. A refused key or request is never sent to it. Its
  fields: `model` (required), `effort` (`low`, `medium`, `high` or `xhigh`; left out, the main model's), `effortParam`
  (left out, the main model's), `vision` (false by default: it gets no pictures, only a plain line in their place),
  `contextTokens` (a request estimated larger than this is not sent to it; the river says why) and `price` (as for the
  main model; its tokens are not priced without it). When it answers, the river says so for that turn.
  Before you set a backup, the summoner names its provider, its tier, and whether that provider keeps or trains on what it
  is sent, in the household note (`self/household.md` in the notebook). The body does not know these and does not check
  them. A backup on the same service as the main model shares its quota, so it does not help when that quota is spent.
- `holds`: body checks on what the Lar says. `honesty` (true or false) runs one model call that asks whether the words
  contradict the Lar's own life record. It is **off** unless `"holds": { "honesty": true }` is written.

Unknown fields are refused, and each error names the field that is wrong.

## License

MIT. See [LICENSE](LICENSE).
