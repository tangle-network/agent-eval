# `@tangle-network/agent-eval`

**Decision-grade evals for agents.** One function call returns a decision packet — lift CI, judge calibration, contamination check, failure clusters, cost-quality Pareto, and a ranked action list — with the same shape whether you have a closed improvement loop or just production logs.

It is the **substrate at the bottom of the stack**: [`@tangle-network/agent-runtime`](https://www.npmjs.com/package/@tangle-network/agent-runtime) runs agents and captures every run as a trace, then delegates scoring and the ship gate here. The dependency arrow only points up — agent-eval never imports the runtime.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> TypeScript first-class, Python (`agent-eval-rpc`) speaks the same wire protocol, hosted-tier-friendly, MIT, self-hostable, no SaaS dependency.

---

## Table of contents

- [What you get back](#what-you-get-back-the-decision-packet)
- [Quick start](#quick-start)
  - [Closed loop — `selfImprove()`](#closed-loop--selfimprove)
  - [Observed runs — `analyzeRuns()`](#observed-runs--analyzeruns)
  - [Existing data — intake adapters](#existing-data--intake-adapters)
- [How it compares](#how-it-compares)
- [Customer journeys](#customer-journeys)
- [Subpath entry points](#subpath-entry-points)
- [Concepts + design](#concepts--design)
- [Hosted tier](#hosted-tier)
- [Install + run](#install--run)
- [Stability + versioning](#stability--versioning)
- [License](#license)

---

## What you get back: the decision packet

Whether you call `selfImprove()` (closed loop) or `analyzeRuns()` (observed runs), the report has the same shape. Here's a real one, abridged:

```jsonc
{
  "n": 80,                                            // runs analyzed
  "composite": {                                       // distributional summary
    "mean": 0.62, "p50": 0.65, "p95": 0.88, "stddev": 0.17,
    "histogram": [/* 12 bins */]
  },
  "lift": {                                            // paired bootstrap
    "baselineMean": 0.58, "candidateMean": 0.65,
    "delta": 0.07,
    "ci95": [0.04, 0.10],                              // 95% CI on the delta
    "pValue": 0.0008,                                  // paired-t
    "cohensD": 0.41,
    "n": 40,
    "mde": 0.06,                                       // min detectable effect at 80% power
    "requiredN": 38                                    // n needed to detect observed delta
  },
  "judges": {                                          // per-judge calibration
    "domain-expert": { "n": 80, "meanScore": 0.64 },
    "helpfulness-llm": { "n": 80, "meanScore": 0.61 }
  },
  "interRater": {                                      // multi-rater agreement
    "raters": 3, "jointlyRated": 80, "kappa": 0.71,
    "disagreementCases": [/* top 20 ranked by spread */]
  },
  "costQuality": {                                     // cost-vs-quality
    "cost": { "mean": 0.024, "p95": 0.041, /* ... */ },
    "pareto": { /* ParetoFigureSpec the dashboard renders */ }
  },
  "failureClusters": {                                 // when an AnalystRegistry is wired
    "totalFailures": 11,
    "clusters": [
      { "name": "off-topic-drift",  "share": 0.45, "exemplars": ["run-12", "run-19"] },
      { "name": "over-confidence",  "share": 0.27, "exemplars": ["run-3"] },
      { "name": "format-mismatch",  "share": 0.18, "exemplars": ["run-41"] }
    ]
  },
  "contamination": { "leaks": 0, "holdoutAuditPassed": true },
  "outcomeCorrelation": {                              // when downstream metric supplied
    "metric": "engagement_rate", "n": 80,
    "pearson": 0.72, "spearman": 0.69,
    "rewardModel": { "intercept": 0.04, "slope": 1.93, "r2": 0.52 }
  },
  "release": {
    "status": "pass",
    "axes": [
      { "name": "quality-lift",          "status": "pass" },
      { "name": "contamination",         "status": "pass" },
      { "name": "composite-distribution","status": "pass" }
    ]
  },
  "recommendations": [
    { "priority": "critical", "kind": "ship",
      "title": "Ship — lift 0.070 (95% CI 0.040..0.100)",
      "detail": "Holdout lift exceeds threshold 0.02 with 95% bootstrap confidence (n=40, p=0.0008, d=0.41)." },
    { "priority": "high", "kind": "investigate",
      "title": "Top failure cluster: off-topic-drift (45% of failures)",
      "detail": "11 runs failed. Drill into exemplars run-12 / run-19 to identify the pattern." }
  ]
}
```

The `recommendations` array is the human-readable layer; everything above it is the evidence. Read the recs, act on them, the numbers are the proof.

---

## Quick start

### Closed loop — `selfImprove()`

You have scenarios, a dispatch, judges, and want the loop to propose better prompts + tell you which to ship.

```ts
import { selfImprove } from '@tangle-network/agent-eval/contract'

const result = await selfImprove({
  scenarios,                                // your scenario corpus
  dispatch: async ({ scenario }) =>          // your agent — anything that returns an artifact
    await myAgent.run(scenario),
  judges: [myJudge],                         // any JudgeConfig — LLM, rule, ensemble
  baselineSurface: { systemPrompt: currentPrompt },
})

result.gateDecision         // 'ship' | 'hold' | 'need_more_work' | ...
result.lift                 // raw delta on holdout
result.insight              // the full decision packet above
```

### Observed runs — `analyzeRuns()`

You don't have a closed loop yet — you have observed runs (production traces, an approve/reject corpus, a CSV gold set). Same report shape, no agent invocation.

```ts
import { analyzeRuns } from '@tangle-network/agent-eval/contract'

const report = await analyzeRuns({
  runs,                                     // RunRecord[]
  outcomeSignal: {                          // optional — closes the loop on real outcomes
    metric: 'engagement_rate',
    valueByRunId: enrichedFromProd,
  },
  canaryScenarios,                          // optional — contamination probe
  analyst: myAnalystRegistry,               // optional — AI-powered failure clustering
})

report.recommendations    // ranked actions
report.failureClusters    // grouped failure modes
report.outcomeCorrelation // judge↔outcome correlation + linear reward model
```

### Existing data — intake adapters

You have data already. Don't reshape it — pipe it through an adapter.

```ts
import {
  fromFeedbackTable,
  fromOtelSpans,
  analyzeRuns,
} from '@tangle-network/agent-eval/contract'

// Multi-rater approve/reject (Obsidian tags, Sheets, CSV, Postgres).
const { runs, raterScores } = fromFeedbackTable({
  ratings: parseYourFeedbackTable(),         // Array<{ runId, rater, rating }>
})
await analyzeRuns({ runs, raterScores })

// Production OTel traces — group by tangle.runId or traceId.
const runs2 = fromOtelSpans({ spans: yourOtelStream })
await analyzeRuns({ runs: runs2 })
```

Both intake adapters preserve every signal in the source — multi-rater scores stay rater-keyed so the report can compute inter-rater agreement and surface the disagreement triage list.

---

## How it compares

| | LangSmith | Braintrust | Phoenix | **agent-eval** |
|---|:---:|:---:|:---:|:---:|
| Closed-loop self-improvement | ✱ human-in-loop | ✱ experiment-driven | — | ✓ autonomous + gated |
| Statistical lift CI (paired bootstrap) | — | partial | — | ✓ |
| Judge calibration + bias detection | — | — | — | ✓ |
| Inter-rater agreement + disagreement triage | — | — | — | ✓ |
| Contamination / canary check | — | — | — | ✓ |
| AI-driven failure clustering | partial | — | partial | ✓ |
| Cost-quality Pareto | — | — | — | ✓ |
| Multi-language clients (TS + Python) | TS only | TS only | TS + Py | ✓ TS + Py |
| Self-hostable / no-SaaS option | — | — | OSS | ✓ MIT, OSS |
| Substrate vs SaaS shape | SaaS | SaaS | OSS server | **library** |
| Hosted tier (optional) | required | required | optional | optional |

Position: agent-eval is the **substrate** (one library, decision-grade output) the others are SaaS *around* the substrate. If you want a closed loop that ships your prompt under statistical confidence, you call agent-eval. If you want a dashboard rendered from your data, you pipe agent-eval into the hosted tier or your own renderer.

---

## Customer journeys

Three runnable examples — each is self-contained, each shows the actual output.

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
| `…/contract` | **The headline, frozen surface — new code starts here.** `selfImprove`, `analyzeRuns`, `runEval`, `runCampaign`, `runImprovementLoop`, `diffRuns`; intake adapters (`fromFeedbackTable`, `fromOtelSpans`); drivers (`gepaDriver`, `evolutionaryDriver`); gates (`defaultProductionGate`, `heldOutGate`, `paretoSignificanceGate`, `composeGate`); the deployment-outcome store; storage; and the five core types `Scenario` / `Dispatch` / `JudgeConfig` / `Mutator` / `Gate`. |
| `…/hosted` | `createHostedClient` / `hostedClientFromEnv` + the wire types to ship eval-run events + trace spans to a hosted orchestrator (ours or your own implementation of the spec) |
| `…/adapters/otel` | `createOtelBridge` — forwards OpenTelemetry-shape spans into the hosted-tier ingest, no `@opentelemetry/*` dependency |
| `…/adapters/langchain` | Wrap any LangChain `Runnable` as a `Dispatch` (or `JudgeConfig`), no `@langchain/core` peer dep |
| `…/adapters/http` | `httpDispatch` + `runDispatchServer` — run a campaign's worker on another machine (multi-region, driver-as-a-service) |
| `…/campaign` | **The measurement + improvement engine** (`@experimental`): `runProfileMatrix`, `compareDrivers`, every driver (`gepaDriver`, `haloDriver`, `skillOptDriver`, `aceDriver`, `memoryCurationDriver`, …), the gates, storage backends, and loop provenance. `/contract` re-exports the stable subset. |
| `…/rl` | RL bridge from eval artifacts to training signal: verifiable rewards, preferences, OPE, PRM, tournaments, contamination, compute curves, plus the durable corpus + `buildRlDataset` / datasheet bundle |
| `…/reporting` | Release-decision statistics: `pairedBootstrap`, `benjaminiHochberg`, anytime-valid sequential e-values, `evaluateReleaseConfidence`, and the report renderers |
| `…/analyst` | The trace-analyst surface: `AnalystRegistry` + `buildDefaultAnalystRegistry` (run the failure-clustering panel), `FindingsStore`, and the LLM chat transports |
| `…/traces` | Trace stores + emitters, OTLP-JSONL deterministic replay, `analyzeTraces`, and the `traceAnalystOnRunComplete` hook |
| `…/control` | Agent control loop: `runAgentControlLoop` (observe → validate → decide → act), action policy, propose/review |
| `…/matrix` | `runAgentMatrix` — an N-axis cartesian over caller-supplied substrate values, per-axis pass/score/cost/duration |
| `…/multishot` | N-shot persona × shot matrix runner (`runMultishot` / `runMultishotMatrix`) |
| `…/wire` | The cross-language HTTP/RPC server + Zod schemas (the source-of-truth protocol the Python client speaks) + the built-in rubric registry |
| `…/benchmarks` | `BenchmarkAdapter` contract + `deterministicSplit` + the bundled `routing` reference benchmark |

**Specialized surfaces** (subpath-only): `…/prm` (process-reward grading + best-of-N), `…/meta-eval` (judge calibration + the deployment-outcome store), `…/pipelines` (trace-diagnostic views: budget breach, failure cluster, stuck loop, …), `…/governance` (EU AI Act / NIST AI RMF / SOC2 reports), `…/knowledge` (knowledge-readiness gating before a run), `…/builder-eval` (code-generator three-layer eval), `…/storyboard` (trace → watchable replay), `…/authenticity` (anti-Goodhart "real or convincing BS" scorer over produced files), `…/workflow` (workflow-trace eval + partner export), `…/telemetry` (Workers-safe telemetry client).

The root export remains available for backward compatibility; new code should prefer the focused subpaths above — `/contract` first.

---

## Composition with the stack

agent-eval is the bottom of the layering: consumers depend on it, it depends on none of them.

```
agent-runtime    Runs agents (chat turns, one-shot tasks, multi-attempt loops), captures every
                 run as a trace, and calls optimizePrompt / runImprovementLoop. Produces the
                 RunRecords + traces agent-eval scores. Depends on agent-eval.

agent-eval       selfImprove, analyzeRuns, runCampaign + drivers (gepaDriver, …), the gates
   (this repo)   (heldOutGate, defaultProductionGate, paretoSignificanceGate), the InsightReport
                 decision packet, the RL bridge, the wire protocol. Depends on neither consumer.

agent-knowledge  proposeKnowledgeWrites / applyKnowledgeWriteBlocks. agent-eval's analyst findings
                 feed it; the knowledge gate consumes them. Depends on agent-eval.

sandbox          AgentProfile, Sandbox.create, streamPrompt. The execution surface the runtime's
                 loops run on; agent-eval scores what comes back.
```

The rule: **agent-eval has zero upward dependencies on a consumer.** A concept that makes sense *without* a running agent loop — a verdict, a run record, a scenario, a judge score — is substrate and lives here; a runtime-shaped one (a sandbox profile, a validation context with an abort signal) lives in agent-runtime. When in doubt, lean substrate.

---

## Concepts + design

- [`docs/concepts.md`](./docs/concepts.md) — the three top-level functions, the layering rule, and the wire-protocol contract (the five core contract types are documented in the `/contract` barrel itself)
- [`docs/insight-report.md`](./docs/insight-report.md) — annotated walkthrough of every section of the decision packet
- [`docs/customer-journeys.md`](./docs/customer-journeys.md) — three end-to-end journeys with code + expected output
- [`docs/adapters-observability.md`](./docs/adapters-observability.md) — composing agent-eval with LangSmith, Langfuse, Phoenix, OpenLLMetry, TraceAI
- [`docs/wire-protocol.md`](./docs/wire-protocol.md) — the HTTP/RPC contract Python (and any future language) speaks
- [`docs/hosted-ingest-spec.md`](./docs/hosted-ingest-spec.md) — the hosted-tier wire format, frozen at `2026-05-26.v1`
- [`docs/design/`](./docs/design/) — RFCs + architectural notes

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

## Install + run

```sh
pnpm add @tangle-network/agent-eval
# or, from Python:
pip install agent-eval-rpc
```

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

## Stability + versioning

The `/contract` surface is the **stability contract**: its barrel freezes the API — a `0.x` minor only *adds*; nothing there changes shape or disappears. Depend on `/contract` (and the documented subpaths) rather than the root barrel.

In the deeper subpaths, `@stable` / `@experimental` JSDoc markers (visible in IDE hover + `.d.ts`) call out what may still move — most granularly in `/rl` (tagged per export) and `/campaign` (whole barrel `@experimental`, since `/contract` re-exports only its settled subset).

| Tag | Meaning |
|---|---|
| `@stable` | API frozen at this major. Breaking changes require a major bump. |
| `@experimental` | Interface may evolve before becoming `@stable`. Pin the patch version if you depend on it. |
| `@internal` | Not part of the public contract. Use the documented subpath instead. |

[`CHANGELOG.md`](./CHANGELOG.md) tracks every release with what's new / additive / breaking.

---

## License

MIT. See [`LICENSE`](./LICENSE).
