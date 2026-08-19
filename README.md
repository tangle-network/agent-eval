# `@tangle-network/agent-eval`

Measure agent behavior, compare changes on the same cases, and improve prompts or skills without showing the final test cases to the optimizer.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

The evaluation path runs in your TypeScript process.
Model calls happen only through the clients and agents you configure.

New to the package? Read [concepts](./docs/concepts.md) first — it takes five minutes and defines every word used here.

Looking for a measured result (a lift, a null, a parity verdict)? The canonical registry is [`evidence/`](./evidence/README.md) — machine-readable records, a generated index, and a freshness gate.

## Install

```sh
pnpm add @tangle-network/agent-eval
```

## Quickstart

This example is offline and complete.
Copy it, run it, then replace the agent and the judge with your product code.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

interface SupportCase {
  id: string
  kind: 'support'
}

const evalKit = defineAgentEval<SupportCase, string>({
  scenarios: [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ],
  agent: async (prompt, scenario) =>
    String(prompt).includes('ticket') ? `Ticket ${scenario.id}: on it.` : 'On it.',
  judge: {
    name: 'ticket-id',
    dimensions: [{ key: 'present', description: 'The answer includes the ticket id' }],
    score: ({ artifact, scenario }) => {
      const present = artifact.includes(scenario.id) ? 1 : 0
      return { dimensions: { present }, composite: present, notes: '' }
    },
  },
  baselineSurface: 'Answer politely.',
  expectUsage: 'off',
})

