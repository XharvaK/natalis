# Cache layer: a prompt that stays cache-friendly by construction (2026-10-12)

This builds on [cache-order.md](cache-order.md), which is implemented on branch `cache-order` and not deployed. The
User's goals:

- The prompt should not need hand-tuning again.
- It must be fail-proof.
- Every token that can be saved without losing quality should be saved, because a Lar is a living creature that runs
  all day.

Cache-order, this layer and the call savings ship together, in one deploy.

## Evidence (Mint, last 2 days, counts only)

| | game | summoner | self |
|---|---|---|---|
| Turns | 22 | 20 | 6 |
| Model calls per turn | 4.9 | 4.9 | 7.1 |
| Prompt tokens per call | about 27k | about 22k | about 31k |
| Cache hit | 85% | 84% | 87% |

- Over the 2 days: 8.3M tokens in total, of which 7.96M prompt tokens (6.77M of them cache hits) and 0.34M output
  tokens.
- Cached tokens are billed at a fraction of a miss (the User, 10-12). Misses, output and the number of calls are what
  matter most.
- **61 of 92 turns spent a model call only on `end_turn`.** That is about 61 calls of about 25k prompt tokens, plus
  their reasoning output: roughly a fifth of all prompt tokens.
- Views are large: a full game view runs up to 11.5k characters, and its brief about 80.

## L1. Stability classes

Every part of a request declares how often it changes:

| Class | Changes when | Parts |
|---|---|---|
| `fixed` | Natalis changes, or the model changes | tools, who you are, how you act, pictures, the order note |
| `notes` | a file she or the summoner edits changes | nature, constitution, character, your life, privacy list, index |
| `page` | Recent here moves on by a page (cache-order) | Recent here up to the page start, and the cut line |
| `turn` | every turn | the rows since the page start, New, Current view, Already done, now, time, recall, the dropped note |

- A single function, `layoutRequest`, builds the system text and the user message from the declared parts:
  - It orders them by class, keeping the declared order inside a class.
  - The system text holds `fixed` and `notes`. The user message holds `page` and `turn`.
  - A part declared out of order is moved into place. The first time in a process that happens, the service log says
    so. Tests make it an error.
- **The age line moves.** "You are N days old" leaves "who you are" (the User, 10-12) and joins the time facts.
  - "Who you are" keeps "You were summoned on <date>: that is your natalis". The age reads "Your age: N days." in time
    facts.
  - "Who you are" is then `fixed` for the whole day, so the prompt no longer misses in full once a day.
- **Honesty test.** It renders a Lar twice, under several kinds of change:
  - only new rows inside one page;
  - a clock step of a day;
  - a note write;
  - a page step.

  After each change it asserts that every part of a class slower than that change is byte-identical. A part that
  changes faster than its declared class fails the test and names that part. A new section, whoever writes it, must
  declare a class. The type requires it.

## L2. The cache witness (live, counts only)

For each model call the runtime has the request as an ordered list of parts. Each part has a name, a class, its
length in characters and a SHA-256 of its text. The text is never kept.

- **Comparison.** The witness keeps the part lists of the last 16 requests in memory, across threads, since the
  provider's cache is shared. It finds the earlier request with the longest common run of parts.
- **The call ledger.** Each call adds one row to a new table `call_ledger` in the river database:
  - `at_ms`, `thread_kind`, `turn_call` (the call's index in its turn), `model`;
  - `prompt_chars`, and `stable_chars` (the characters of the common run);
  - `break_part` (the name of the first part that differed, or none) and `break_class`;
  - `idle_ms` since the request it matched;
  - the provider's `prompt_tokens`, `cache_hit_tokens` and `cache_miss_tokens`;
  - `part_sizes`: a JSON object of part name to characters.
- **Reading a row.**
  - When `stable_chars / prompt_chars` is high but the hit ratio is low, the provider forgot (an idle gap or an
    eviction). That is not our layout.
  - When `break_class` is slower than `turn` on a first call, our layout broke the cache, and `break_part` says
    where.
- **Surfaces.**
  - `natalis ledger <lar> --cache [--days N]` shows, per thread kind:
    - calls, the hit ratio and the expected ratio;
    - break parts by count;
    - "provider forgot" count;
    - the mean size of each part.
  - The service log writes one line when a part of class `fixed` or `notes` breaks the first call of a turn,
    naming the part. At most once an hour per part.
- **Retention:** the same as the turn ledger. Forget never touches it: it holds no words.

The witness's part sizes are the evidence for the later wording trim. That trim is not part of this build: the User
approves each proposed diff first.

## L3. Provider cache marks

- **Config.** The model config gets `cacheMarks?: boolean`, default false. The fallback gets the same key.
- **Messages.** A message may carry its text as parts. Each part has text and may carry `mark: true`.
  - Without `cacheMarks`, the adapter joins the parts. The wire request is byte-identical to today, and a test pins
    that.
  - With `cacheMarks`, the adapter sends the content as an array of text parts and puts
    `cache_control: {type: "ephemeral"}` on each marked part. That is the OpenAI-format mark that OpenRouter passes on
    to Claude and Gemini.
- **The marks**, at most four:
  1. the end of the system text;
  2. the end of the `page` part of the user message;
  3. the last message of the request, moving with each call of a turn, so the turn's own tool loop is cached.

  The witness counts marks too, as `marks` on the call row.
- DeepSeek's requests are unchanged.

## L4. One call fewer per clean turn: `end_turn` rides along

- **Her tool text** for `end_turn` says: "You may call it in the same reply as your last acts. If any of them is
  refused or held, the turn stays open so you can see why."
- **The loop.**
  - `end_turn` in a reply runs after every other call in that reply, whatever its position. The receipts of the
    others are known by then.
  - If any of them has `ok: false` (refused, held, failed), the turn stays open. `end_turn`'s receipt is then
    `ok: false`, with code `reopened` and reason "an earlier call in this reply was refused or held: see its
    receipt". The next model call sees every receipt.
  - The ceiling still applies.
- **Nothing else changes.** A plain reply with no tool calls still ends the turn (`no_tool_call`). Whether to end is
  still her choice.
- **Expected effect:** up to about 60 calls fewer per 2 days at today's rate, with no receipt ever unseen when
  something went wrong.

## Ship order and verification

- **Order.** The worker builds L1–L4 on branch `cache-order`, on top of 008ebe2. The lead merges and runs the full
  corpus. Natalis deploys once.
- **Focused tests.**
  - the class honesty test (L1);
  - the order and the age line;
  - the witness: common run, break part, provider forgot, and no text stored;
  - the `--cache` summary;
  - marks: byte-identical without the flag, and the marked parts with it;
  - `end_turn`: runs last, reopens on a refused, held or failed call, and the ceiling still holds;
  - cache-order's own tests.
- **Live**, after a day:
  - `natalis ledger --cache` before and after: misses per turn (target −33%) and calls per turn (target about −1 on
    clean turns);
  - the break parts.
