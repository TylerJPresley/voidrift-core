---
summary: Your context window budget, what counts against it, how compaction works, and what to do as it fills.
read-when: before a long session, or when old tool results show up as cache pointers.
type: explanation
---

# Context and Budget

Your context window is finite. VoidRift manages it actively so you stay aware and in control.

## The working budget

The working budget is the window minus the head tokens minus the output reservation. That is the space available for the conversation and tool results (§4.8):

`working budget = window − head tokens − output reservation`

The output reservation defaults to 1024 tokens if the endpoint sets no limit. Your endpoint's real window is required context — it is configured or discovered at boot.

## What counts against the budget

The Rift layer — the conversation — counts. Tool output counts. Inferred context (injected by the application or a plugin) counts. The head — your system prompt and stable knowledge — is subtracted from the window before the working budget is computed, capped at 10% of the window by default.

## The three occupancy levels

Three thresholds fire as occupancy rises:

- **Compaction at 40%** (configurable: `contextCompactionPct`) — the harness clears old tool results to cache pointers (no model call), then folds the oldest assistant work into one running summary if needed. Your active chain stays verbatim; only older work is summarized.
- **Pre-turn safety net at 80%** (configurable: `contextSafetyNetPct`) — before a turn runs, compaction fires automatically if needed, so a turn never begins over budget.
- **Hard stop at 100%** — a request that cannot fit is refused outright; nothing is silently truncated.

The active chain is always kept verbatim: the newest messages up to 20% of the working budget (configurable: `contextActiveBudgetPct`), plus the current turn's anchors (the last user message and the last assistant group, always).

## Compaction

Compaction happens in two steps (§4.9):

1. **Clear old tool results** — results outside the active chain are replaced by a cache handle (no model call). The full result stays on disk and is re-read on demand.
2. **Fold older assistant work** — if clearing is not enough, older assistant messages fold into one running summary. The summary is bounded: 20% of the folded content, with a floor of 2000 tokens and a ceiling of `max(floor, min(5% of the window, 12000))`.

Folding is a last resort. Most long chats stay within budget by just clearing old results.

Documents marked stale after a fold must be re-read before you use them for a write (§4.5).

## What to do as your window fills

Each turn your environment block shows the remaining context percentage (§4.4). Use it to decide how much to load before you read a large file.

The application triggers compaction automatically — you cannot call `session.compact`. What you can observe: as context fills, old tool results are replaced by cache pointers (you can still read them on demand), and when a turn is folded, its documents are marked [STALE] and must be re-read before you edit them. To manage your context effectively:

- Keep tool output you ask for small and focused.
- Read only the section of a file you actually need, not the whole thing.
- For heavy reading or analysis, delegate to workers instead of loading everything yourself.