# Running a Lar on a host

These steps run one Lar as a systemd user service on a Linux host, with a daily backup. Every name in angle brackets
is yours to choose or fill in. Nothing here needs root. Keys and tokens never go in the repository.

Each Lar should have its own model key and its own Discord bot. Then one Lar's key can be rotated, or one bot removed,
without touching the others.

## 1. Build Natalis

Needs Node 22.13 or newer.

```sh
git clone <repository url> ~/natalis
cd ~/natalis
npm ci
npm run build
```

The service expects the checkout at `~/natalis`. If it lives elsewhere, edit the `ExecStart` lines in the copied unit
files.

## 2. Make the Lar's folder

The folder is `~/lares/<name>`. The name is also the service's instance name, so keep it to letters, digits and dashes.

```sh
node ~/natalis/dist/bin/natalis.js new --dir ~/lares/<name> --summoner <your alias>
```

This writes `entity.json` and `DESIGN.md`, a form for designing the Lar: its nature, privacy list, contacts and
welcome. Fill in the form, copy each answer into the file it names, and run
`node ~/natalis/dist/bin/natalis.js check --dir ~/lares/<name>` before the first start. You can also write the folder
by hand: `mkdir -p ~/lares/<name>`, then `entity.json` as below.

Write `~/lares/<name>/entity.json`. The model block names the environment variable that holds the model key; the
summoner is the alias the Lar knows you by:

```json
{
  "name": "<the Lar's name>",
  "timeZone": "<your time zone, such as Europe/London>",
  "model": {
    "baseUrl": "<an OpenAI-compatible address, https://...>",
    "model": "<model name>",
    "apiKeyEnv": "<NAME_OF_THE_KEY_VARIABLE>",
    "contextTokens": 32000
  },
  "summoner": { "alias": "<your alias>" }
}
```

Optional: `~/lares/<name>/nature.md` replaces the default nature every Lar starts with (its voice and manners) for this Lar.
An empty file removes that section. Without the file the default stays. The Lar reads it on each turn, so an edit needs no restart.

Optional in the `model` block: `"vision": true` when the model can see pictures, and a backup for when the main model
cannot answer (rate limited, down, or no reply in time):
`"fallback": { "model": "<model name>", "effort": "xhigh", "vision": true }`. A backup uses the main model's address
and key unless it names its own (`baseUrl`, `apiKeyEnv`, `headers`), and it can have a backup of its own in the same
way. After a failure, the rest of that turn's calls go to the backup; the next turn tries the main model again. The
Lar reads a note saying which backup answered and why the main model did not. A world can have a model of its own for
its turns, on the same address and key, with the main model as its backup:
`"worldModels": { "domus": { "model": "<model name>", "effort": "medium", "vision": true } }` at the top level of
entity.json. The honesty check (a second model call on each reply) is off unless the entity sets
`"holds": { "honesty": true }`.

On the chat protocol, `"stream": true` in the `model` block has the reply sent as it is written, and
`"idleTimeoutMs": 120000` then ends a call when the model service sends nothing for that long, so a silent model
goes to the backup in two minutes instead of waiting out `timeoutMs`. A backup on the chat protocol streams when the
main model does, unless it says `"stream": false`; a backup on the responses protocol never streams.

The `ceiling` block at the top level caps one turn: `"ceiling": { "maxModelCalls": 64, "maxToolCalls": 128 }`. Near the
cap the Lar sees how many calls are left, and at the cap it gets one last call to keep a note. With
`"wholeResultsChars": 48000` beside them, older tool results in a turn are shortened to 2 KB each once together they
pass that many characters; the Lar can call the tool again to see one in full.

To connect the Lar to Discord, add `~/lares/<name>/discord.json`. It names the variable that holds the bot token, never
the token itself:

```json
{
  "tokenEnv": "<NAME_OF_THE_BOT_TOKEN_VARIABLE>",
  "ownerUserId": "<your Discord user id, digits only>",
  "rooms": []
}
```

Who may write to the Lar directly is the summoner's list, kept in `~/lares/<name>/contacts.json`. Only you may write in a
direct message until you add someone: in your own DM with the Lar, send `!contacts add <@mention>` or `!contacts add <alias>`,
and `!contacts remove <@mention or alias>` or `!contacts list` the same way. A room named in `discord.json` admits its
members as before. The file holds Discord user ids, so it stays on this host, like the alias file beside it. A damaged
`contacts.json` admits nobody but you until it is fixed.

Check the Lar in a terminal before you run it as a service: `node ~/natalis/dist/bin/natalis.js chat --dir ~/lares/<name>`.
Ctrl+C stops it.

## 3. Write the keys file