console.log((await evalKit.evaluate()).aggregates.byJudge)
console.log(
  (await evalKit.evaluate({ surface: 'Answer politely and cite the ticket id.' })).aggregates
    .byJudge,
)
```

Each call runs every case, records what the agent produced, applies the same judge, and returns score distributions.

Three words carry this example.
A **case** is one task the agent must do.
A **surface** is the value being changed: a prompt, a skill, or a serialized configuration.
A **judge** is a function that scores one produced result.

`expectUsage: 'off'` is set because this agent makes no paid calls.
The default, `'assert'`, fails a run whose cells report no cost receipt.
Keep the default whenever real model calls happen.

Runnable copy: [`examples/evaluate-a-change`](./examples/evaluate-a-change/).

## Auditable optimization history

Optimization methods may return a bounded `SearchHistoryReceipt` over Eval's canonical hash-chained `SearchLedger`. Existing callers keep working and see missing-history coverage. Autonomous and publication-grade runs set `searchHistoryPolicy: 'require-complete'` to refuse an incomplete planned denominator before the untouched final cases are opened.

The receipt is a small proof envelope, not another event log. Exact candidates, attempts, failures, decisions, and missing ids remain in the ledger. See [complete optimization search history](./docs/search-history-receipts.md).

## Which Front Door

Every row is a function you call. Each links to a runnable example.

| When to call it | What you give it | What you get back |
|---|---|---|
| [`defineAgentEval()`](./examples/evaluate-a-change/) — you changed a surface and must know whether it helped | cases, an agent, a judge, a starting surface | `evaluate()` for scores, `improve()` for a search plus a release decision |
| [`selfImprove()`](./examples/selfimprove-quickstart/) — you want candidate generation, scoring, and a release decision in one call | cases, an agent, a judge, a starting surface | a report, a winner surface, and a `gateDecision` |
| [`analyzeRuns()`](./examples/analyze-existing-runs/) — the runs already happened and no agent needs to run again | `RunRecord[]` | an `InsightReport`: distributions, paired lift, judge agreement, cost, failure clusters |
| `fromFeedbackTable()` ([example](./examples/customer-feedback-loop/)) / `fromOtelSpans()` ([example](./examples/customer-otel-traces/)) — your data is in a table or an OTel collector, not in `RunRecord` shape | source rows or spans | `RunRecord[]` ready for `analyzeRuns()` |
| [`planCampaignRun()` / `runCampaign()`](./examples/plan-before-you-spend/) — you need direct control of the case grid, or you must see it before paying for it | cases, a dispatch function, judges, a run directory | a per-cell schedule, then a campaign result with cached cells |
| [`loadEvalFixtureScenarios()`](./examples/eval-fixtures-quickstart/) — agents should add cases as folders on disk | `evals/<name>/PROMPT.md` plus checks | `Scenario[]` for `runCampaign()` |
| [`compareOptimizationMethods()`](./examples/compare-optimization-methods/) — two search methods must be compared at equal budget | methods, a starting surface, train, selection, and final cases | per-method final lift, intervals, pairwise contrasts, and cost |
| [`gepaOptimizationMethod()` / `skillOptOptimizationMethod()`](./examples/compare-optimization-methods/) — official GEPA or Microsoft SkillOpt should own the search | an objective, a recipe or trainer, an optimizer budget | an optimization method for the comparison above |
| [`externalTextOptimizationMethod()`](./examples/adapt-a-text-optimizer/) — another package owns text search and you keep the scoring | the package identity, limits, and a `run` callback | the same, with the final cases never exposed |
| [`SurfaceProposer`](./examples/selfimprove-quickstart/) — candidate generation belongs to your product | a `propose()` function | candidates the campaign executes, scores, and gates |
| [`runProfileMatrix()`](./examples/profile-matrix/) — the same cases must run across models or profiles | axes of models and profiles, cases | one row per cell, with an explicit `unknown` model rather than an invented one |
| [`ExperimentTracker`](./examples/experiment-evidence/) — a candidate must beat its parent across N repetitions | reps with scores, run ids, and evidence references | a KEEP / ITERATE / NOISE / REGRESSION verdict with git provenance |
| [`sealExperiment()` / `openSealedExperiment()`](./examples/sealed-experiment/) — the result must convince someone who does not trust you | arms, an admission funnel, an estimand, an interval, a decision table | a hashed rule tree, and executors that can run no other rule |
| [`runEquivalenceCheck()` / `VERIFICATION_STRATEGIES`](./examples/verify-without-an-answer-key/) — the work has no held-out test suite | a claim, two blind arms, an injected checker | a certification that names who vouched and how it can fail |
| [`AnalystRegistry.runExact()`](./examples/custom-trace-analyst/) — a batch of runs failed and you need cited findings | recorded evidence, a declared analyst list | findings with evidence references, an execution plan, and a receipt |
| [`analyzeTraces()`](./docs/trace-analysis.md#answer-one-question) — you have one question about a recorded run ("what first caused this failure?") | stored traces, the question, a DSPy RLM engine with a cost cap | an answer, findings with evidence references, and the investigation trajectory |
| [`runAnalystBenchmark()`](./docs/trace-analysis.md) — an analyst's accuracy must be measured, not assumed | labeled issues and exact span locations | scored findings, trace reads, model calls, tokens, cost, and runtime |
| [`deltaRepair()`](./docs/trace-repair-grader.md) — a finding must be graded by executing the repair it proposes | a trajectory, an analyst finding, a sandbox | the repair's measured effect against a no-fix control |
| [`replayVerify()`](./docs/trajectory-replay.md) — you must know whether a recorded failure still reproduces | a recorded shell trajectory and its pinned image | a re-execution verdict and the divergences found |
| [`analyzeSupervisorRun()`](./docs/adapters-observability.md) — a recursive or supervised run directory must be read | a run directory | counts that stay missing when a measurement is missing, never zero |
| [`buildRlDataset()`](./examples/publish-rl-dataset/) — scored runs should become training data | run records and preferences | reward, preference, and supervised rows |

## Configure Model Calls

Benchmarks, user drivers, executors, built-in judges, completion checkers, and judge adapters all take the same `ChatClient`.

```ts
import { createChatClient } from '@tangle-network/agent-eval'

