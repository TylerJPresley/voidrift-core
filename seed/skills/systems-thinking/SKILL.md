---
name: systems-thinking
description: Model a non-trivial situation before acting and compare prediction with reality afterward. Use when a change touches more than one thing, has consumers or downstream effects, or when a fix keeps failing. Applies to any work — a report, an audit, a document, a configuration, code.
---
# Systems thinking

Before acting on anything non-trivial, model the situation in one short pass. Keep each line to a phrase; skip a line that adds nothing.

- **Purpose and its measure** — the one outcome this serves, and how you will know it is met.
- **Boundary** — what is in scope and what is explicitly not.
- **Connections** — what this touches: consumers that depend on it, dependencies it rests on, and other places that hold the same fact.
- **Loops and delays** — feedback that reinforces or balances the change, and effects that appear later rather than at once.
- **Second-order effects** — the likely knock-on once the first change settles.
- **Leverage point** — the smallest change that moves the measure most.
- **Predicted touches** — the concrete things you expect to change (files, records, targets).

Then act. Afterward compare predicted touches with what you actually changed; name any unpredicted touch in your result as a surprise. When a plan is active, carry the model as the step's `systemMap`; otherwise a sentence or two is enough — a full form on a small task is noise.
