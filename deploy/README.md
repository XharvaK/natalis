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
folders, and copy them somewhere safe off this host if you can.

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

## 7. The emergency stop

The summoner's emergency stop pauses the Lar's outward acts. Replies to the summoner still go. The Lar notices the stop
at its next outward act.

```sh
node ~/natalis/dist/bin/natalis.js stop --dir ~/lares/<name> --reason "<why>"
```

Lift it with the same command and `--off`. The stop is a file in the Lar's folder, so it works while the service runs.
Stopping the service is a different thing: `systemctl --user stop natalis@<name>` ends the process, and the Lar starts
again the next time the service starts.
