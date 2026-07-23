# `@tangle-network/agent-eval`

A TypeScript library that measures whether your AI agent got better or worse, using the runs it already produces.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

You give it agent runs: outputs, traces, scores, and production feedback.
It gives you numbers you can act on: how much the new prompt changed outcomes, how uncertain that estimate is, what failed and why, and whether the change meets your release rule.

Use it when you need to:

- compare a candidate prompt/model/config against a baseline, with confidence intervals instead of vibes,
- turn production traces or human feedback you already collect into eval results,
- run an automated improve-and-verify loop over a prompt, held to a promotion rule you choose,
- explain failures by cluster, cost, and judge disagreement.

The deterministic evaluator runs in your process and makes no network calls.
Features that use a model send their inputs to the model client you pass.
Trace exporters and hosted ingestion are also opt-in.
Python can drive the same engine over HTTP via [`agent-eval-rpc`](./clients/python/README.md).

---

## Install

```sh
pnpm add @tangle-network/agent-eval   # or npm / yarn
```

```sh
pip install agent-eval-rpc            # optional Python client
```

---

## Quickstart

Copy this into `quickstart.ts` and run `npx tsx quickstart.ts`.
It is fully offline; the "agent" and "judge" are plain functions you replace with your own.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

interface SupportScenario {
  id: string
  kind: 'support'
}

