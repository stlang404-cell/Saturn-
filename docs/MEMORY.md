# Memory architecture

SATURN remembers its world in the database, not in the model's context window.

| Layer | Storage | Authority |
|---|---|---|
| **A. Authoritative world memory** | `events` (append-only), `rolls` (with RNG counter), `ledger_tx`/`ledger_entries`, `item_log`, `relationship_log`, `contracts`, `turns` (input, validated interpretation, outcome, narration) | Exact and never summarised |
| **B. Episodic memory** | `memories` rows per character: summary, participants, location, time, importance 0–10, valence, confidence, source (`experienced`, `witnessed`, `hearsay`, `consolidated`), pinned | Derived from events |
| **C. Semantic memory** | `facts` (objective truth, secrecy) + `knowledge` (who believes what, how strongly, from whom) | Facts are authoritative; beliefs may be wrong |
| **D. Social memory** | `relationships` (trust, affection, respect, fear, rivalry, familiarity) + `relationship_log` with reasons and event links; faction `reputation` | Changes only through recorded events |
| **E. Procedural/skill memory** | `skills` (xp, rank, daily diminishing state, specialisation) + `training_log` (method, minutes, xp) | Exact |

## Retrieval

`retrieveMemories(owner, query, participants, location)` gathers candidates from SQLite
FTS5 full-text matches, the most recent memories, important/pinned memories and memories
involving the given participants, then scores each:

```
score = recency (half-life 6 + 6×importance days)
      + 1.2 × importance/10
      + 1.0 × shares a participant
      + 0.4 × same location
      + 1.6 × normalised FTS relevance (bm25)
      + 0.5 if pinned
```

Every result carries its score breakdown. The **memory inspector** (Relationships tab →
*memory*) shows, for any NPC, which memories were retrieved for a query and why, what they
believe (and whether it is actually true), and their recent autonomous decisions.

Embeddings were considered and deliberately not used in this release: FTS5 + structured
participant/location/importance signals proved sufficient for recall in tests, add no model or
runtime, and are fully explainable. The retrieval interface is isolated so a vector index can
be added later.

## Consolidation and bounds

Weekly, for every character: episodic memories older than 7 days with importance < 6 are
grouped by the main other participant and replaced in retrieval by a summary memory once there
are more than 40 of them. Important (≥ 6) and pinned memories are never consolidated.
Consolidated originals are deleted after 240 days; the authoritative event log keeps the exact
record. Memory row counts stay bounded in multi-year campaigns (tested).

## Knowledge boundaries

- An NPC can only disclose facts present in its own `knowledge` rows.
- What it is willing to disclose depends on secrecy, its disposition toward the player and
  the result of persuasion/intimidation checks; secret keepers deny.
- The narrator receives only the disclosed facts and is checked for introducing people or
  numbers absent from the outcome.
- Asking about something nobody knows yields "doesn't know" — tested.

## Tests

`test/memory-npc.test.js`: a promise remembered and ranked first after 400 intervening
conversations; consolidation keeps a 200-memory backlog to < 20 active rows while the
importance-9 memory still ranks first; secret-boundary and keeper-denial tests; gossip
confidence decay; hearsay provenance. `test/persistence.test.js`: exact state equality after
reload, including after two simulated years.
