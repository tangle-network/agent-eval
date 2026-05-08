# @tangle-network/agent-eval

Evaluation infrastructure for agent products.

Use it to wrap the real workflow your users run, record what happened, verify
the result, turn feedback into replay data, compare variants, and ship only
when the evidence improves.

```txt
product task
  -> observe state
  -> validate with deterministic gates first
  -> act through the real product adapter
  -> trace + feedback trajectory
  -> replay / optimize / release gate
```

`agent-eval` does not own product state, credentials, UI, storage, model
routing, browser drivers, sandbox policy, or deployment. Products own those.
This package owns eval contracts, loop mechanics, traces, statistics,
optimization inputs, and release evidence.

## Install

```sh
pnpm add @tangle-network/agent-eval
```

## Quick Start

```ts
import {
  objectiveEval,
  runAgentControlLoop,
} from '@tangle-network/agent-eval/control'

const result = await runAgentControlLoop({
  intent: task.prompt,
  budget: { maxSteps: 8, maxWallMs: 180_000, maxCostUsd: 2 },

  observe() {
    return product.readState(task.id)
  },

  validate({ state }) {
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

  decide({ evals }) {
    const failed = evals.filter((e) => !e.passed)
    if (failed.length === 0) {
      return { type: 'stop', pass: true, reason: 'all gates passed' }
    }
    return {
      type: 'continue',
      action: { type: 'repair', failed: failed.map((e) => e.id) },
      reason: 'repair failed gates',
    }
  },

  act(action) {
    return product.runAgentStep(task.id, action)
  },
})

await product.storeEvalResult(task.id, result)
```

That loop should be the same shape in production, replay, benchmark, and
optimization. Swap dependencies behind `observe()` and `act()`, not the eval
contract itself.

## Import Paths

The root export remains available, but new code should prefer focused subpaths:

```ts
import { runAgentControlLoop } from '@tangle-network/agent-eval/control'
import { runMultiShotOptimization } from '@tangle-network/agent-eval/optimization'
import { TraceEmitter } from '@tangle-network/agent-eval/traces'
import { renderReleaseReport } from '@tangle-network/agent-eval/reporting'
```

| Subpath | Use for |
| --- | --- |
| `@tangle-network/agent-eval/control` | `observe -> validate -> decide -> act`, action policy, propose/review loops |
| `@tangle-network/agent-eval/traces` | trace stores, emitters, TraceAnalyst |
| `@tangle-network/agent-eval/optimization` | feedback trajectories, multi-shot optimization, prompt evolution |
| `@tangle-network/agent-eval/reporting` | release confidence, paired stats, report/table/chart specs |
| `@tangle-network/agent-eval/wire` | HTTP/RPC judge server and schemas |
| `@tangle-network/agent-eval/benchmarks` | benchmark adapter contracts and reference wrappers |

## Core Pieces

| Need | Use |
| --- | --- |
| Keep an agent working until objective state passes | `runAgentControlLoop` |
| Turn user/reviewer feedback into replay data | `FeedbackTrajectory` |
| Compare prompt/tool/retrieval policies over full trajectories | `runMultiShotOptimization` |
| Gate releases with paired evidence and holdouts | `evaluateReleaseConfidence`, `HeldOutGate` |
| Explain regressions across trace corpora | `TraceAnalyst` / `analyzeTraces` |
| Report a launch decision | `renderReleaseReport`, `researchReport`, `summaryTable`, `paretoChart`, `gainHistogram` |
| Capture every provider HTTP request / response for forensics | `RawProviderSink`, `LlmClientOptions.rawSink` |
| Fail loud if an eval would silently use the wrong route | `assertLlmRoute` |
| Assert at run-end that the artifact is complete | `assertRunCaptured`, `throwIfRunIncomplete` |
| Auto-execute the trace analyst on every run | `traceAnalystOnRunComplete` + `TraceEmitterOptions.onRunComplete` |
| Run a matrix of variants × scenarios × seeds with capture integrity by construction | `runEvalCampaign` |
| Re-judge / determinism-audit a past campaign for free | `ReplayCache`, `createReplayFetch` |
| Ship-when-decisive with anytime-valid α across rolling looks | `pairedEvalueSequence`, `evaluateInterimReleaseConfidence` |
| Tell load-bearing rubrics from decorative ones using deployment outcomes | `rubricPredictiveValidity` |
| Model missing context separately from bad reasoning | `KnowledgeRequirement`, `KnowledgeBundle` |

