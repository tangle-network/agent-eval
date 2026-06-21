# Examples

New here? Read these three in order — they cover the whole substrate.

1. **[`substrate-lift-proof/`](./substrate-lift-proof)** — start here. `gepaProposer` promotes a *real* held-out gain (0.667 → 1.0, n=6 holdout, real Tangle Router backend, ~$0.02). This is the substrate doing its one job, end to end, with a number you can reproduce.
2. **[`selfimprove-quickstart/`](./selfimprove-quickstart)** — `defineAgentEval().improve()`: define scenarios, agent, judge, and baseline once, then run the closed loop.
3. **[`foreign-agent-quickstart/`](./foreign-agent-quickstart)** — bring your own agent: wrap an existing API, record runs, get the same decision packet back.

## Pick by what you already have

The three top-level entry points map to three starting situations — same decision-packet shape out of each:

| You have… | Call | Example |
|-----------|------|---------|
| A closed improvement loop | `defineAgentEval().improve()` | [`selfimprove-quickstart`](./selfimprove-quickstart) |
| Production traces (OTel) | `analyzeRuns()` | [`customer-otel-traces`](./customer-otel-traces) |
| An approve/reject label corpus | `analyzeRuns()` | [`customer-feedback-loop`](./customer-feedback-loop) |

## By topic

**Proof & benchmarks** — does it actually work, and which approach wins?
- [`substrate-lift-proof`](./substrate-lift-proof) — the flagship: a real, reproducible held-out lift.
- [`compare-proposers-canonical`](./compare-proposers-canonical) — `compareProposers` head-to-head.
- [`findings-ablation`](./findings-ablation) — measures whether feeding findings into GEPA helps.
- [`held-out-gate`](./held-out-gate) — the promotion gate in isolation.
- [`scorecard`](./scorecard) — render an eval scorecard.
- [`benchmarks`](./benchmarks) — public-benchmark wrappers.

**Proposers & optimization** — the improvement engines.
- [`multi-shot-optimization`](./multi-shot-optimization) — `runImprovementLoop`: surface optimization with a held-out promotion gate.
- [`distributed-driver`](./distributed-driver) / [`user-simulation-driver`](./user-simulation-driver) — execution-driver examples, not surface proposers.
- [`marketing-agent-canonical`](./marketing-agent-canonical) / [`auto-research-with-agent-builder`](./auto-research-with-agent-builder) — full product-agent demos.

**RL datasets** — turn graded runs into training data.
- [`publish-rl-dataset`](./publish-rl-dataset) — package graded runs into a publishable RL dataset.
- [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl) — fine-tune with Prime Intellect's `prime-rl`.

**Hosted & infra** — the wire protocol and sandbox harnesses.
- [`hosted-ingest-server`](./hosted-ingest-server) — a reference ingest receiver.
- [`same-sandbox-harness`](./same-sandbox-harness) — co-located sandbox eval harness.

`_shared/` holds fixtures (e.g. the extraction-task corpus) reused across examples — not a standalone example.
