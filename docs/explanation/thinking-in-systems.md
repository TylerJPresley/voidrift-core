---
summary: Plan with a system map before a non-trivial change.
read-when: before changing anything non-trivial.
type: explanation
---

# Thinking in Systems

## The map: see what a change connects to

Before you change anything that touches more than one file, touches permissions, security, data, or a public API, or is large enough that a single failure would burn an hour to diagnose—draw a map. Not a diagram on paper; a 10-line written map with evidence behind every line. This takes 5 minutes and saves the hour.

## The map has seven parts

**Purpose:** what changes, and how you measure that it worked. "Add a retry handler to the model fallback" is not enough. "Add retries to the SAME model endpoint only (never across models); measure: a transient network error now succeeds after 2 retries, timeout is unchanged, a real error still fails immediately." That is a map.

**Boundary:** what is in scope, what is out, who owns the edge. If you change tool input validation, does that also change how plugins validate tools? If it does, that is a connection. If it does not, say why.

**Connections:** every place that holds or depends on the fact you are changing. Callers, consumers, tests, docs, config, permissions, initialization, event handlers. Use grep and the import graph; do not trust memory. Enumerate them.

**Loops:** what reinforces or balances the change. Gate checks, reviews, retries, lessons recorded when something fails. If you add a rule, what reminds the team to update it when the system grows?

**Delays:** what will not show until later. A cache that will not be invalidated until a restart. A workspace that does not re-read config until you open a new session. A telemetry pipeline that batches reports. These delays are where surprises hide.

**Second-order effects:** what else moves when this changes. If you raise a timeout, what workloads slow down? If you add a validation gate, what latency does it add? If you log more, what disk space grows?

**Leverage point:** the smallest change at the right place. A rule beats code. A goal beats effort. A fact in one place beats the same fact duplicated. Ask: where does this fact live today, and can I change it once instead of many times?

**Predicted touches:** the files and areas you expect to change. Write them down before you code.

## After you change: predict, then verify

Run `git diff --name-only` and compare with your predicted touches. Each surprise is a missed connection. Why did you predict X but also change Y? Did Y need to change, or did you touch it by accident? Record the pattern in a lessons file so you see it earlier next time.

## Questions that catch the usual misses

- Who calls this? (Built but never wired.)
- What else holds this fact? (Duplicated rules go stale when one copy is updated.)
- What runs at the same time? (Races, ordering, concurrency.)
- What does this fix move elsewhere? (A fix that moves the problem, not solves it.)
- Does what we measure reward the right thing? (A metric that optimizes for the wrong outcome.)
