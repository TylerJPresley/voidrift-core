# Contributing to @voidrift/core

## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run tests: `npm test`
5. Run the full gate: `bash scripts/gate.sh` (from meta directory) or the package's test scripts

## Code Style

- TypeScript strict mode
- ESM modules
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Dependencies

Every package installs cleanly. No shipped dependency may need a compiler toolchain, a binary download, or an install script: an install with `ignore-scripts=true` and no C++ toolchain must still produce a working package. The gate enforces this (`check:clean-install`); dev-only dependencies are exempt. Before adding a dependency, check its license (Apache-2.0 or more permissive) and its install scripts.

## Licensing

Inbound contributions must be Apache-2.0 licensed; outbound is Apache-2.0.

## Commits and pushing
- Develop on `main` with conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`); add the spec section when one applies, for example `feat: render the manual table of contents (§4.6)`.
- One logical change per commit, small enough that a reader sees what happened from the message and the diff. Never mix a refactor, a removal, a new limit and a bug fix in one commit.
- Every commit is tested: the build and the affected tests pass before you commit, and a bug fix carries its regression test in the same commit. Commit after each verified chunk, not once at the end.
- Push in logical chunks after the full test run passes. No force pushes, no amending pushed commits.

These rules apply to every contributor, human or AI.
