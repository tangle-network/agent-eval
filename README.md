# `@tangle-network/agent-eval`

A TypeScript library that measures whether your AI agent got better or worse, using the runs it already produces.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

You give it agent runs — outputs, traces, scores, production feedback.
It gives you numbers you can act on: did the new prompt beat the old one, is the difference statistically real, what failed and why, and whether the change should ship.

Use it when you need to:

- compare a candidate prompt/model/config against a baseline, with confidence intervals instead of vibes,
- turn production traces or human feedback you already collect into eval results,
- run an automated improve-and-verify loop over a prompt, held to a promotion rule you choose,
- explain failures by cluster, cost, and judge disagreement.

Everything runs in your process. No hosted service is required, and no data leaves your machine unless you explicitly wire an exporter.
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

Copy this into `quickstart.ts` and run `npx tsx quickstart.ts`. It is fully offline — the "agent" and "judge" are plain functions you replace with your own.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

const evalKit = defineAgentEval({
  scenarios: [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ],
  // Your agent: takes the prompt under test + one scenario, returns its output.
  agent: async (prompt, scenario) =>
    String(prompt).includes('ticket') ? `Re ${scenario.id}: on it.` : 'On it.',
  // Your judge: scores one output 0..1. Swap in an LLM judge for real work.
  judge: {
    name: 'cites-ticket',
    dimensions: [{ key: 'grounded', weight: 1 }],
    score: ({ artifact, scenario }) => {
      const grounded = artifact.includes(scenario.id) ? 1 : 0
      return { dimensions: { grounded }, composite: grounded, notes: '' }
    },
  },
  baselineSurface: 'Answer the customer politely.',
  expectUsage: 'off',
})

