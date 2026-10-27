---
summary: What VoidRift is and how its three-layer context, agents, and decision point work.
read-when: before your first turn, then return here if you encounter unfamiliar concepts.
type: explanation
---

# How VoidRift Works

You are running inside VoidRift — a harness that manages your context, permissions, and work. Understanding its structure helps you work within it effectively.

## The three context layers

Your system message is three layers, most stable first, so your model endpoint can cache the longest possible prefix (§4.2):

- **Agent** — your identity for this session: your system prompt, your blocked tools, the environment block (PWD, git branch, date, model capabilities, worker names), hard rules, and project instructions digest.
- **Void** — knowledge that changes infrequently: the manual table of contents, the document registry (what files you have read), skills index, memory index, and directives you follow.
- **Rift** — the conversation: every message you and the system exchange, the only volatile layer, the only one that compacts (§4.9).

Turn metadata rides after all three: MCP server instructions, injected context, and your working context budget.

## Agents, skills, and the manual

You are an agent — a mode with a persona, a tool set, and policy rules (research reads only; chat can write; vibe delegates everything). You can load skills, which are bundled capabilities you activate by name (§12.1); each skill grants no privilege — every tool it names still passes the decision point below. The manual (§12.8) is VoidRift's own documentation about how it works; open it with `read_manual` when you need to understand the harness itself.

## The one decision point

Every tool call passes two gates in a fixed order: **Warden** first (compliance policy), then **Guardian** (permissions). Either can deny; if both allow, the call executes (§9):

- **Warden** enforces policy rules configured by the operator. If policy denies, the call stops — the harness tells you so.
- **Guardian** governs consent: calls on the allow list run without a prompt; calls not on it are denied (research), asked (chat), or run free (vibe).

Nothing bypasses these gates — not an allow-list entry, not `auto_approve` (which only auto-answers prompts; denials still bind), and not your urgency.

Read versus act: Warden and Guardian gate every action the same way. A `read_file` call and a `write_file` call follow the same path through the same decision point.

## Workers and modes

When your work is complex, dispatch a worker — a specialized agent given a scoped task — with the `task` tool. Workers are isolated: a worker sees only its task text, not your conversation. Modes are how you run: the CLI runs your prompts as a session you drive turn by turn; headless runs your prompts non-stop in read-only mode unless `--enable-write` is set (§2.5).

## Your working files

VoidRift stores everything it owns under `.voidrift/`:

- **sessions/** — conversation history, document registry, memory, config layer, and message chain.
- **cache/** — indexed files, web fetches, and oversized tool output.
- **research/** — research notes (setting `findingsDirectories`).
- **skills/** — skill definitions (project layer).
- **agents/** — agent definitions (project layer).
- **config.json** — session configuration (merged from global, project, and session layers).

Your own working files live in the workspace root; `.voidrift` is VoidRift's and should not be edited by hand.
