# @tangle-network/agent-eval

Trace-first evaluation infrastructure for agent systems.

`agent-eval` provides the contracts and runtime primitives for measuring agent
behavior: traces, harnesses, verifier pipelines, judges, datasets, holdout
gates, failure classification, optimization loops, and release reports.

It does not own your product state, credentials, UI, or model routing. Product
teams keep those boundaries; this package standardizes how runs are recorded,
checked, compared, and promoted.

## Contents

- [When To Use It](#when-to-use-it)
- [Architecture](#architecture)
- [Install](#install)
- [Core Primitives](#core-primitives)
- [Examples](#examples)
- [Documentation](#documentation)
- [Development](#development)
- [Related Packages](#related-packages)

## When To Use It

Use `agent-eval` when you need one or more of these:

- A reproducible eval harness for coding agents, builder agents, or multi-tool
  workflows.
- Structured traces for agent runs: spans, artifacts, events, budgets, tool
  calls, retrieval, judge output, and sandbox execution.
- Deterministic gates around build/test/deploy checks.
- LLM-as-judge or deterministic judge fleets with calibration and canaries.
- Dataset splits, holdouts, paired statistics, and release confidence gates.
- Failure taxonomy that distinguishes prompt, tool, sandbox, retrieval,
  evaluator, and knowledge-readiness failures.
- Optimization loops over prompts, steering, code mutations, or full multi-shot
  trajectories.
- Report data for internal launch reviews, CI gates, and research analysis.

## Architecture

```txt
agent/product run
  -> TraceEmitter / TraceStore
  -> SandboxHarness / MultiLayerVerifier / JudgeRunner
  -> failure taxonomy + metrics
  -> paired stats + held-out gates
  -> optimization + release confidence + reports
```

Package responsibilities:

- `agent-eval`: run evidence, eval contracts, verification, statistics,
  optimization, reporting.
- Product app: domain state, tools, credentials, UI, storage, deployment, model
  gateway.
- `@tangle-network/agent-runtime`: production agent-loop/session runtime.
- `@tangle-network/agent-knowledge`: evidence stores, claim/page synthesis,
  retrieval, knowledge readiness implementation.

## Install

```sh
pnpm add @tangle-network/agent-eval
```

Wire protocol / CLI:

```sh
npm i -g @tangle-network/agent-eval
agent-eval serve --port 5005
```

Python client source lives in `clients/python`. Until the PyPI package is
published, install it from the repo:

```sh
cd clients/python
pip install -e .
```

## Core Primitives

| Primitive | Purpose |
|---|---|
| `TraceEmitter`, `TraceStore` | Append-only run/span/event/artifact/budget records. |
| `SandboxHarness` | Build/test/runtime checks with captured stdout, stderr, exit codes, wall time, and parsed test counts. |
| `MultiLayerVerifier` | Ordered verification stages with dependencies, skip-on-fail, findings, scores, and time caps. |
| `JudgeRunner` | Parallel deterministic or LLM-backed judges over the same artifact/run. |
| `runAgentControlLoop` | Observe/validate/decide/act loop with budgets, stop policies, and structured eval results. |
| `Dataset`, `RunRecord`, `HeldOutGate` | Versioned corpora, reproducible run metadata, and held-out promotion decisions. |
| `pairedBootstrap`, `pairedWilcoxon`, `bhAdjust` | Paired experiment statistics and multiple-comparison correction. |
| `classifyFailure` | Rule-based failure classification for agent, tool, sandbox, retrieval, and knowledge failures. |
| `runMultiShotOptimization` | Optimization over full agent trajectories with actionable side information. |
| `runPromptEvolution` | Prompt/steering/code evolution over scenario scores. |
| `evaluateReleaseConfidence` | Release scorecard across evidence volume, pass rate, score, overfit, cost, latency, and gates. |
| `summaryTable`, `paretoChart`, `gainHistogram` | Report-ready structured outputs. |
| `KnowledgeRequirement`, `KnowledgeBundle` | Shared contracts for knowledge readiness. |

## Examples

Runnable examples live in the repository's [`examples/`](./examples)
directory. They are not part of the published npm package.

- [`examples/same-sandbox-harness`](./examples/same-sandbox-harness) - run
  multiple eval passes against the same workspace.
- [`examples/multi-shot-optimization`](./examples/multi-shot-optimization) -
  optimize full agent trajectories with held-out promotion.
- [`examples/benchmarks`](./examples/benchmarks) - benchmark adapter shape and
  reference benchmark wrappers.

The examples are intentionally kept outside the README so they can be expanded,
tested, and copied without turning this page into a tutorial.

## Documentation

- [Concepts](./docs/concepts.md)
- [Feature Guide](./docs/feature-guide.md)
- [Control Runtime](./docs/control-runtime.md)
- [Knowledge Readiness](./docs/knowledge-readiness.md)
- [Multi-Shot Optimization](./docs/multi-shot-optimization.md)
- [Feedback Trajectories](./docs/feedback-trajectories.md)
- [Wire Protocol](./docs/wire-protocol.md)

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm openapi
```

Run the local server:

```sh
pnpm build
node dist/cli.js serve --port 5005
```

Python client tests:

```sh
pnpm build
cd clients/python
pip install -e ".[dev]"
pytest
```

## Release

`@tangle-network/agent-eval` publishes to npm. The Python client lives under
`clients/python` and is versioned from this repository.

## Related Packages

- [`@tangle-network/agent-runtime`](https://github.com/tangle-network/agent-runtime)
- [`@tangle-network/agent-knowledge`](https://github.com/tangle-network/agent-knowledge)
- [`@tangle-network/agent-integrations`](https://github.com/tangle-network/agent-integrations)
- [`@tangle-network/agent-gateway`](https://github.com/tangle-network/agent-gateway)
- [`@tangle-network/tcloud`](https://github.com/tangle-network/tcloud)

## License

MIT
