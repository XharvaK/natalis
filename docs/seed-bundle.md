# Seed bundle (format 1)

A seed bundle is how an entity's existing life comes into a fresh Natalis entity: notes, the record of what
happened, and tombstones for what was forgotten. Any older system can be converted by writing an extractor
that produces this folder; `natalis import` reads it. The importer judges nothing; it checks shape and
secrets, shows a plan, and writes only when asked.

```
<bundle>/
  bundle.json         {"format": "natalis-seed-bundle", "version": 1, "source": "<one line>", "createdAt": "<ISO>"}
  notes/              files copied into the notebook at the same relative paths (UTF-8 text, .md or .txt)
  river.jsonl         one river row per line, sorted by atMs (see below)
  tombstones.jsonl    one forget record per line (see below); never any forgotten text
  provenance/         restricted files (for example platform ids), copied to the notebook's provenance/ folder
```

## river.jsonl

Each line is a JSON object:

| Field | Required | Meaning |
|---|---|---|
| `atMs` | yes | When it happened, epoch milliseconds |
| `thread` | yes | The thread it belongs to (for a conversation, its place) |
| `kind` | yes | `event`, `say` or `note` |
| `source` | yes | `owner`, `outside`, `self` or `body` |
| `place` | no | Where it happened |
| `actor` | no | Who: an alias, never a platform id |
| `text` | no | The words. Leave it out for a row whose text was removed; the row keeps its time only |
| `data` | no | A small JSON object; for example `{"importedId": "…"}` |

## tombstones.jsonl

| Field | Required | Meaning |
|---|---|---|
| `atMs` | yes | When the forget happened |
| `by` | yes | `owner`, `self` or `body` |
| `reason` | yes | A plain line with no forgotten text, for example "forgotten by the owner (3 rows)" |
| `count` | no | How many items were forgotten |
| `what` | no | What kind of item, for example `belief` or `message` |

## Rules

- Every text in the bundle passes the secret scanner. An item holding a credential-like string is refused
  and listed by file and line number, never by value; `--apply` stops unless `--skip-refused` is given.
- The entity must be fresh: an empty river, and a notebook that holds only the seeded folders and stubs.
  A bundle file may replace a seeded stub; any other existing file is a conflict and stops the import.
- Imported rows are history. They do not open asks, schedule wakes or start turns.
- `natalis import` without `--apply` is a dry run: it prints the plan (files new or replacing a stub,
  rows per month and per kind, tombstones, refused items) and writes nothing.
