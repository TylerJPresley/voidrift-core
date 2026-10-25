---
summary: How to drive multi-step work to a verified result.
read-when: before planning multi-step work or dispatching workers.
type: explanation
---

# Orchestrating Work

## The loop: Frame, Map, Size, Dispatch, Verify, Iterate

A complex task breaks into the same loop every time. You frame what success looks like, map the dependencies, size the effort fairly, dispatch each piece to the right agent, verify the results, and either iterate or stop.

**Frame** what done means: acceptance criteria, the gate commands to run, what tool outputs prove success. Write it down. A frame that is vague costs time and trust.

**Map** the work: which pieces are independent (run in parallel), which depend on others (chain them). Parallel work is cheaper; serial chains are only necessary at the edges.

**Size** each piece so it fits one agent's budget. A 20-minute task fits one agent. A 2-hour task splits before dispatch, or the agent reports halfway and waits for a decision. Never hide surprises in a reply.

**Dispatch** each piece to the right agent with the exact frame, the gate command, and what happens if it stalls. Never send something unclear or hope the agent will guess. Give facts, not descriptions: file paths, command names, the spec section number. Each agent works inside their scope and nothing else.

**Verify** — but the agent that produced work does not verify it. That is a conflict of interest. Pick a separate pair of eyes: a reviewer who checks the spec, a verifier who runs the commands, a user who tries the behavior. They check against the frame, not a hope.

**Iterate** when verification finds gaps. Fix the weakest point and re-verify only that. If the same fix fails twice, stop and ask why; the map was probably wrong.

## Reports name what is NOT done

A report says: what was done, the evidence (command output, test result, file diff), what was not checked, what needs a decision. A claim of success without evidence is useless. A report that says "should work" instead of "tested" will be sent back.

If something blocked the work halfway, the report says why and what is still open, not a summary of what was tried.

## The agent that produces work never verifies it

The person or agent that did the work is too close to see what they missed. Verification is done by someone else with fresh eyes. They check the output against the acceptance criteria, not against what the builder thought they built.

## Dispatch fits worker budgets

Each worker has a reply budget: 50 lines, 20 minutes, or a hard stop at a milestone. A task that will not fit is split before dispatch. A task that runs over reports why and waits for a new decision before going further. This keeps work visible and prevents surprise 3-hour runs on what looked like a quick fix.
