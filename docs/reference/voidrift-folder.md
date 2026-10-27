---
summary: "The .voidrift folder structure, what it stores, and why each part exists."
read-when: "when setting up a project or understanding where VoidRift stores its work."
type: reference
---

# The .voidrift folder

`.voidrift/` is your project's work directory for VoidRift. It holds configuration, sessions, memory, research notes, and runtime state. Projects add it to `.gitignore` as part of setup.

| Item | Purpose |
|---|---|
| `config.json` | Project-level settings override global config; mutated only through the `config` tool. |
| `mcp-pins.json` | Pinned MCP server definitions; written atomically, never model-writable. |
| `managed.json` | The managed layer: organisation-set configuration that sits above the user's own and cannot be overridden by them. |
| `agents/` | Project-scoped agent definitions (overrides global agents); each subdirectory is an agent with `agent.json` and optional `prompt.md`. |
| `skills/` | Project-scoped skill definitions; each subdirectory contains `SKILL.md` with frontmatter and skill body. |
| `prompts/` | Override prompts for agents or other contexts. |
| `memory/` | Persistent agent memories and learned notes; scoped to workspace or global, deduplicated and verified. |
| `research/` | Research notes and findings saved by agents; UTF-8 Markdown only, never overwrites, size-capped per call and per file. |
| `suggestions/` | Pending memory and skill suggestions waiting for user approval before they are committed. |
| `sessions/{id}/` | Per-session metadata and state; one directory per session ID. |
| `logs/{id}.log` | Session execution logs; one file per session ID. |
| `journal/{id}/` | Session mutation journal; records every change the agent made in structured entries. |
| `checkpoint.db` | SQLite database of session checkpoints, so a session resumes where it stopped. |
| `checkpoint.db-shm`, `checkpoint.db-wal` | SQLite shared memory and write-ahead log files. |
| `cache/` | Derived, disposable data the harness can rebuild or discard. Each subfolder below says what it holds. |
| `cache/snapshots/` | Rollback snapshots that back /undo, /redo and /goto. |
| `cache/session/{id}/` | Per-session cache; holds large evicted results, pointers, and intermediate computation. |
| `cache/run/` | Full command and tool output kept on disk, with a short pointer in the conversation. |
| `cache/apps/{appName}/` | Application-scoped cache; reserved for the client app (CLI, VS Code, etc.) to use. |
| `worktrees/{id}/` | Git worktrees for isolated worker branches; one per concurrent worker run. |
| `plugins/` | The project plugin store: plugins installed for this project. Changed only through the plugin commands, not by hand. |
