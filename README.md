# @tangle-network/agent-eval

**A library for deciding whether an LLM-driven generator did its job.**

You hand it the thing the generator produced — a code scaffold, a patch, a tweet, a JSON config — and you get back a structured verdict: pass/fail, dimension scores, plain-English rationale. Built to catch the LLM failure modes that LLM-as-judge alone misses.

```ts
import { BuilderSession, SubprocessSandboxDriver, InMemoryTraceStore } from '@tangle-network/agent-eval'

const session = new BuilderSession(new InMemoryTraceStore(), { projectId: 'my-app' }, new SubprocessSandboxDriver())
await session.startChat()
const ship = await session.ship({
  harness: { setupCommand: 'pnpm install', testCommand: 'pnpm exec tsc --noEmit', cwd: scaffoldDir, timeoutMs: 180_000 },
})
console.log(ship.result.passed, ship.result.score)
```

## Who this is for

- You ship a code generator (scaffolder, patcher, refactor agent) and need to gate on whether its output actually works.
- You ship a content generator and need quality signal beyond "the LLM said it's good".
- You want a release gate that fails on regressions you can name, not vibes.

If that's you, start with [`docs/concepts.md`](./docs/concepts.md) — 5-minute mental model — then come back here.

## Quickstart

### From any language: HTTP or RPC

The fastest path. agent-eval ships a CLI that runs as either an HTTP server or a stdio RPC binary. Drive it from Python, Rust, Go, anything.

```sh
npm i -g @tangle-network/agent-eval

# HTTP — long-running
agent-eval serve --port 5005

# stdio RPC — one-shot, batch
echo '{"rubricName":"anti-slop","content":"…"}' | agent-eval rpc judge
```

Python:
```sh
pip install tangle-agent-eval
```
```python
from tangle_agent_eval import Client
c = Client()
r = c.judge(content="our scaffold ships zero-copy IO", rubric_name="anti-slop")
print(r.composite, r.failure_modes)
```

See [`docs/wire-protocol.md`](./docs/wire-protocol.md) for the full surface.

### From TypeScript: import directly

In-process; no wire round-trip. Use this when your eval lives in the same Node process as your generator.

```sh
pnpm add @tangle-network/agent-eval
```

The recipe for a code-generator eval is in [`SKILL.md` §Minimal working path](./.claude/skills/agent-eval/SKILL.md#minimal-working-path-builder-of-builders).

## Two ways to read this repo

- **You're a human onboarding** — read [`docs/concepts.md`](./docs/concepts.md) for the mental model, then [`docs/wire-protocol.md`](./docs/wire-protocol.md) if you'll call from another language, or `SKILL.md` if you'll embed in TS.
- **You're an LLM agent writing integration code** — read `SKILL.md`. Every directive there encodes a shipped bug; skipping one reintroduces the bug class.

## What's in the box

| Module | What it does | Doc |
|---|---|---|
| `BuilderSession` | Three-layer eval orchestrator (builder → app-build → app-runtime) for code generators. | concepts.md §three-layer eval |
| `MultiLayerVerifier` | Pipeline of layers (install → typecheck → build → semantic). Skip-on-fail, weighted aggregate. | concepts.md §verifiers |
| `judges`, `createCustomJudge`, `createAntiSlopJudge` | LLM and deterministic judges. | SKILL.md |
| Wire protocol (`agent-eval serve` / `rpc`) | HTTP and stdio RPC interface for cross-language clients. | wire-protocol.md |
| `clients/python/` | First-party Python client (`tangle-agent-eval` on PyPI). Version-locked to npm. | clients/python/README.md |
| `BenchmarkRunner`, `executeScenario`, `ConvergenceTracker` | Multi-turn scenario execution + cross-run tracking. | SKILL.md |
| `ExperimentTracker`, `PromptOptimizer`, `bisector` | A/B prompts, optimize steering, bisect regressions. | SKILL.md |
| Telemetry (`telemetry/`, `telemetry/file`) | OTLP export, trace replay, file sinks. | inline JSDoc |

## Tech stack

- TypeScript strict, no semicolons, single quotes, 2-space indent
- `tsup` for bundling, `vitest` for tests
- `@tangle-network/tcloud` for LLM calls (judges, driver)
- `hono` + `@asteasolutions/zod-to-openapi` for the wire protocol

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm openapi             # write dist/openapi.json from the wire schemas

# Run the server locally
node dist/cli.js serve --port 5005

# Python client tests (require pnpm build first)
cd clients/python && pip install -e ".[dev]" && pytest
```

## Release

`@tangle-network/agent-eval` (npm) and `tangle-agent-eval` (PyPI) ship from the same git tag in the same CI workflow. If either fails to publish, neither does. Versions are locked.

## Related

- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway)
- [`@tangle-network/agent-client`](https://github.com/tangle-network/agent-client)
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud)

## License

MIT
