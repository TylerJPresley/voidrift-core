# @voidrift/core

VoidRift core SDK — the headless, model- and environment-agnostic agentic engine.

**Status:** pre-release, under active development.

## What it is

A headless, model-agnostic SDK powering agentic systems. The core provides the agent loop, context pipeline, permission system and tool registry. It is model-independent via LangChain's `BaseChatModel` abstraction and runs against local models (Ollama, vLLM), OpenAI-compatible proxies, and cloud APIs. No dependency on any product, plugin, or MCP server — the core is the foundation other packages build on.

## Requirements

- Node.js >=24.15
- No native build step or install scripts
- The durable checkpointer uses node:sqlite (no separate native dependency)

## Install

```bash
npm install @voidrift/core
```

## Usage

The core entry point is `createCore()`. See the guides in `docs/` for detailed examples, or [how VoidRift works](./docs/explanation/how-voidrift-works.md) for an orientation.

A minimal example using a fake model for testing:

```typescript
import { createCore } from "@voidrift/core";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";

const { api } = await createCore({
  chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
});

const session = await api.session.create({ prompt: "What is 2 + 2?" });
if (session.ok) {
  console.log("Session created:", session.value.id);
}
```

## Docs

- [How VoidRift works](./docs/explanation/how-voidrift-works.md) — the three-layer context, agents, and decision point
- [Orchestrating work](./docs/explanation/orchestrating-work.md) — dispatching tasks and fan-out patterns
- [Context and budget](./docs/explanation/context-and-budget.md) — token management and layer compaction
- [Limits registry](./docs/reference/limits.md) — configuration keys and runtime behavior bounds

## Build from source

```bash
git clone https://github.com/TylerJPresley/voidrift-core.git
cd voidrift-core
npm install
npm run build
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