console.log('baseline: ', (await evalKit.evaluate()).aggregates.byJudge)
const candidate = await evalKit.evaluate({ surface: 'Answer politely, cite the ticket id.' })
console.log('candidate:', candidate.aggregates.byJudge)
```

Output:

```
baseline:  { 'cites-ticket': { mean: 0, stdev: 0, ci95: [ 0, 0 ], n: 3 } }
candidate: { 'cites-ticket': { mean: 1, stdev: 0, ci95: [ 1, 1 ], n: 3 } }
```

Each `evaluate()` call runs every scenario through the agent, scores each output with the judge, and returns per-judge score distributions.
The "surface" is the thing you are changing — here a system-prompt string, in general any prompt or config value.
From the same definition, `evalKit.improve()` runs the full loop: propose candidate prompts, measure each one, and check the winner against a held-back scenario set before recommending it.

Already have run data and no runnable agent? Skip the loop and call [`analyzeRuns()`](./docs/concepts.md#the-top-level-functions) on your existing records instead.

---

## What's in the box

One-line tour of the primitives. All of these are plain functions and interfaces you compose; start from `/contract` and pull in more only when you need it.

| Primitive | What it does |
|---|---|
| **Campaigns** (`runEval`, `runCampaign`) | Run agent × scenarios × repetitions, score every run, record every run as a durable `RunRecord` row. |
| **Judges** (`JudgeConfig`, LLM judge helpers, calibration) | Score one output on weighted dimensions. Rule-based or model-based, plus tools to check a judge against human ratings before trusting it. |
| **Gates** (`heldOutGate`, `paretoSignificanceGate`, `composeGate`, …) | The rule that decides whether a candidate ships: e.g. "must beat baseline on held-back scenarios with a confidence interval that excludes zero." |
| **Proposers** (`gepaProposer`, `evolutionaryProposer`, …) | Generate candidate prompts/configs from what failed, for the improve loop to measure. |
| **Run analysis** (`analyzeRuns`, `diffRuns`) | Turn any set of `RunRecord`s into a report: score distributions, baseline-vs-candidate lift with confidence intervals, failure clusters, cost breakdown, recommendations. |
| **Intake adapters** (`fromFeedbackTable`, `fromOtelSpans`) | Convert data you already have — human ratings tables, OpenTelemetry spans — into `RunRecord`s. |
| **Cost ledger** | Attribute every LLM call's tokens and dollars to the run, phase, and judge that spent them, including interrupted calls. |
| **Labeled store** | Persist runs with labels (approved/rejected/edited) so review activity becomes training and eval data. |
| **Statistics** (`pairedBootstrap`, `benjaminiHochberg`, sequential tests) | The release-decision math, usable standalone. |
| **Trace tools** (`/traces`, `/analyst`) | Store and replay structured run traces; cluster failures with an LLM analyst panel. |
| **Wire protocol** (`/wire`) | HTTP/RPC server + schemas so non-TypeScript stacks (Python today) can call the same engine. |

Our own experiments with these primitives live in [`examples/`](./examples/README.md) — they are demonstrations, not part of the API.

| Runnable example | Shows |
|---|---|
| [`examples/selfimprove-quickstart/`](./examples/selfimprove-quickstart/) | The closed improve-and-verify loop, fully offline |
| [`examples/customer-feedback-loop/`](./examples/customer-feedback-loop/) | Multi-rater human feedback (CSV/Sheets/Obsidian) → per-rater judges → report |
| [`examples/customer-otel-traces/`](./examples/customer-otel-traces/) | Production OpenTelemetry traces → report, no closed loop required |

Each is a single `index.ts` you run with `pnpm tsx`.

---

## Entry points

Import from `@tangle-network/agent-eval/<subpath>`. Every row below is verified importable from the published package.

| Subpath | What it gives you |
|---|---|
| `/contract` | **Start here.** The frozen app-facing API: `defineAgentEval`, `selfImprove`, `analyzeRuns`, `runEval`, `runCampaign`, `runImprovementLoop`, `diffRuns`, the intake adapters, the standard proposers and gates, and the core types. A `0.x` minor only adds to this surface; nothing changes shape or disappears. |
| `/campaign` | The full measurement + improvement engine behind `/contract`: every proposer, gate, storage backend, and multi-axis comparison runner. |
| `/reporting` | Release-decision statistics and report renderers. |
| `/analyst` | LLM failure-clustering panel + findings store. |
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

- [`docs/concepts.md`](./docs/concepts.md) — the mental model: runs, judges, verifiers, traces, and the top-level functions (5-minute read)
- [`docs/customer-journeys.md`](./docs/customer-journeys.md) — three end-to-end adoption paths with code
- [`docs/insight-report.md`](./docs/insight-report.md) — annotated walkthrough of every section of the `analyzeRuns()` report
- [`docs/campaign-proposers.md`](./docs/campaign-proposers.md) — which proposer to use and when
- [`docs/adapters-observability.md`](./docs/adapters-observability.md) — composing with LangSmith, Langfuse, Phoenix, OpenLLMetry
- [`docs/wire-protocol.md`](./docs/wire-protocol.md) — the HTTP/RPC contract for other languages
- [`docs/design.md`](./docs/design.md) — design rationale: how this package relates to the rest of the Tangle agent stack, and the dependency rules that keep it reusable
- [`CHANGELOG.md`](./CHANGELOG.md) — every release, with what's new / additive / breaking

---

## Optional hosted tier

The library is complete without it. If you want a dashboard over many loops, point any run at a remote orchestrator — ours, or your own implementation of the [open ingest spec](./docs/hosted-ingest-spec.md):

```ts
await evalKit.improve({
  hostedTenant: {
    endpoint: 'https://intelligence.tangle.tools',
    apiKey: process.env.TANGLE_API_KEY!,
    tenantId: 'your-tenant',
  },
})
```

The loop still runs in your process. Only eval-run events and (optionally) trace spans are sent — never your scenarios, judges, or raw data. A reference receiver you can self-host is at [`examples/hosted-ingest-server/`](./examples/hosted-ingest-server/).

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
