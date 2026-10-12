# Cache order: the same words in a cache-friendly order (2026-10-12)

## Evidence

Mint ledger, last two days, counts only:

| Thread | Turns | Prompt tokens per turn | Cache hit |
|---|---|---|---|
| game | 22 | about 157k | 85% |
| summoner | 20 | about 143k | 84% |
| self | 6 | about 275k | 87% |

Every turn still misses 14k to 49k tokens, and most of that is on its first model call. DeepSeek caches by exact
prefix, so the first token that differs from an earlier request ends the reuse.

Today a turn is built like this:

- **System:** who / how / pictures / constitution / character / life / privacy / index / **now** / **time facts** /
  **recall**.
- **User message:** Recent here (the last 30 rows, with a "cut" count before them) / New.

Four things change the prefix every turn:

1. **The now board, time facts and recall sit in the system text.** Everything after them misses, so no part of the
   user message can ever hit.
2. **Recent here slides by one row each time a row arrives**, and the cut count changes with it. Its first line is
   different on every turn.
3. **A view becomes a brief when a newer view of the same key arrives** (`olderViewRows`). A full view in the middle
   of Recent turns into a short line in the next turn.
4. **Clock stamps in lines.** These are stable once a row is written, so they are not a problem.

## Change (the same content, nothing dropped, nothing added)

- **System holds only the slow sections:** who you are, nature, how you act, pictures, constitution, character, your
  life, privacy list, index. The index stays here because it changes only when her notes change.
- **The user message, in this order:**
  1. **Recent here**, paged. The window starts at a page boundary: the oldest shown row moves forward only in steps of
     `RECENT_PAGE` rows (10). Recent therefore holds between 30 and 39 rows, and the start and the cut line stay the
     same across the turns of a page.
  2. **New.**
  3. **Already done**, when there is any.
  4. **Now:** the now board, then time facts.
  5. **Recall.**
- **Views in Recent are always briefs.** The newest full view of each key goes into its own block, "Current view
  (<key>)", right after New. The brief rule then never rewrites a row already shown. The full view she needs is the
  same text in a new place.

The section headings keep their names, so her notes and habits that cite "now" or "recall" still read true. The
prompt says once, at the top of the user message, that the now board and recall come after the new rows.

## Quality guard

- She sees the same rows, the same newest full view, the same now board and the same recall. A test pins that the set
  of rendered lines equals today's for the same river (order aside).
- Recent grows by up to 9 rows: at most about 9 short lines. That is within the existing context budget; the
  assembler still drops optional sections first when needed.

## Verification

- Tests: the prompt prefix is byte-stable across two turns in one page when only new rows arrive; it changes at a page
  boundary; views in Recent are briefs; the current view block holds the newest full view; the content-set test
  passes; system sections are in order.
- Live: the ledger hit rate before and after, on the same thread kinds (counts only). Target: misses per turn down by
  a third or more.
