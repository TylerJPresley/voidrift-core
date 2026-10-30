---
summary: How to delegate work to workers with the task tool — forms, fan-out and context.
read-when: before dispatching work with the task tool, especially a parallel batch.
type: explanation
---

# Delegating work with the task tool

The `task` tool is the one way a top-level agent delegates to a worker during a
live turn. Each worker runs in isolation, is independently reviewed, and returns
a summary of what it did. Choose workers by name from the list in the tool
description.

## Two forms (use exactly one)

- Single: `{ worker, task, context? }`
- Batch (reliable parallel fan-out): `{ tasks: [ { id, worker, task, context?, dependsOn? } ] }`
  — 1 to 8 tasks, each `id` a unique lowercase slug; `dependsOn` lists ids in
  this same batch that must finish first (their summaries are prefixed into this
  task's brief).

The batch form declares the whole set in one call so reliable fan-out does not
depend on the model emitting several parallel tool calls in one message. The
executor validates the whole batch before any worker is dispatched (unique slug
ids, resolvable intra-batch `dependsOn`, an acyclic graph, every `worker`
dispatchable) and rejects the whole batch with a typed error — dispatching
nothing — on any violation.

## Split by non-overlapping scope

Split a fan-out by non-overlapping scope so two workers never read or search the
same thing, and put the facts you already know (paths, file names, prior
findings) in each task's `context` so no worker re-discovers them. A dependent
task receives its dependencies' summaries by reference — work from those, do not
re-ingest the same files.

## Example

```json
{
  "tasks": [
    { "id": "a", "worker": "researcher", "task": "survey X", "context": "known: package.json at repo root lists deps" },
    { "id": "b", "worker": "researcher", "task": "survey Y (different scope than X)" },
    { "id": "c", "worker": "planner", "task": "plan from A and B", "dependsOn": ["a", "b"] }
  ]
}
```

## What you get back

A valid call returns the workers' summaries and final statuses, never a raw
transcript. The single form is a batch of one and behaves the same. A worker is
compiled without the task tool, so a worker cannot itself delegate.
