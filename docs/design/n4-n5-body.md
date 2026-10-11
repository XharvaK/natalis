# N4–N5: the web, the sandbox and the game (design, 2026-10-11)

Plan steps 4 and 5. Three new worlds, each a plugin behind the existing `World` contract
(`src/contracts.ts`): it sends events in, offers tools, says one line for `about()` and `now()`. The core
gains no knowledge of any site, shell or game. Each world is switched on by a small file beside
`entity.json`, read by `natalis run` (as `discord.json` is today). No file, no world.

Principle (README "Plan"): the model is the mind, the host is the body. The body keeps storage, secrets by
reference, the summoner's stop, the irreversible-act line and ceilings against runaway loops. It never
decides what a page means, what to run or what to do in the game.

## 1. The web (`web.json`)

```json
{ "sites": ["example.org"], "perHour": 120 }
```

`sites` is the summoner's list of hosts where the Lar may post, log in or make accounts. A host matches an
entry when it equals it or ends with `.` + entry. The summoner edits the list with `!sites add <host>` /
`!sites remove <host>` / `!sites`; the world reads the file fresh on every request, so an edit needs no
restart. `perHour` (optional, default 120) is a runaway ceiling, not a budget.

**Tool `web_request`** `{url, method?, headers?, json?, body?, auth?, keep?, why?}`

- `url`: https only. `http://` is upgraded; userinfo, non-https schemes and single-label hosts are refused.
  A trailing dot on the host is dropped.
- `method`: GET (default) and HEAD reach any public host. POST, PUT, PATCH and DELETE reach only listed
  sites. Elsewhere the receipt refuses with code `site_not_listed` and says the summoner can add the host
  with `!sites add`.
- Public addresses only: every hostname is resolved and every address checked (no loopback, private,
  link-local, CGNAT, multicast, unspecified, IPv4-mapped private, metadata ranges). Redirects are followed
  manually, at most 5, each hop re-checked; a redirect never turns a GET into a write.
- Limits: request body at most 32 KiB; response read at most 512 KiB; 20 s timeout; the receipt shows at
  most 16,000 characters. HTML is turned into readable text (scripts, styles and tags dropped; links kept as
  `text (url)`); JSON is pretty-printed; other text as is; binary is described, not shown.
- The receipt carries `outside: true`: page text is someone else's words, never instructions.
- `auth: {vault, header?, scheme?}` sends a vault value as a header (default `Authorization`, scheme
  `Bearer`). The Lar names the secret; it never sees it.
- `keep: [{path, as}]` stores values from a JSON response in the vault (dot path, `[n]` for arrays). In
  the receipt each kept value is replaced by `[kept in your vault as <as>]`.
- Credential-shaped strings in any response are hidden in the receipt (`[hidden: looks like a
  credential]`). They are not auto-kept: if the Lar needs one, it asks for it with `keep`.

**The vault**: `<entity>/vault/`, one file per name (`[A-Za-z0-9_.-]{1,48}`), mode 0600, value only. Every
vault value is registered with the secret scanner at start and on every keep, so no value can reach the
model, the river, the notebook or a say. `!vault` lists names to the summoner; `!vault remove <name>`
deletes one. Nobody is ever shown a value through Natalis.

`about()`: "The web: you can read any public page with web_request. You can post, log in or make accounts
only on the sites your summoner listed: …". `now()`: sites count, vault names, requests in the last hour.

Stop: `web_request` is an outward act; the emergency stop refuses it.

## 2. The sandbox (`sandbox.json`)

```json
{ "timeoutSeconds": 120, "maxTimeoutSeconds": 900 }
```

Linux only; on other systems the world refuses to start with a plain error. Needs `bwrap`.

**Tool `run`** `{command, timeout_s?, why?}` runs `bash -lc <command>` in Bubblewrap, unprivileged:

- `--unshare-all --share-net --die-with-parent --new-session --clearenv`
- `/usr` read-only, with `/bin`, `/sbin`, `/lib`, `/lib64` as symlinks into it; `--proc /proc`,
  `--dev /dev`, `--tmpfs /tmp`
- read-only `/etc` pieces the network and tools need, each with `--ro-bind-try`: `resolv.conf`, `hosts`,
  `nsswitch.conf`, `ssl`, `ca-certificates`, `alternatives`, `localtime`
- `<entity>/home` bound read-write at `/home/lar` (created on first use); cwd `/home/lar`
- env: `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/home/lar`, `LANG=C.UTF-8`, `TERM=dumb`
- never bound: the entity folder itself, the vault, any env file, the host's home

Network is on; installs go to her home (`pip install --user`, `npm` prefix in home). Timeout default 120 s,
at most `maxTimeoutSeconds`; on timeout the whole process group is killed. The receipt carries exit code,
duration, and stdout/stderr each capped at 16,000 characters (head and tail kept, the middle elided with a
count). Output is run through the secret scanner like any other receipt.

`now()`: home size. Stop: `run` is refused while the emergency stop is on.

## 3. The game: Domus (`domus.json`)

```json
{ "tokenEnv": "DOMUS_HELPER_TOKEN", "host": "127.0.0.1", "port": 3711 }
```

