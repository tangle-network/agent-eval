# `@tangle-network/agent-eval`

Evaluate and improve AI agents from the runs they already produce.

`agent-eval` turns agent outputs, traces, judge scores, and production feedback into a decision packet: did this change help, what failed, what should ship, and what needs more data?

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Use it when you need to:

- compare a candidate agent/prompt/model against a baseline,
- turn production traces or human feedback into eval results,
- run a gated self-improvement loop,
- explain failures by cluster, cost, judge disagreement, and release risk.

It is a library, not a SaaS requirement. TypeScript is first-class; Python can call the same wire protocol through `agent-eval-rpc`.

---

## Install

```sh
pnpm add @tangle-network/agent-eval
```

Python clients can use the RPC package:

```sh
pip install agent-eval-rpc
```

---

## Quick start

### 1. Analyze runs you already have

Start here if you already have production logs, benchmark rows, human ratings, or agent run records.

```ts
import { analyzeRuns } from '@tangle-network/agent-eval/contract'

const report = await analyzeRuns({
  runs, // RunRecord[]
  baselineRuns,
})

console.log(report.recommendations)
console.log(report.lift)
console.log(report.failureClusters)
```

The output includes score distributions, lift confidence intervals, failure modes, cost-quality tradeoffs, judge agreement, contamination checks, and release recommendations when the input supports them.

### 2. Run a gated improvement loop

Use this when you have scenarios, a runnable agent, and judges.

```ts
import { selfImprove } from '@tangle-network/agent-eval/contract'

const result = await selfImprove({
  scenarios,
  dispatch: async ({ scenario }) => myAgent.run(scenario),
  judges: [myJudge],
  baselineSurface: { systemPrompt: currentPrompt },
})

console.log(result.gateDecision)
console.log(result.winnerSurface)
console.log(result.insight.recommendations)
```

`selfImprove()` evaluates candidates on held-out scenarios before recommending a winner.

### 3. Adapt existing data

```ts
import { analyzeRuns, fromFeedbackTable, fromOtelSpans } from '@tangle-network/agent-eval/contract'

const { runs, raterScores } = fromFeedbackTable({
  ratings: parseYourFeedbackTable(),
})

const traceRuns = fromOtelSpans({ spans: yourOtelSpans })

await analyzeRuns({ runs: [...runs, ...traceRuns], raterScores })
```

---

## Core concepts

- **RunRecord**: the durable row for one agent run: model, prompt/config hashes, split, cost, tokens, outcome.
- **Scenario**: one task or case the agent attempts.
- **Judge**: a scoring function, rule-based or model-based.
- **InsightReport**: the decision packet returned by `analyzeRuns()` and embedded in `selfImprove()`.
- **Gate**: the policy that decides `ship`, `hold`, or `need_more_data`.

## Examples

| Journey | Example | Who it's for |
|---|---|---|
| **Closed loop** — improve a prompt under statistical confidence | [`examples/selfimprove-quickstart/`](./examples/selfimprove-quickstart/) | Teams with scenarios + judges + agent in hand |
| **Multi-rater feedback corpus** — turn Obsidian/Sheets/CSV ratings into actionable insights | [`examples/customer-feedback-loop/`](./examples/customer-feedback-loop/) | Teams reviewing AI outputs by hand who want to compress that taste into per-member LLM judges + close the loop |
| **Production OTel traces** — analyze logs you already have, no closed loop required | [`examples/customer-otel-traces/`](./examples/customer-otel-traces/) | Teams running agents in prod with observability, no eval discipline yet |

Each example: `README.md` + a single `index.ts` runnable via `pnpm tsx`. Prints the resulting `InsightReport` to stdout.

---

## Subpath entry points

