# Production loop

End-to-end demo of `runProductionLoop` — the orchestration layer that
closes eval → prod → eval.

## What it shows

- 8 synthetic production failures (all hitting the same `instruction_following`
  failure class — missing statute citations on FTC rule questions) seeded
  into an `InMemoryTraceStore`.
- 8 matching 👎 user-feedback labels seeded into an
  `InMemoryFeedbackTrajectoryStore`.
- One `runProductionLoop` cycle:
  - `failureClusterView` surfaces the cluster, which crosses the
    `minClusterSize: 5` threshold.
  - `runMultiShotOptimization` runs 2 generations × 2 reps over 3
    holdout scenarios, with an addendum-style mutator that appends a
    citation directive to the baseline prompt.
  - `HeldOutGate` checks that the paired-Δ on the holdout split is
    positive with `minProductiveRuns: 3`.
  - `evaluateReleaseConfidence` cross-checks pass-rate, mean score,
    overfit gap, and the gate decision (fail-closed on any axis).
  - On pass, a fake `AutoPrClient` captures the PR plan — a real
    deployment would wire `httpGithubClient({ token })` or
    `ghCliClient()`.

## Run

```sh
pnpm tsx examples/production-loop/index.ts
```

## Expected output

```
═══════════════════════════════════════════════════════════════
production-loop demo · synthetic prod data → improved prompt
═══════════════════════════════════════════════════════════════
runId          : prod-loop-demo-<epoch>
target         : tax-agent
decision       : pr_opened
observed runs  : 8
observed feedback: 8
clusters seen  : 1
acted-on       : class=instruction_following runs=8 scenarios=1
gate           : promote=true medianΔ=0.450 CI=[0.450, 0.450]
release status : pass (passRate=...)
───────────────────────────────────────────────────────────────
PR opened      : https://github.com/tangle-network/tax-agent/pull/synthetic-1
branch         : eval/auto-improve/prod-loop-demo-<epoch>
head SHA       : face-cafe-beef-...
───────────────────────────────────────────────────────────────
PR title: tax-agent: production-loop prompt update (prod-loop-demo-<epoch>)
PR file: prompts/tax-agent-system.txt
PR body preview:
  ## Production-loop prompt update — `tax-agent`

  Run id: `prod-loop-demo-<epoch>`
  Decision: `pr_opened`
  Observed in this cycle: 8 prod runs, 8 feedback trajectories.

  ### Triggering failure cluster
  ...
═══════════════════════════════════════════════════════════════
```

## Adapt this to your product

| Synthetic                       | Production                                          |
| ------------------------------- | --------------------------------------------------- |
| `InMemoryTraceStore`            | `FileSystemTraceStore`, or HTTP-ingest via `POST /v1/traces/ingest` |
| `InMemoryFeedbackTrajectoryStore` | `FileSystemFeedbackTrajectoryStore`, or HTTP-ingest via `POST /v1/feedback` |
| deterministic `runner`          | your agent driver invoking real tools               |
| deterministic `scorer`          | calibrated judge (`callLlmJson` + `Rubric`)         |
| `captureAutoPrClient()`         | `httpGithubClient({ token })` or `ghCliClient()`    |
| `main()`                        | scheduled GitHub Action (`workflow_dispatch` + cron) |

The primitive is **idempotent** + **replayable**: re-running with the
same `runId` produces the same plan. Safe to retry on transient errors.
