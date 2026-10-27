# One mind

Natalis is one mind in one place. These are the rules that keep it one. Each entry names the test that fails if the
rule breaks; the test file beside this one (`src/one-mind.test.ts`) asserts every rule directly.

## 1. One river writer

One process at a time writes a Lar's folder: its river, notebook and state. A second process is refused before it
opens any of them, so two writers never split her memory.

Guarded by `src/entity/lar-lock.test.ts` — "lets exactly one of twenty child processes take it"; `src/one-mind.test.ts` — "one river writer: a second holder writes no river row".

## 2. L1: non-live turns only when nothing runs

A reflect (background) turn starts only when no turn is running anywhere in the Lar. A live event waits for it to
end, and a message from the summoner pre-empts it so the summoner is answered first.

Guarded by `src/entity/runtime.test.ts` — "non-live turn starts only when no turn runs"; `src/entity/runtime.test.ts` — "summoner event pre-empts a non-live turn and the summoner turn starts within the bound"; `src/one-mind.test.ts` — "L1: a reflect turn starts only after the running live turn ends"; `src/one-mind.test.ts` — "L1: a summoner event pre-empts a running reflect turn".

## 3. The Lar folder lock and its holders

`run`, `forget`, `restore`, `notebook-restore`, `import --apply` and `vault --keep` take the lock for their whole
run. While `run` holds it, `vault --keep` hands the value to the running Lar through its vault queue instead of
writing the folder itself, so there is still one writer.

Guarded by `src/entity/lar-lock.test.ts` — "natalis run refuses, with a plain message, while another process holds the lock"; `src/bin/commands/forget.test.ts` — "refuses while another holder has the lock, and forgets nothing"; `src/bin/commands/restore.test.ts` — "refuses while another holder has the target's lock, then restores once it is free"; `src/notebook/restore.test.ts` — "refuses under a held lock even with --force, which still skips only the clean-stop check"; `src/import/import.test.ts` — "import --apply is refused while another holder has the lock; a dry run does not need it"; `src/bin/commands/vault.test.ts` — "refuses a keep while another holder has the lock and no channel answers, and keeps it once the lock is free"; `src/bin/commands/run.test.ts` — "a keep lands in the vault, the running Lar has it, and the socket goes on stop"; `src/one-mind.test.ts` — "the folder lock has one holder, and every writer command takes it".

## 4. The copy guard

A live Lar refuses to start in a folder that is not the one `state.json` recorded, because a copied folder would
become a second Lar. The owner can say the folder moved on purpose, and only then is the new place recorded.
Replay and eval copies are never refused.

Guarded by `src/entity/copy-guard.test.ts` — "refuses a different folder with the exact message"; `src/entity/copy-guard.test.ts` — "refuses to start, with the exact message and no new hash"; `src/one-mind.test.ts` — "the copy guard keeps the recorded folder and refuses another".

## 5. The say-hold per place

Two of her threads cannot both speak in one place at once. A say waits for the one already running there, then
re-checks the place: if the other thread spoke after this turn began, the say is held with `spoken_meanwhile` and
the receipt says what was said and when. `knowingly: true` sends it anyway.

Guarded by `src/entity/runtime.test.ts` — "holds a say when another thread spoke in that place after this turn began, and sends it only knowingly"; `src/entity/runtime.test.ts` — "sends once when both threads pass the check before either claim is written"; `src/one-mind.test.ts` — "the say-hold per place lets two racing threads send once".

## 6. No new RiverKind

The river has exactly seven kinds: event, say, tool_call, receipt, turn, note and tombstone. New records use the
existing `note` kind with typed `data`, so an older build can still open the file after a rollback.

Guarded by `src/one-mind.test.ts` — "no new river kind: the contract's list is the known seven and the river refuses any other".

## 7. Body notices are never recorded as her says

What the body writes (a turn's start and end, a retry, a model error) is a `note` or `turn` row with source
`body`. Only her own words are `say` rows with source `self`, so a reader never mistakes the body's voice for hers.

Guarded by `src/loop/run-turn.test.ts` — "writes every river row in order: start, thought, call, receipt, call, receipt, end"; `src/one-mind.test.ts` — "body notices are body notes, never her says".

## 8. No model-written text in her context except her own turns

Her context is built from the body's facts, the river's rows and her own words. Text another model wrote for the
body (a checker's paraphrase, a summary or a candidate) is never replayed to her as memory, and no assistant
history is carried from one turn to the next. A held say quotes the message and the record verbatim, never a
model's retelling.

Guarded by `src/entity/runtime.test.ts` — "puts nothing in the held receipt except fixed words, the message and the record"; `src/one-mind.test.ts` — "no model-written text in her context except her own turns".