| Subpath | What it gives you |
|---|---|
| `…/contract` | **The headline, frozen surface — new code starts here.** `selfImprove`, `analyzeRuns`, `runEval`, `runCampaign`, `runImprovementLoop`, `diffRuns`; intake adapters (`fromFeedbackTable`, `fromOtelSpans`); proposers (`gepaProposer`, `evolutionaryProposer`); gates (`defaultProductionGate`, `heldOutGate`, `paretoSignificanceGate`, `composeGate`); the deployment-outcome store; storage; and the five core types `Scenario` / `Dispatch` / `JudgeConfig` / `SurfaceProposer` / `Gate`. |
| `…/hosted` | `createHostedClient` / `hostedClientFromEnv` + the wire types to ship eval-run events + trace spans to a hosted orchestrator (ours or your own implementation of the spec) |
| `…/adapters/otel` | `createOtelBridge` — forwards OpenTelemetry-shape spans into the hosted-tier ingest, no `@opentelemetry/*` dependency |
| `…/adapters/langchain` | Wrap any LangChain `Runnable` as a `Dispatch` (or `JudgeConfig`), no `@langchain/core` peer dep |
| `…/adapters/http` | `httpDispatch` + `runDispatchServer` — run a campaign's worker on another machine (multi-region, remote worker execution) |
| `…/campaign` | **The measurement + improvement engine**: `runProfileMatrix`, `compareProposers`, every surface proposer (`gepaProposer`, `fapoProposer`, `parameterSweepProposer`, `haloProposer`, `skillOptProposer`, `aceProposer`, `memoryCurationProposer`, …), the gates, storage backends, and loop provenance. `/contract` re-exports the app-facing subset. |
| `…/rl` | Bridge from eval artifacts to training signal: verifiable rewards, preferences, OPE, tournaments, contamination, compute curves, trainer-format exporters, process rewards, plus the durable corpus + `buildRlDataset` / datasheet bundle |
| `…/reporting` | Release-decision statistics: `pairedBootstrap`, `benjaminiHochberg`, anytime-valid sequential e-values, `evaluateReleaseConfidence`, and the report renderers |
| `…/analyst` | The trace-analyst surface: `AnalystRegistry` + `buildDefaultAnalystRegistry` (run the failure-clustering panel), `FindingsStore`, and the LLM chat transports |
| `…/traces` | Trace stores + emitters, OTLP-JSONL deterministic replay, `analyzeTraces`, and the `traceAnalystOnRunComplete` hook |
| `…/control` | Agent control loop: `runAgentControlLoop` (observe → validate → decide → act), action policy, propose/review |
| `…/matrix` | `runAgentMatrix` — an N-axis cartesian over caller-supplied substrate values, per-axis pass/score/cost/duration |
| `…/multishot` | N-shot persona × shot matrix runner (`runMultishot` / `runMultishotMatrix`) |
| `…/wire` | The cross-language HTTP/RPC server + Zod schemas (the source-of-truth protocol the Python client speaks) + the built-in rubric registry |
| `…/benchmarks` | `BenchmarkAdapter` contract + `deterministicSplit` + the bundled `routing` reference benchmark |

**Specialized surfaces** (subpath-only): `…/prm` (process-reward grading + best-of-N), `…/meta-eval` (judge calibration + the deployment-outcome store), `…/belief-state` (decision-point extraction + selective-policy reports), `…/pipelines` (trace-diagnostic views: budget breach, failure cluster, stuck loop, …), `…/governance` (EU AI Act / NIST AI RMF / SOC2 reports), `…/knowledge` (knowledge-readiness gating before a run), `…/builder-eval` (code-generator three-layer eval), `…/storyboard` (trace → watchable replay), `…/authenticity` (anti-Goodhart "real or convincing BS" scorer over produced files), `…/workflow` (workflow-trace eval + partner export), `…/telemetry` (Workers-safe telemetry client), `…/testing` (test-only reset helpers).

The root export remains broad for compatibility; new code should prefer the focused subpaths above — `/contract` first.

---

## Composition with the stack

agent-eval is the bottom of the layering: consumers depend on it, it depends on none of them.