### Capture integrity (0.21+)

Launch-grade benchmark runs need four things that are easy to forget in glue
code: (1) raw HTTP capture alongside the structured spans so a reviewer can
verify which route answered, (2) a preflight assertion that the configured
client points at the intended provider, (3) a run-end assertion that the
expected events were actually written, and (4) auto-execution of the trace
analyst as part of the run lifecycle. The wiring fits in a few lines:

```ts
import {
  TraceEmitter, FileSystemRawProviderSink, callLlm, assertLlmRoute,
  assertRunCaptured, throwIfRunIncomplete,
} from '@tangle-network/agent-eval'
import { traceAnalystOnRunComplete } from '@tangle-network/agent-eval/traces'

const sink = new FileSystemRawProviderSink({ dir: `${workDir}/raw-events` })
assertLlmRoute(llmOpts, { requireExplicitBaseUrl: true, allowedBaseUrls, requireAuth: true })

const emitter = new TraceEmitter(store, {
  onRunComplete: [traceAnalystOnRunComplete({ analyze: analystOpts, save })],
})
await emitter.startRun(/* ... */)
// LLM calls flow through callLlm with `{ rawSink: sink, traceContext: { runId, spanId } }`.
await emitter.endRun({ pass, score })

throwIfRunIncomplete(await assertRunCaptured(store, emitter.runId, {
  llmSpansMin: 1, rawSink: sink, requireRawCoverageOfLlmSpans: true, requireOutcome: true,
}))
```

Directives, rationale, and shipped-bug context are in
[`SKILL.md` § Capture integrity](./.claude/skills/agent-eval/SKILL.md#capture-integrity-required-for-launch-grade-adoption).

## Examples

Runnable examples live in
[`examples/`](https://github.com/tangle-network/agent-eval/tree/main/examples).

- [`examples/multi-shot-optimization`](https://github.com/tangle-network/agent-eval/tree/main/examples/multi-shot-optimization):
  optimize full trajectories with held-out promotion.
- [`examples/same-sandbox-harness`](https://github.com/tangle-network/agent-eval/tree/main/examples/same-sandbox-harness):
  run setup/build/test and evidence checks in one workspace.
- [`examples/benchmarks`](https://github.com/tangle-network/agent-eval/tree/main/examples/benchmarks):
  benchmark adapter shape and reference wrappers.

## Docs

Read in this order:

1. [Product Eval Adoption](./docs/product-eval-adoption.md)
2. [Control Runtime](./docs/control-runtime.md)
3. [Feedback Trajectories](./docs/feedback-trajectories.md)
4. [Multi-Shot Optimization](./docs/multi-shot-optimization.md)
5. [Trace Analysis](./docs/trace-analysis.md)
6. [Knowledge Readiness](./docs/knowledge-readiness.md)
7. [Integration Launch Gates](./docs/integration-launch-gates.md)
8. [Wire Protocol](./docs/wire-protocol.md)

## CLI / Wire Protocol

```sh
npm i -g @tangle-network/agent-eval
agent-eval serve --port 5005
```

The Python client lives in `clients/python`:

```sh
cd clients/python
pip install -e .
```

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm openapi
```

## Related Packages

- `@tangle-network/agent-runtime`: production session/runtime layer.
- `@tangle-network/agent-knowledge`: source-grounded knowledge bases and readiness.
- `@tangle-network/agent-integrations`: connection, grant, capability, and integration invocation contracts.

## License

MIT