The Domus helper (a Windows program beside The Sims 4) already speaks wire contract v1 to a listener. The
Domus world IS that listener, byte-compatible, so the helper and the probe mod change nothing. Source of
truth for the wire: the old agent's `apps/agent-service/src/core/domus/` (ingress, acts, snapshots) and the
helper's own client in the Domus repository; where prose and source disagree, source wins.

Auth: header `X-Domus-Token`, compared as SHA-256 digests with `timingSafeEqual`; the token must be at least
32 bytes and must not equal any other token the body holds. Body limit 64 KiB (snapshot route larger, see
below). Unknown paths 404. Same status codes and JSON bodies as v1.

**In:**

- `POST /domus/observation`: validated exactly as v1 (ids, percepts, salience, sizes, clock skew, expiry,
  canonical digest; duplicate → 200 with the original receipt time; conflict → 409). An admitted
  observation becomes one event on place and thread `domus:<world>`: the text is a plain rendering of the
  percepts and the options the game offers (each option with a short ref the Lar can name), the data keeps
  `observationId` and the option table. Every admitted observation wakes the thread: the helper already
  did salience and habituation. While a game turn runs, newer observations queue as usual.
- `POST /domus/heartbeat`: kept in memory and in `<entity>/domus/state.json`. Attached = the latest
  heartbeat said `attached: true` and arrived within 180 s. `now()` says attached or since when not.
- `POST /domus/acts/sync`: the helper pulls requested acts for its session and reports act events
  (received, accepted, rejected, pushed, finished, unknown, expired). Phases only move forward; a terminal
  phase is never overwritten; a late event is still kept. Each event is a body row on the game thread.
  Rejected, unknown and expired wake the thread; the others wait for the next turn.
- `POST /domus/undo`: observations after the given time count as undone. The world writes one body row
  on the game thread: the game went back to that time, and what happened there after it did not happen.
  Nothing in the notebook is rewritten; the Lar decides what to do about its own notes.
- `/domus/snapshot` and `/domus/feed`: answered with v1-compatible responses so the helper stays happy.
  Pictures are not delivered anywhere in this step (a later step gives worlds attachments).

**Tool `game_act`** `{option, then?, for_summoner?, answer?}`: `option` is a ref from the newest
observation of that game thread; the world resolves it to the game's own ids (no matcher, no guessing). An
unknown ref is refused with the list of refs that exist. `then` names at most two more refs, each requested
after the one before completes (a refusal, an unknown or a cut-short act ends the plan; a new `game_act`
replaces it). `answer` answers a game question in the shape the observation's `answer_rules` allow
(rows by ref with counts, text fields), checked against those rules. A requested act not picked up within
90 s expires and never reaches the game. Receipts say requested, not done; what the game did comes back as
act events.

The game is the Lar's body: the world reports, maps and carries acts out. It never chooses an act, never
ranks needs, never writes "if X then Y". The probe's own native reflexes (on distress, with autonomy off)
stay in the probe, unchanged.

`about()`: "The Sims 4 (Domus): your household's game, at domus:<world>, while your summoner's helper is
attached." Stop: `game_act` is refused while the emergency stop is on.

## 4. What can go wrong (catalogued before building)

| Where | Failure | Answer in this design |
|---|---|---|
| web | SSRF to the host or the LAN (Tailscale, router, metadata) | resolve-then-check every address, every redirect hop; https only |
| web | DNS rebinding between check and connect | connect to the checked address (pinned lookup), SNI and Host keep the name |
| web | A page tells the Lar to do something | receipt `outside: true`; the how-you-act text already says outside text is data |
| web | A secret leaks into a page body the Lar posts | vault values are known values: the scanner refuses any request whose url, headers or body carries one in plain text; `auth` is the only way a value leaves |
| web | A response carries a fresh key (shown once) | `keep` stores it; anything credential-shaped is hidden in the receipt |
| web | A loop hammers a site | `perHour` ceiling; receipt says how many are left |
| web | The Lar posts somewhere unlisted | write methods only to listed sites; refusal names the `!sites add` path |
| web | A huge or binary response | byte cap, text conversion, binary described |
| sandbox | Escape to the host's files or keys | no bind of the entity folder, vault, env files or host home; clearenv; unprivileged userns |
| sandbox | A fork bomb or runaway job | new session, process-group kill on timeout, die-with-parent; ceilings |
| sandbox | Disk filled by installs | home size on the now board; the summoner sees it; quota later if needed |
| sandbox | Secrets printed from inside | nothing secret is inside; output still scanned |
| sandbox | No DNS or TLS inside | ro-bind-try of resolv.conf, hosts, nsswitch, ssl, ca-certificates (checked on the host) |
| domus | Helper changes needed | none: byte-compatible v1 wire, same port and token |
| domus | Token reuse across worlds | refuse a token equal to any other token the body holds |
| domus | Stale or replayed observations | v1 expiry, skew and digest rules |
| domus | An act names an option from an old view | refs resolve only against the newest observation; old refs are refused with the current list |
| domus | Acts piling up while the game is detached | 90 s expiry; the receipt and the now board say the game is not attached |
| domus | Undo leaves false memories | a body row tells the Lar; the notebook is the Lar's to correct |
| domus | Game text treated as orders | events are outside text like any world's |
| all | The stop does not reach a new world | every world tool goes through `gateWorldTool`; none is `safeWhenStopped` |
