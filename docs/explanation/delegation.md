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

## Briefing a worker

A worker starts in fresh context. It sees its own role prompt, the harness rules, a short meta block (where it works, its tool-round budget), the skills index and the manual table of contents, and the task you send. It does not see this conversation, AGENTS.md, memory or the plan.

Put what the worker needs in `task` and `context`: the facts it needs, the project rules that apply to its job (quote them), the success criteria, and one focused question. Split by question: one worker, one question.

## Worker budget and the limit

A worker has the same tool-round budget as you, stated in its meta block. At 80% of its rounds, and again at 80% of its context window, it gets a wrap-up note. A worker that runs out returns status `limit_reached` with what it found so far; the result is never empty.

When a worker returns `limit_reached`, re-dispatch only the unanswered part: send a new task with the remaining question and the findings so far in `context`. Do not ask again what was already answered.

## Reading a worker's report

Every worker result starts with a report line: `[worker report: ended=<completed|rounds|context|timeout|error|cancelled> rounds=<used>/<limit> context=<percent>% (<used>/<window>) elapsed=<seconds>s]`. The text below it is what the worker gathered.

When `ended` is anything but `completed`, your brief was too broad for one worker, or its reads were too wide. Split the work by question, re-dispatch only what is still unanswered with the findings so far in `context`, and ask for narrower reads when `context` is high. Do not repeat a brief that just failed.

## What you get back

A valid call returns the workers' summaries and final statuses, never a raw
transcript. The single form is a batch of one and behaves the same. A worker is
compiled without the task tool, so a worker cannot itself delegate.
