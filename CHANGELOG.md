# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.1.0] - 2026-10-28

### Added
- Core headless SDK: agent loop, context pipeline, and capabilities registry
- Durable session checkpointer using node:sqlite (no native dependency)
- LangGraph integration for agentic state and graph execution
- Tool and guardrail registry with permission gating (Warden + Guardian decision point)
- Model-agnostic design via LangChain `BaseChatModel` abstraction
- Configuration system: builtin, global, and workspace-level cascading layers
- Plugin system: trusted code register with scoped CoreAPI surface
- Limits registry with tunable and safety classes; warn/deny actions per key
- Doctor warning for unignored `.voidrift/` folder in version control
- Plugin state persistence in `.voidrift/plugins/<name>/`
- Session export with message and write history
- Memory system with provider port for custom implementations
- Observability records and cost derivation
- Approval system for sensitive operations