```
agent-runtime    Runs agents (chat turns, one-shot tasks, multi-attempt loops), captures every
                 run as a trace, and calls optimizePrompt / runImprovementLoop. Produces the
                 RunRecords + traces agent-eval scores. Depends on agent-eval.

agent-eval       selfImprove, analyzeRuns, runCampaign + surface proposers (GEPA proposer, …), the gates
   (this repo)   (heldOutGate, defaultProductionGate, paretoSignificanceGate), the InsightReport
                 decision packet, the RL bridge, the wire protocol. Depends on neither consumer.

agent-knowledge  proposeKnowledgeWrites / applyKnowledgeWriteBlocks. agent-eval's analyst findings
                 feed it; the knowledge gate consumes them. Depends on agent-eval.

sandbox          Sandbox.create, streamPrompt. One execution surface the runtime's
                 loops run on; agent-eval scores what comes back.
```

The rule: **agent-eval has zero upward dependencies on a consumer.** A concept that makes sense *without* a running agent loop — a verdict, a run record, a scenario, a judge score — is substrate and lives here. Runtime execution details (a validation context with an abort signal, a concrete sandbox session) live in agent-runtime or sandbox. Agent profile shape is the shared `@tangle-network/agent-interface` contract.

---

## Concepts + design

- [`docs/concepts.md`](./docs/concepts.md) — the three top-level functions, the layering rule, and the wire-protocol contract (the five core contract types are documented in the `/contract` barrel itself)
- [`docs/campaign-proposers.md`](./docs/campaign-proposers.md) — ELI5 proposer inputs/outputs, when to use each proposer, and the FAPO escalation policy
- [`docs/insight-report.md`](./docs/insight-report.md) — annotated walkthrough of every section of the decision packet
- [`docs/customer-journeys.md`](./docs/customer-journeys.md) — three end-to-end journeys with code + expected output
- [`docs/adapters-observability.md`](./docs/adapters-observability.md) — composing agent-eval with LangSmith, Langfuse, Phoenix, OpenLLMetry, TraceAI
- [`docs/wire-protocol.md`](./docs/wire-protocol.md) — the HTTP/RPC contract Python (and any future language) speaks
- [`docs/hosted-ingest-spec.md`](./docs/hosted-ingest-spec.md) — the hosted-tier wire format, frozen at `2026-05-26.v1`
- [`docs/design/loop-taxonomy.md`](./docs/design/loop-taxonomy.md) — plain-language vocabulary for execution drivers, workers, measurements, and proposers

The `.claude/skills/agent-eval/SKILL.md` skill ships embedded directives so LLM agents writing integration code don't reintroduce historical bug classes.

---

## Hosted tier

Wire your loop to a hosted orchestrator (ours, or your own implementation of the spec) with one config:

```ts
await selfImprove({
  scenarios, dispatch, judges, baselineSurface,
  hostedTenant: {
    endpoint: 'https://intelligence.tangle.tools',
    apiKey: process.env.TANGLE_API_KEY!,
    tenantId: 'your-tenant',
  },
})
```

The substrate runs the loop in your process. Only the eval-run events + (optional) trace spans go to the orchestrator. Your scenarios, your judges, your raw data — never sent. Spec at [`docs/hosted-ingest-spec.md`](./docs/hosted-ingest-spec.md); reference receiver at [`examples/hosted-ingest-server/`](./examples/hosted-ingest-server/).

---

## Development

Run an example:

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
pnpm tsx examples/customer-feedback-loop/index.ts
pnpm tsx examples/customer-otel-traces/index.ts
```

Run the test suite:

```sh
pnpm install
pnpm build
pnpm test
```

---

## Public API

The `/contract` surface is the **stability contract**: its barrel freezes the API — a `0.x` minor only *adds*; nothing there changes shape or disappears. Start there for app code.

| Surface | Meaning |
|---|---|
| `/contract` | Frozen app-facing API. Prefer this first. |
| Named subpaths | Public capability areas such as `/campaign`, `/rl`, `/prm`, `/meta-eval`, `/belief-state`, `/wire`, `/reporting`, `/traces`, and `/analyst`. |
| `/testing` | Test-only helpers. Do not import from production code. |
| Unexported source paths | Not public API. Open an issue if you need one promoted. |

[`CHANGELOG.md`](./CHANGELOG.md) tracks every release with what's new / additive / breaking.

---

## License

MIT. See [`LICENSE`](./LICENSE).
