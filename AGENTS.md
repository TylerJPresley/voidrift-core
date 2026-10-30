# @voidrift/core

VoidRift core SDK — the headless, model- and environment-agnostic agentic engine.

Package `@voidrift/core` · kind: `library` · repo: `voidrift-core`. This folder is its own git project; commit here.

## What this is
The shared headless SDK: the agent loop, context pipeline, permission system and capabilities. It is not dependent on any model, runs in any environment, and depends on no product, plugin or MCP server.

## Specification
Governing blueprints: `blueprint.md`, `core-blueprint.md`. They are maintained outside this repository by the project owner and are the
authoritative specifications; code follows them, never the reverse. Section numbers (`§N.N`) cited in code
comments and tests stay stable. A spec change needs the owner's approval.

## Dependencies
- no internal VoidRift packages
- No source or test imports another package by relative path or reaches into its `dist`; use declared dependencies only.
- Before adding a dependency check its license: shipped dependencies (`dependencies`, `peerDependencies`, anything bundled) must be Apache-2.0 or more permissive (MIT, BSD, ISC); reject copyleft, including weak copyleft (MPL, EPL, CDDL). Dev-only tooling is not restricted.
- Depend on LangChain abstractions (`BaseChatModel`), not provider implementations. There is no automatic model failover (owner decision 2026-10-18).

## Build and verify
Run from this folder. Scripts:
- `npm run build`
- `npm run manifest:update`
- `npm run typecheck`
- `npm run test`
- `npm run test:watch`
- `npm run coverage`
- TypeScript strict, ESM. Single test file: `npx vitest run <file>`.
- Lint and the package-graph checks are not configured in this repository yet.

## Testing
- Everything is tested. A bug fix carries a regression test; a new feature carries tests before it is complete.
- Statement coverage: ≥80% per package, ≥90% for entities and use-cases, ≥70% for adapters.
- Tests mirror the source directory structure; use in-memory implementations of repository interfaces, `InMemoryTransport` from `@modelcontextprotocol/sdk` for MCP tests, and `hermeticTmp(label)` for test directories (never a fixed `/tmp/voidrift-*` path).
- Fit for the target: VoidRift runs against local models (Ollama, vLLM), OpenAI-compatible proxies and cloud APIs; a feature that works on only one provider is not correct.

## Conventions
- Configuration files are JSON; prose is Markdown. Filename slugs are lowercase alphanumerics and hyphens.
- A limit is added only when exceeding it would break functionality or testing shows a tunable problem; otherwise derive it from an existing budget or keep an internal constant. Every limit is an entry in the one `limits` registry (`core-blueprint.md` §13.11).
- Architecture rules: `core-blueprint.md` §1. Core stack: LangChain/LangGraph, Zod (single source of truth for tool schemas), the MCP SDK, Chokidar, Liqe.
- Every git invocation goes through the hardened runner (`adapters/git-harden.ts`).

Follow `CONTRIBUTING.md` for this project's standards.