const chat = createChatClient({
  transport: 'router',
  apiKey: process.env.TANGLE_API_KEY!,
  defaultModel: 'openai/gpt-4.1',
  maximumAttempts: 3,
})
```

Use `direct-provider` for an OpenAI-compatible endpoint, `cli-bridge` for a local subscription, `sandbox-sdk` for Sandbox, or `custom` to adapt another SDK.
A custom adapter must return a `ChatResponse` and declare `maximumAttempts` before a capped cost account can dispatch it.

The official GEPA and SkillOpt optimizers run through a Python bridge.
Install commands, version pins, and the reason for each pin:
[GEPA](./docs/campaign-proposers.md#install-official-gepa),
[SkillOpt](./docs/campaign-proposers.md#install-official-skillopt),
and [DSPy](./docs/campaign-proposers.md#use-official-dspy-optimizers).

## Entry Points

| Import | Use |
|---|---|
| `@tangle-network/agent-eval/contract` | Define an evaluation, run it, improve it, and analyze existing runs. |
| `@tangle-network/agent-eval/campaign` | Campaigns, optimization methods, comparisons, storage, and release rules. |
| `@tangle-network/agent-eval/experiment` | Experiments as sealed objects: registered rules, funnels, estimands, refusals. |
| `@tangle-network/agent-eval/analyst` | Built-in and custom trace analysts, labeled comparison, costs, and reports. |
| `@tangle-network/agent-eval/trace-repair` | Grade one analyst finding by executing the repair it proposes. |
| `@tangle-network/agent-eval/trajectory-replay` | Re-execute a recorded shell trajectory and check whether its failure reproduces. |
| `@tangle-network/agent-eval/traces` | Store, replay, and inspect structured traces. |
| `@tangle-network/agent-eval/reporting` | Statistical comparisons and report rendering. |
| `@tangle-network/agent-eval/supervisor-run` | Read recursive run directories without collapsing missing measurements to zero. |
| `@tangle-network/agent-eval/profile-cell` | Create and validate portable agent-profile identities. |
| `@tangle-network/agent-eval/ledger-core` | Append-only hash-chained journal with idempotent append and chain verification. |
| `@tangle-network/agent-eval/benchmarks` | Benchmark adapters and retrieval metrics. |
| `@tangle-network/agent-eval/rl` | Export rewards, preferences, and training rows. |
| `@tangle-network/agent-eval/wire` | HTTP and RPC schemas for other languages. |

Use the root import for common primitives.
Use a subpath when you want an explicit capability boundary.

## Documentation

| Question | Read |
|---|---|
| What do these words mean? | [`docs/concepts.md`](./docs/concepts.md) |
| Why does this package exist, and where is it going? | [`docs/charter.md`](./docs/charter.md) |
| Which `run*` function do I want? | [`docs/eval-surface-map.md`](./docs/eval-surface-map.md) |
| How do I choose a candidate-generation method? | [`docs/campaign-proposers.md`](./docs/campaign-proposers.md) |
| What is in an `InsightReport`? | [`docs/insight-report.md`](./docs/insight-report.md) |
| How do I register an experiment as a sealed object? | [`docs/experiment.md`](./docs/experiment.md) |
| How is something certified without an answer key? | [`docs/verification-strategies.md`](./docs/verification-strategies.md) |
| Where does every verifier land its result? | [`docs/verdicts.md`](./docs/verdicts.md) |
| How do I score a string from another language? | [`docs/wire-protocol.md`](./docs/wire-protocol.md) |

The [example index](./examples/README.md) lists every runnable example.

## Development

```sh
pnpm install
pnpm typecheck
pnpm typecheck:examples
pnpm test
pnpm build
```

Python compatibility tests use the locked dependencies:

```sh
cd clients/python
uv sync --frozen --extra dev --group gepa-release
AGENT_EVAL_EXPECT_GEPA_RELEASE=1 \
  uv run --frozen --extra dev --group gepa-release \
  pytest tests/test_gepa_release_compatibility.py tests/test_gepa_bridge.py

uv sync --frozen --extra dev --group skillopt-source --group gepa-source
uv run --frozen pytest

uv sync --frozen --extra dev --extra dspy
uv run --frozen pytest tests/test_dspy_metric.py
```

## License

MIT.