async function main() {
  const scenarios: SupportScenario[] = [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ]

  const evalKit = defineAgentEval<SupportScenario, string>({
    scenarios,
    // Your agent takes the prompt under test and one scenario, then returns its output.
    agent: async (prompt, scenario) =>
      String(prompt).includes('ticket') ? `Re ${scenario.id}: on it.` : 'On it.',
    // Your judge scores one output from 0 to 1. Swap in an LLM judge for real work.
    judge: {
      name: 'cites-ticket',
      dimensions: [{ key: 'ticket_id', description: 'The answer includes the ticket id' }],
      score: ({ artifact, scenario }) => {
        const ticketId = artifact.includes(scenario.id) ? 1 : 0
        return { dimensions: { ticket_id: ticketId }, composite: ticketId, notes: '' }
      },
    },
    baselineSurface: 'Answer the customer politely.',
    expectUsage: 'off',
  })

  console.log('baseline: ', (await evalKit.evaluate()).aggregates.byJudge)
  const candidate = await evalKit.evaluate({ surface: 'Answer politely, cite the ticket id.' })
  console.log('candidate:', candidate.aggregates.byJudge)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
```

Output:

```
baseline:  { 'cites-ticket': { mean: 0, stdev: 0, ci95: [ 0, 0 ], n: 3 } }
candidate: { 'cites-ticket': { mean: 1, stdev: 0, ci95: [ 1, 1 ], n: 3 } }
```

Each `evaluate()` call runs every scenario through the agent, scores each output with the judge, and returns per-judge score distributions.
The "surface" is the thing you are changing: here a system-prompt string, and in general any prompt or config value.
From the same definition, `evalKit.improve()` proposes candidate prompts, measures each one, and checks the winner against a held-back scenario set before recommending it.
The default candidate generator calls a model, so pass `llm: { baseUrl, apiKey, model }` to `.improve()` or provide your own `proposer`.

Already have run data and no runnable agent? Skip the loop and call [`analyzeRuns()`](./docs/concepts.md#the-top-level-functions) on your existing records instead.

### Use A Model Judge

`llmJudge()` converts one model call into the same `JudgeConfig` used above:

```ts
import { createChatClient, llmJudge } from '@tangle-network/agent-eval/contract'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('OPENAI_API_KEY is required')

const chat = createChatClient({
  transport: 'direct-provider',
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey,
  defaultModel: 'gpt-4.1-mini',
})

const judge = llmJudge<string, SupportScenario>(
  'support-quality',
  'Score whether the response resolves the request using only supported facts.',
  {
    chat,
    dimensions: [
      { key: 'correct', description: 'The answer is factually correct' },
      { key: 'complete', description: 'The answer addresses the whole request' },
    ],
  },
)
```

Pass `judge` to `defineAgentEval()` in place of the offline judge.
The model receives the scenario, artifact, scoring prompt, and dimension descriptions.

### Compare Optimization Methods

Use `compareOptimizationMethods()` when you need to compare complete search procedures rather than individual prompts.
The function gives every method the same baseline, runner, judges, train data, and selection data, then ranks their selected surfaces on separate final test data.

```ts
import {
  type BuiltinOptimizationMethodConfig,
  compareOptimizationMethods,
  gepaParetoMethod,
  gepaReflectionMethod,
  skillOptMethod,
} from '@tangle-network/agent-eval/campaign'

const methodConfig: BuiltinOptimizationMethodConfig<MyScenario, MyArtifact> = {
  llm,
  model,
  target: 'the complete prompt being improved',
}

const result = await compareOptimizationMethods<MyScenario, MyArtifact>({
  methods: [
    gepaReflectionMethod(methodConfig),
    gepaParetoMethod(methodConfig),
    skillOptMethod(methodConfig),
  ],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir,
})
```

Read `result.scores` for lift and intervals.
Read `result.totalCost` for dollars plus whether every charge was known.
Ranks follow estimated lift; use the intervals and pairwise results to determine whether the observed difference excludes zero.
See the [method-comparison guide](./docs/campaign-proposers.md) and [runnable example](./examples/compare-optimization-methods/).

---

## Core APIs

Start from `/contract` for the common path.
Use `/campaign` when you need direct control over runs, candidate generation, or method comparison.

| Primitive | What it does |
|---|---|
| **Evaluation** (`runEval`, `runCampaign`) | Run agent × scenarios × repetitions, score every run, and record the result. |
| **Scoring** (`JudgeConfig`, `llmJudge`, calibration) | Score one output on weighted dimensions with code or a model, then compare model scores against human ratings. |
| **Release rules** (`heldOutGate`, `paretoSignificanceGate`, `composeGate`, …) | Decide whether a candidate ships, such as requiring an improvement on scenarios that candidate generation never saw. |
| **Candidate generation** (`gepaProposer`, `evolutionaryProposer`, …) | Generate candidate prompts or configs from prior failures. |
| **Method comparison** (`compareOptimizationMethods`) | Run complete optimization methods on shared train and selection data, then rank them on separate final test data. |
| **Run analysis** (`analyzeRuns`, `diffRuns`) | Turn any set of `RunRecord`s into a report: score distributions, baseline-vs-candidate lift with confidence intervals, failure clusters, cost breakdown, recommendations. |
| **Intake adapters** (`fromFeedbackTable`, `fromOtelSpans`) | Convert data you already have, such as human ratings tables and OpenTelemetry spans, into `RunRecord`s. |
| **Cost tracking** | Attribute every model call's tokens and dollars to the run, phase, and judge that spent them, including interrupted calls. |
| **Human feedback storage** | Persist runs with approved, rejected, or edited labels so review activity becomes training and eval data. |
| **Statistics** (`pairedBootstrap`, `benjaminiHochberg`, sequential tests) | The release-decision math, usable standalone. |
| **Trace tools** (`/traces`, `/analyst`) | Store and replay structured run traces; cluster failures with an LLM analyst panel. |
| **HTTP and RPC** (`/wire`) | Expose judging and ingestion to non-TypeScript stacks, including the Python client. |

Our own experiments with these primitives live in [`examples/`](./examples/README.md); they are demonstrations, not part of the API.

| Runnable example | Shows |
|---|---|
| [`examples/selfimprove-quickstart/`](./examples/selfimprove-quickstart/) | The closed improve-and-verify loop, fully offline |
| [`examples/customer-feedback-loop/`](./examples/customer-feedback-loop/) | Multi-rater human feedback (CSV/Sheets/Obsidian) → per-rater judges → report |
| [`examples/customer-otel-traces/`](./examples/customer-otel-traces/) | Production OpenTelemetry traces → report, no closed loop required |
| [`examples/compare-optimization-methods/`](./examples/compare-optimization-methods/) | Compare complete optimization methods with separate train, selection, and test data |

Each is a single `index.ts` you run with `pnpm tsx`.

---

## Entry points

Import from `@tangle-network/agent-eval/<subpath>`. Every row below is verified importable from the published package.

| Subpath | What it gives you |
|---|---|
| `/contract` | **Start here.** Stable APIs for defining an eval, running it, improving a prompt, judging outputs, analyzing existing runs, and storing results. |
| `/campaign` | Lower-level control over candidate generation, release rules, storage, and comparisons. |
| `/reporting` | Statistical comparisons and report renderers. |
| `/analyst` | Model-based failure clustering and stored findings. |
| `/traces` | Trace stores, emitters, deterministic replay, trace analysis. |
| `/rl` | Export eval artifacts as training signal: rewards, preferences, trainer-format datasets. |
| `/benchmarks` | Benchmark adapter contract + retrieval metrics + a bundled reference benchmark. |
| `/wire` | The HTTP/RPC server and Zod schemas (what the Python client speaks). |
| `/hosted` | Client for shipping eval-run events to a remote orchestrator (see below). |
| `/control` | A generic observe → validate → decide → act agent loop with eval-backed stopping rules. |
| `/matrix`, `/multishot` | N-axis configuration sweeps; multi-turn persona × turn-count runners. |
| `/meta-eval`, `/belief-state`, `/builder-eval`, `/pipelines`, `/storyboard`, `/authenticity`, `/fuzz`, `/trace-attributes` | Specialized surfaces: judge calibration, decision-point extraction, code-generator grading, trace diagnostics, run replay rendering, anti-gaming output checks, input fuzzing, trace attribute vocabulary. |

The root export (`@tangle-network/agent-eval`) remains broad for compatibility; prefer the subpaths for new code.

---

## Documentation

- [`docs/concepts.md`](./docs/concepts.md): the mental model for runs, judges, verifiers, traces, and the top-level functions (5-minute read)
- [`docs/customer-journeys.md`](./docs/customer-journeys.md): three complete adoption paths with code
- [`docs/insight-report.md`](./docs/insight-report.md): annotated walkthrough of every section of the `analyzeRuns()` report
- [`docs/campaign-proposers.md`](./docs/campaign-proposers.md): candidate generation and fair comparison of complete optimization methods
- [`docs/adapters-observability.md`](./docs/adapters-observability.md): composing with LangSmith, Langfuse, Phoenix, and OpenLLMetry
- [`docs/wire-protocol.md`](./docs/wire-protocol.md): the HTTP/RPC contract for other languages
- [`docs/design.md`](./docs/design.md): how this package relates to the rest of the Tangle agent stack, and the dependency rules that keep it reusable
- [`CHANGELOG.md`](./CHANGELOG.md): every release, with additive and breaking changes identified

---

## Optional hosted tier

The library is complete without it.
If you want a dashboard over many loops, point any run at our remote orchestrator or your own implementation of the [open ingest spec](./docs/hosted-ingest-spec.md):

```ts
await evalKit.improve({
  hostedTenant: {
    endpoint: 'https://intelligence.tangle.tools',
    apiKey: process.env.TANGLE_API_KEY!,
    tenantId: 'your-tenant',
  },
})
```

The loop still runs in your process.
Hosted ingest sends run identifiers and paths, scenario IDs, candidate surfaces, scores, errors, costs, summaries, and trace attributes.
Review the [wire format](./docs/hosted-ingest-spec.md) before enabling it for sensitive inputs.
A reference receiver you can self-host is at [`examples/hosted-ingest-server/`](./examples/hosted-ingest-server/).

---

## Development

```sh
pnpm install
pnpm build
pnpm test        # vitest, ~3300 tests
pnpm typecheck
```

Run any example: `pnpm tsx examples/selfimprove-quickstart/index.ts`

---

## License

MIT. See [`LICENSE`](./LICENSE).
