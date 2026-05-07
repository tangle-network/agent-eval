# @tangle-network/agent-eval

Evaluation infrastructure for agent systems.

`agent-eval` gives agent products a reusable way to record what happened,
verify outcomes, classify failures, compare variants, optimize prompts or
policies, and make release decisions from evidence instead of anecdotes.

It does not own your product state, credentials, UI, or model routing. Product
teams keep those boundaries; this package standardizes how runs are recorded,
checked, compared, and promoted.

## Contents

- [When To Use It](#when-to-use-it)
- [Architecture](#architecture)
- [Install](#install)
- [Quick Start](#quick-start)
- [Core Primitives](#core-primitives)
- [Adoption Path](#adoption-path)
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

## Quick Start

Wrap the real product loop first. Do not build a toy eval path that users never
exercise.

```ts
import {
  objectiveEval,
  runAgentControlLoop,
} from '@tangle-network/agent-eval'

const result = await runAgentControlLoop({
  intent: task.prompt,
  budget: { maxSteps: 8, maxWallMs: 180_000, maxCostUsd: 2 },

  async observe() {
    return productAdapter.readState(task.id)
  },

  async validate({ state }) {
    return [
      objectiveEval({
        id: 'build-passes',
        passed: state.build.exitCode === 0,
        severity: 'critical',
        metadata: state.build,
      }),
      objectiveEval({
        id: 'preview-serves',
        passed: state.preview.httpStatus === 200,
        severity: 'critical',
      }),
    ]
  },

  async decide({ evals }) {
    return evals.every((evalResult) => evalResult.passed)
      ? { type: 'stop', reason: 'all critical checks passed' }
      : { type: 'continue', action: { type: 'repair' }, reason: 'checks failed' }
  },

  async act(action) {
    return productAdapter.runAgentStep(task.id, action)
  },
})

await productAdapter.storeControlResult(task.id, result)
```

Once this loop represents production behavior, convert completed runs into
feedback trajectories, split them into train/dev/test/holdout sets, and run
multi-shot optimization against the same adapter.

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

`NoopResearcher` is a fail-loud sentinel for wiring tests. Production systems
should implement `Researcher` directly or use `CallbackResearcher`.

## Adoption Path

1. Choose one real workflow: code generation, browser task, research task,
   workflow builder, voice interaction, or domain agent task.
2. Write a product adapter that can observe state and execute one agent step.
3. Add deterministic validators first: build, test, serve, schema, policy,
   permission, retrieval, and deployment checks.
4. Add LLM judges only for subjective quality that deterministic checks cannot
   measure.
5. Emit traces and convert successful and failed attempts into
   `FeedbackTrajectory` records.
6. Build train/dev/test/holdout scenarios from those trajectories.
7. Run `runMultiShotOptimization()` or prompt/code evolution on train/dev.
8. Promote only when test/holdout gates and real product telemetry improve.

For a complete product integration guide, see
[Product Eval Adoption](./docs/product-eval-adoption.md).

## Examples

Runnable examples live in the repository's
[`examples/`](https://github.com/tangle-network/agent-eval/tree/main/examples)
directory. They are not part of the published npm package.

- [`examples/same-sandbox-harness`](https://github.com/tangle-network/agent-eval/tree/main/examples/same-sandbox-harness) - run
  multiple eval passes against the same workspace.
- [`examples/multi-shot-optimization`](https://github.com/tangle-network/agent-eval/tree/main/examples/multi-shot-optimization) -
  optimize full agent trajectories with held-out promotion.
- [`examples/benchmarks`](https://github.com/tangle-network/agent-eval/tree/main/examples/benchmarks) - benchmark adapter shape and
  reference benchmark wrappers.

The examples are intentionally kept outside the README so they can be expanded,
tested, and copied without turning this page into a tutorial.

## Documentation

- [Concepts](./docs/concepts.md)
- [Feature Guide](./docs/feature-guide.md)
- [Product Eval Adoption](./docs/product-eval-adoption.md)
- [Control Runtime](./docs/control-runtime.md)
- [Knowledge Readiness](./docs/knowledge-readiness.md)
- [Integration Launch Gates](./docs/integration-launch-gates.md)
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
