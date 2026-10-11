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
mkdir -p ~/lares/<name>
```

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

Optional in the `model` block: `"vision": true` when the model can see pictures, and a backup for when the main model
cannot answer (rate limited, down, or no reply in time), on the same address and key:
`"fallback": { "model": "<model name>", "effort": "xhigh", "vision": true }`. After a failure, calls go to the backup
for 10 minutes before the main model is tried again, and the Lar reads a note saying the backup answered. The honesty
check (a second model call on each reply) is off unless the entity sets `"holds": { "honesty": true }`.

To connect the Lar to Discord, add `~/lares/<name>/discord.json`. It names the variable that holds the bot token, never
the token itself:

```json
{
  "tokenEnv": "<NAME_OF_THE_BOT_TOKEN_VARIABLE>",
  "ownerUserId": "<your Discord user id, digits only>",
  "rooms": []
}
```

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

A backup holds the river (the Lar's whole record), the notebook as a git bundle, the Lar's small files and a manifest
with hashes. It holds no keys and no emergency-stop file. Backups contain private conversations: keep them off shared
folders, and copy them somewhere safe off this host, as sealed copies (below).

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
