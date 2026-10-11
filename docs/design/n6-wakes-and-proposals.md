# N6: her own rhythm and her proposals (design, 2026-10-11)

The last plan step is "reflection while it sleeps, and a weekly review of the changes it proposes to itself". The
User's rulings shape it:

- **Reflection is hers alone.** The body never runs a nightly pass and never hints that night is for reflecting: that
  would be the host holding an opinion about how she lives. The body gives her the means to keep a rhythm if she
  wants one, and states plainly that she has it.
- **Proposals live in her notebook.** She writes what she would change about her body under `proposals/`. Once a
  week the summoner's side reads them (a digest command), and accepted ones become changes to Natalis through the
  ordinary review. She gets no access to the code repository's remote.

Nothing here judges meaning. The body keeps times, files and diffs.

## 1. Recurring wakes

`schedule_wake` gains `repeat`: `"daily"` or `"weekly"` (omitted: once, as now).

- A repeating wake keeps its local wall-clock time in the Lar's `timeZone`: a 09:00 daily wake stays at 09:00
  across a daylight-saving change.
- When it fires, the body writes the wake event as now and arms the next occurrence: the first one strictly after
  the current time. If the host was down across several occurrences, it fires **once** on start and then moves to
  the next future one: no burst.
- `cancel_wake` ends the series.
- The now board and the open-wakes list show a repeating wake with its rhythm, e.g. `09:00 daily: <why>`.
- `state.json` carries `repeat` on a wake; any other value is refused as malformed state.
- A ceiling, which is a resource limit and not a judgment: at most **100 wakes** held at once; the 101st is refused
  with the count and how to cancel one.

The ability text says, as a fact: "You can wake yourself at any time, for any reason, once or on a daily or weekly
rhythm." It says nothing about what a wake should be for.

### 1a. A rhythm the summoner may give (none by default)

No Lar is given preset wake times: the times would be the host's choice, not the Lar's (User, 2026-10-11, after a
day with a 09:00/14:00/20:00 default). Whether the Lar keeps a rhythm is its own doing; the summoner may tell it so in
conversation. `entity.json` still takes `rhythm`: a list of local clock times, `"HH:MM"`. Left out or `[]`, none. A malformed time (or a list that is not a list, or a time listed twice) is refused by name.

On the Lar's first start, the body gives it one ordinary **daily** repeating wake per time, in its own thread (`self`),
with the reason `Your daily rhythm.`, and records `rhythmGiven: true` in `state.json`. That is all the body says about
them: the reason names no purpose. It is given once. A Lar that cancels them keeps them cancelled. A Lar whose state
predates the flag gets them on its next start. They count toward the 100-wake ceiling: when the ceiling leaves no
room, only the times that fit are made, and a body note says how many were not.

The identity text says the Lar wakes on its own a few times a day and that those wakes are its to move or cancel. It
leaves that sentence out when `rhythm` is `[]`.

## 2. Her body, readable

Sandbox `run` binds part of the Natalis checkout the Lar runs on, **read-only**, at `/body`: an explicit allow-list,
each name at the same path under `/body`, each only if present: the folders `src`, `docs` and `deploy`, and the files
`README.md`, `AGENTS.md`, `package.json` and `LICENSE`. She can read her own source, docs and deploy files there, so a
proposal can name the exact file and line it is about. Git history is not bound: there is no `.git`, so `git log`
does not run in `/body`. No other top-level name of the checkout is bound (no `dist`, no `node_modules`).

- `sandbox.json` may set `"body": false` to leave it out. Default: on.
- The path is the running package's root (found from the code's own location), never the entity folder.
- The run command refuses to bind it, and says why, when the Lar's folder lies inside the checkout, or when an
  allow-listed folder holds an env file (`.env`, `.env.*`, `*.env`) or a `vault` folder at any depth. It reads names
  only, never file contents.

## 3. Proposals and the weekly digest

**Hers:** any notes she writes under `proposals/` in her notebook, in her own words. The body imposes no format.
The ability text says: "If you want something about your body changed (a tool, a limit, a sentence in your
instructions, a world), write it under proposals/ in your notebook. Your summoner's side reads that folder every
week; your summoner tells you what was decided." The `/body` mount is mentioned with it.

**The summoner's side:** `natalis proposals --dir <lar> [--since <YYYY-MM-DD>]`

- Reads the notebook's git history, read-only. Default `--since`: 7 days ago.
- Prints a Markdown digest: each file under `proposals/` added, changed or removed in the window, with its current
  text (or "removed") and the diff for changed files, newest first, plus a count line.
- The output goes through the secret scanner with every key the body holds (the same known values `run` gathers,
  plus vault values), so a key she pasted into a proposal never leaves in the digest.
- Exit 0 with "No proposals changed since <date>." when there are none; exit 2 on bad flags; 1 on failure.

The weekly review (lead + reviewers + summoner) runs the digest, carries accepted proposals into Natalis or her
entity layer as ordinary reviewed changes, and the summoner tells her the outcome in conversation. Exporting into
the Ashley-self repo is the review's job, not the body's.

## 4. What can go wrong (catalogued before building)

| Where | Failure | Answer in this design |
|---|---|---|
| wakes | Host down for days, then a burst of missed daily wakes | fire once, then the next future occurrence |
| wakes | DST shifts a daily wake by an hour | next occurrence keeps local wall-clock time in `timeZone` |
| wakes | A wake time that does not exist locally (spring-forward gap) | take the first valid instant after it |
| wakes | Hundreds of repeating wakes | 100-wake ceiling; refusal names the count and `cancel_wake` |
| wakes | A repeating wake fires while its thread is busy | the event queues like any other; one turn per thread |
| wakes | Old `state.json` without `repeat` | missing field means once |
| wakes | The host nudging her toward a rhythm | the rhythm is her own to move or cancel: the body gives the daily wakes once, with a neutral reason, and the identity text states that they are hers |
| body | Secrets readable through `/body` | read-only checkout with no env, vault or entity data; refused if one is present |
| body | She edits her own code from the sandbox | read-only bind; writes fail at the filesystem |
| body | A big checkout slows `run` | a bind mount costs nothing per run |
| proposals | A key pasted into a proposal reaches the digest | scanner with every held key, vault values included |
| proposals | Body or reviewers rewrite her proposal | the digest is read-only; her notebook stays hers |
| proposals | A proposal treated as an order to the reviewers | it is a request from the Lar; the review decides, the summoner tells her |