Keys live in `~/lares/<name>.env`, beside the folder and outside it, so backups never hold them. Make the file private
before you write anything into it:

```sh
install -m 600 /dev/null ~/lares/<name>.env
```

Open it in an editor and put one line per variable:

```
<NAME_OF_THE_KEY_VARIABLE>=<the model key>
<NAME_OF_THE_BOT_TOKEN_VARIABLE>=<the Discord bot token>
```

Check the mode is still 600 with `ls -l ~/lares/<name>.env`.

## 4. Install and start the service

Copy the unit files into your user's systemd folder, then load them:

```sh
mkdir -p ~/.config/systemd/user
cp ~/natalis/deploy/natalis@.service ~/natalis/deploy/natalis-backup@.service ~/natalis/deploy/natalis-backup@.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now natalis@<name>.service
systemctl --user enable --now natalis-backup@<name>.timer
```

Services stop when you log out unless the host keeps your user's services running. Turn that on once:

```sh
loginctl enable-linger "$USER"
```

Check that it runs:

```sh
systemctl --user status natalis@<name>
journalctl --user -u natalis@<name> -f
```

Logs are kept by the journal. Press Ctrl+C to stop following them; that does not stop the Lar.

## 5. Backups

The timer makes a backup every day into `~/lar-backups/`, one dated folder each, and keeps the newest 14. Run one now
without waiting for the timer:

```sh
systemctl --user start natalis-backup@<name>.service
journalctl --user -u natalis-backup@<name> -n 30
ls ~/lar-backups/
```

What each kind of backup holds, exactly:

- A plain backup folder holds the river (the Lar's whole record), the notebook as a git bundle, the Lar's small files
  (entity.json, discord.json, its aliases, privacy.json, contacts.json, nature.md, web.json and the rest), the shelf of
  pictures, the sandbox's home (without caches or names that look like env files) and the game's database, with a
  manifest of sizes and hashes. It leaves out the vault, the keys file and the emergency-stop file.
- A sealed copy holds everything a plain backup holds, and the vault as well (the web's secret values, each kept for one
  host). It leaves out the keys file and the emergency-stop file, and the seal key is never in it.

Neither kind holds the keys file `~/lares/<name>.env`, the seal key or the emergency-stop file. Backups contain private
conversations: keep them off shared folders, and copy them somewhere safe off this host, as sealed copies (below).

### Sealed copies, for storage off the host

A sealed copy is one encrypted file per backup, `<name>-<YYYYMMDD-HHMMSS>.natalisbak`. Someone who holds the file but
not the key cannot read it. Sealing runs after the plain backup is made and checked, and a sealed package is opened
again and checked before the run reports success. The Lar's folder name must use only letters, digits, dashes and
underscores to be sealed.

Make the key on this host, and keep it in a private file beside the Lar's folder. `openssl rand -hex 32` prints 64 hex
characters, which is a 32-byte key:

```sh
install -m 600 /dev/null ~/lares/<name>-seal.env
```

Write one line in it, the variable name and the key:

```
<NAME_OF_THE_SEAL_KEY_VARIABLE>=<64 hex characters>
```

Check the mode is still 600 with `ls -l ~/lares/<name>-seal.env`. The key lives in that file and nowhere else: not in the
repository, not in a backup folder, not in a log. **Keep a second copy of the key somewhere safe off this host**, such as
a password manager. If the host is lost with its key, the sealed copies can never be opened, and nothing can recover
them.

Give the backup service the key with a drop-in, one per Lar. The empty `ExecStart=` line clears the template's command
so the new one replaces it. The drop-in gives the backup service only the sealing key, not the model key:

```sh
mkdir -p ~/.config/systemd/user/natalis-backup@<name>.service.d
```

In `~/.config/systemd/user/natalis-backup@<name>.service.d/seal.conf`:

```
[Service]
EnvironmentFile=%h/lares/<name>-seal.env
ExecStart=
ExecStart=/usr/bin/env node %h/natalis/dist/bin/natalis.js backup --dir %h/lares/<name> --out %h/lar-backups --keep 14 --seal-to %h/lar-sealed --key-env <NAME_OF_THE_SEAL_KEY_VARIABLE> --seal-keep 30
```

Then reload and run one now:

```sh
systemctl --user daemon-reload
systemctl --user start natalis-backup@<name>.service
journalctl --user -u natalis-backup@<name> -n 30
ls -l ~/lar-sealed/
```

The sealed folder `~/lar-sealed` is created with mode 700. It keeps the newest 30 packages of each Lar.

## 6. Restore a Lar from a backup

Restoring never overwrites. It needs a folder that is missing or empty. To replace a damaged Lar, first stop it and move
the old folder aside:

```sh
systemctl --user stop natalis@<name>
mv ~/lares/<name> ~/lares/<name>.damaged-<date>
node ~/natalis/dist/bin/natalis.js restore --from ~/lar-backups/<name>-<YYYYMMDD-HHMMSS> --dir ~/lares/<name>
systemctl --user start natalis@<name>
```

The restore checks every file's hash against the manifest before it writes anything, and checks the river and the
notebook after. The keys file `~/lares/<name>.env` is not in the backup and is not touched. The Lar starts with its
emergency stop off, whatever it was when the backup was made.

A restore from a plain backup brings back no vault, because a plain backup holds none. The Lar's web values must then be
kept again, and until they are the web's logins are not sent. The Lar can keep a value a site shows it (web_request's
`keep`). A value only you can see, such as a key from a site's owner page, you keep yourself; type it at the hidden
prompt, never on the command line:

```sh
node ~/natalis/dist/bin/natalis.js vault --dir ~/lares/<name> --keep <value name> --host <the site's host> [--replace]
systemctl --user restart natalis@<name>
```

The restart makes the Lar hide the new value if a site ever shows it back. `natalis vault --dir ~/lares/<name>` lists
the names and their hosts, never the values. A restore from a sealed copy brings the vault back, at mode
0600 (see "Opening a sealed copy" below). A restore never writes into a folder that holds anything, so a vault that is
already in the target folder is never replaced or deleted: the restore is refused and the folder is left as it was.

### Opening a sealed copy

Opening needs the sealing key from `~/lares/<name>-seal.env`, which is on this host. On another machine, copy the
package and the key there, the same way. The target folder must be missing or empty:

```sh
set -a; . ~/lares/<name>-seal.env; set +a
node ~/natalis/dist/bin/natalis.js unseal --from ~/lar-sealed/<name>-<YYYYMMDD-HHMMSS>.natalisbak --to ~/unsealed/<name> --key-env <NAME_OF_THE_SEAL_KEY_VARIABLE>
```

A wrong key or a damaged package writes nothing. A good one leaves a plain backup folder in `--to`, which
`natalis restore --from` takes, as in the steps above.

## 7. Copies on a Windows PC

`deploy/pull-backups.ps1` runs on a Windows PC and copies new sealed packages from the host to a folder there, which a
cloud sync client can then sync off the house. It cannot open packages: it has no key and never reads inside a package.
It checks each copy's SHA-256 against the host, keeps the first package of each month, and keeps the newest 30 daily
and 12 monthly copies of each Lar (change them with `-DailyKeep` and `-MonthlyKeep`). The host is named by its ssh
config alias, and the login must need no passphrase, because the script runs ssh with `BatchMode=yes`.

Check the login first from a PowerShell window, with your own alias in place of the angle brackets. It should print
without asking anything:

```
ssh -o BatchMode=yes <host alias> "echo ok"
```

Try one run by hand, then read `status.json` and `pull.log` in the destination folder:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<folder with the script>\pull-backups.ps1" -SshHost <host alias> -RemoteDir lar-sealed -Dest "<folder on this PC>"
```

`-RemoteDir` is the folder on the host, relative to the login folder, such as `lar-sealed` for `~/lar-sealed`.

To run it every day, make a Windows scheduled task (create it yourself, in Task Scheduler):

- Trigger: daily, at a time after the host's backup timer usually runs. Add a second trigger, "At log on", if the PC is
  often off at that time. Tick "Run task as soon as possible after a scheduled start is missed".
- Action: start a program. Program: `powershell.exe`. Arguments: the same as the manual run above, with your own
  values. Start in: the folder with the script.
- Run it as the Windows user whose `.ssh` folder holds the key for the host.
- Exit codes: 0 is a good run, 1 is a failed run, and 2 means a Lar's newest copy is older than `-StaleHours` (48 by
  default). A failed or stale run raises a Windows notification, and Task Scheduler's "Last Run Result" shows the code.

The destination folder holds sealed packages only. That is safe to sync to a cloud folder, but the packages can be
opened only with the key, which must not be in that folder.

## 8. The emergency stop

The summoner's emergency stop pauses the Lar's outward acts. Replies to the summoner still go. The Lar notices the stop
at its next outward act.

```sh
node ~/natalis/dist/bin/natalis.js stop --dir ~/lares/<name> --reason "<why>"
```

Lift it with the same command and `--off`. The stop is a file in the Lar's folder, so it works while the service runs.
Stopping the service is a different thing: `systemctl --user stop natalis@<name>` ends the process, and the Lar starts
again the next time the service starts.
