# `InsightReport`: the report

The single shape every analysis call returns. `selfImprove()` embeds it in `SelfImproveResult.insight`; `analyzeRuns()` returns it directly. The hosted-tier wire format carries it on `EvalRunEvent.insightReport?`.

Use `summarizeExecution({ runs })` when observed traces have no task-quality labels.
It returns only `execution` and `costProvenance`, so callers do not need to fabricate a quality score to report runtime facts.

Every section is **opt-in based on what your data supports**: the function never invents signal. If your runs don't carry judge scores, `judges` is empty. If there's no baseline/candidate split, `lift` is undefined. The shape is consistent; population is honest.

This page walks every section with a real (synthetic) example and explains how to act on it.

---

## At a glance

```ts
interface InsightReport {
  n: number                              // runs analyzed
  execution: ExecutionInsight            // duration, tokens, errors, terminal outcomes
  composite: ScalarDistribution          // always
  perDimension: Record<string, ScalarDistribution>   // when judgeScores carry dimensions
  costQuality: { cost: ScalarDistribution; pareto: ParetoFigureSpec }   // always
  judges: Record<string, JudgeInsight>   // when runs carry judge scores
  interRater?: InterRaterInsight         // when raterScores supplied
  lift?: LiftInsight                     // when baseline + candidate present
  failureClasses?: FailureClassTally[]   // canonical task-failure counts
  failureClusters?: FailureClusterInsight    // when AnalystRegistry wired
  contamination?: ContaminationInsight   // when canaryScenarios supplied
  outcomeCorrelation?: OutcomeCorrelationInsight   // when outcomeSignal supplied
  release: ReleaseSummary                // always
  recommendations: Recommendation[]      // always: read this FIRST
}
```

---

## `execution`: runtime facts, separate from quality

Always present.
It reports duration, optional queue time, direct input, output, reasoning, cache-read, and cache-write tokens, model-call coverage, model cohorts, execution errors, terminal outcomes, and separately reported orchestration aggregates.
These fields describe what ran; they do not claim whether the task succeeded.
`executionErrors` counts child or internal errors reported by the producer.
`terminalOutcomes` reads only `RunRecord.terminalOutcome`, which must come from root-run or process evidence.
A child tool error can therefore appear in a run whose terminal outcome is `succeeded`.
Current OTel and code-agent adapters also preserve process, guardrail, judge, propagated-parent, and unknown error counts in `RunRecord.outcome.raw`.
These counters are diagnostic and never become task-quality scores.

```jsonc
{
  "execution": {
    "durationMs": { "n": 30, "p50": 5400, "p95": 82000, "min": 900, "max": 190000 },
    "queueMs": {
      "n": 0,
      "mean": null,
      "p50": null,
      "p95": null,
      "stddev": null,
      "min": null,
      "max": null,
      "histogram": []
    },
    "tokenUsage": {
      "totals": { "input": 50132, "output": 471783, "reasoning": 12000, "cached": 60489565, "cacheWrite": 3032227 },
      "input": { "n": 30, "p50": 25, "p95": 56 },
      "output": { "n": 30, "p50": 230, "p95": 2651 },
      "reasoning": { "n": 12, "p50": 800, "p95": 2400 },
      "cached": { "n": 20, "p50": 94193, "p95": 310178 },
      "cacheWrite": { "n": 20, "p50": 3070, "p95": 11148 }
    },
    "aggregateUsage": {
      "runs": 2,
      "tokenUsage": {
        "totals": { "input": 5000, "output": 176829, "reasoning": 0, "cached": 0, "cacheWrite": 0 }
      },
      "costUsd": { "n": 0 },
      "totalCostUsd": 0
    },
    "modelCalls": { "runs": 20, "events": 42, "reportingRuns": 30 },
    "models": [{ "model": "claude-opus@2026-07-01", "runs": 20 }],
    "executionErrors": {
      "runs": 2,
      "fraction": 0.067,
      "events": 3,
      "reportingRuns": 30,
      "errorSpanEvents": 3,
      "errorSpanReportingRuns": 30,
      "byTerminalOutcome": {
        "succeeded": { "withErrors": 1, "withoutErrors": 26, "unreported": 0 },
        "failed": { "withErrors": 0, "withoutErrors": 1, "unreported": 0 },
        "cancelled": { "withErrors": 0, "withoutErrors": 0, "unreported": 0 },
        "incomplete": { "withErrors": 0, "withoutErrors": 0, "unreported": 0 },
        "unknown": { "withErrors": 1, "withoutErrors": 1, "unreported": 0 }
      }
    },
    "terminalOutcomes": {
      "succeeded": 27,
      "failed": 1,
      "cancelled": 0,
      "incomplete": 0,
      "unknown": 2
    }
  }
}
```

Use `distribution.n` for optional fields to distinguish an uncaptured category from a recorded zero.
When `distribution.n` is zero, `mean`, percentiles, standard deviation, minimum, and maximum are `null`.
Use `executionErrors.reportingRuns` to assess error-telemetry coverage.
`errorSpanEvents` preserves the exact child-span error count separately from other reported execution errors.
The error fraction uses `reportingRuns` as its denominator and is `null` when no run reported error telemetry, so missing telemetry is not treated as a clean run.
`byTerminalOutcome` is a cross-tab, not a causal recovery claim.
It keeps reported errors, reported zeroes, and missing error telemetry separate for every terminal result.
Missing terminal evidence counts as `unknown`, not `failed`.
Never add `aggregateUsage` to direct `tokenUsage`: orchestration spans may repeat model-call usage from other traces.
Cost remains in `costQuality`, where observed, estimated, and uncaptured USD stay separate.

---

## `n` + `composite` + `perDimension`: distributional summary

Always present. The basic "where are my numbers" view.

```jsonc
{
  "n": 30,
  "composite": {
    "n": 30,
    "mean": 0.683, "p50": 0.667, "p95": 1.000, "stddev": 0.231,
    "min": 0.0, "max": 1.0,
    "histogram": [
      { "lo": 0.0,  "hi": 0.083, "count": 5 },
      { "lo": 0.083, "hi": 0.167, "count": 0 },
      // ...12 bins by default
    ]
  },
  "perDimension": {
    "clarity":   { "mean": 0.72, "p50": 0.75, "p95": 0.95, "stddev": 0.18, /* ... */ },
    "concision": { "mean": 0.65, "p50": 0.68, "p95": 0.88, "stddev": 0.21, /* ... */ }
  }
}
```

Read `composite.mean` only when `composite.n > 0`.
A `null` mean means task quality was not measured, not that quality was zero.
When a measured mean is below 0.5, inspect the lowest-scoring runs before tuning.

**Read next:** `perDimension`. If `clarity` is high but `concision` is low, your prompts get the right ideas in too many words: different fix than "wrong ideas."

**Use the histogram for:** finding bimodal failure modes. A bin with `count > 0` near zero and another > 0 near 1 means your agent has two distinct behaviors, not one noisy one.

### Why this is not the same shape as a campaign aggregate

This report uses `ScalarDistribution`.
A campaign aggregate (`CampaignResult.aggregates`) uses `SeriesDistribution`, the value `summarizeNumberSeries` returns.
The two shapes stay separate for three reasons, and none of them is an accident of history.

1. `ScalarDistribution` is a wire contract.
   `ScalarDistributionSchema` in `src/hosted/schemas.ts:45` is a strict Zod object.
   It is embedded in `InsightReportSchema`, which is embedded in `EvalRunEventSchema`, which the hosted client validates every event against before it ships (`src/hosted/client.ts:182`).
   A strict object rejects an unknown key, so adding or renaming a field breaks every event a consumer already sends.
2. `ScalarDistribution` reports what a report needs and a series summary does not have: a histogram, the worst-N `tailRuns` by score, `p95` for a latency question, and `mean` plus `stddev` beside the order statistics.
   `SeriesDistribution` is the in-memory summary of a plain number series with no run identity attached.
3. The two answer at different `n = 0` boundaries.
   `ScalarDistribution` represents an empty series as `n: 0` with every field `null`, because a report always has a slot for a metric it did not measure.
   `summarizeNumberSeries` returns `null` for an empty series, because there is no distribution to report and a zero-filled summary would read as a measured all-zero series.

Both refuse to encode a missing measurement as a zero.
That is the shared rule; the shapes differ because the surfaces differ.

---

## `costQuality`: cost-vs-quality Pareto

Always present. `cost.histogram` is the per-run cost distribution; `pareto` is the substrate's `ParetoFigureSpec`.

```jsonc
{
  "costQuality": {
    "cost": {
      "mean": 0.024, "p95": 0.041,
      "histogram": [/* */]
    },
    "pareto": {
      "kind": "pareto-cost-quality",
      "split": "holdout",
      "axes": { "x": "costUsd", "y": "score" },
      "points": [
        { "candidateId": "baseline", "cost": 0.018, "quality": 0.58, "n": 20, "onFrontier": true },
        { "candidateId": "winner",   "cost": 0.027, "quality": 0.65, "n": 20, "onFrontier": true }
      ]
    }
  }
}
```

**Use this when:** comparing prompts, models, or candidate surfaces. The Pareto frontier is your menu of "best you can do at each cost level."

**Render with:** any chart library: `points` is plain JSON. Hosted-tier dashboards render this as a scatter with the frontier highlighted.

---

## `judges`: per-judge mean

Populated when run records carry `outcome.judgeScores`.

```jsonc
{
  "judges": {
    "domain-expert":   { "n": 30, "meanScore": 0.71 },
    "helpfulness-llm": { "n": 30, "meanScore": 0.62 }
  }
}
```

The substrate's full judge-calibration suite (positional bias, self-preference, verbosity bias) lives in `/reporting` and operates on **paired-by-condition** inputs that `analyzeRuns` doesn't synthesize from raw `RunRecord[]`. Wire them yourself when you have the paired data; the report's `judges` map is the corpus-level slice.

**Use this when:** comparing multiple judges over the same corpus. A big gap between two judges' means is the first signal that one of them is mis-calibrated.

---

## `interRater`: multi-rater agreement and disagreement review

Populated when `analyzeRuns({ raterScores })` is supplied: typically via `fromFeedbackTable()`.

```jsonc
{
  "interRater": {
    "raters": 3,
    "jointlyRated": 30,
    "kappa": 0.40,
    "icc": 0.42,
    "pearson": 0.43,
    "spearman": 0.41,
    "perPair": {
      "alice::bob":   0.53,
      "alice::carol": 0.47,
      "bob::carol":   0.19
    },
    "disagreementCases": [
      { "runId": "claim-7", "range": 1.00,
        "ratings": [{"rater":"alice","score":1},{"rater":"bob","score":1},{"rater":"carol","score":0}] },
      { "runId": "claim-13", "range": 1.00,
        "ratings": [{"rater":"alice","score":0},{"rater":"bob","score":0},{"rater":"carol","score":1}] }
      // ...top 20 by range
    ]
  }
}
```

**Read first:** `kappa` and `icc`, which measure absolute agreement.
Pearson and Spearman measure correlation and can remain high when raters use different score levels.
When absolute agreement is low, review the largest disagreement cases before automating the rubric.

**Use this when:** building per-rater LLM judges. Each rater's individual scores are the gold signal you calibrate against. Once a calibrated LLM matches the human ≥85%, you can auto-grade and escalate only the disagreement cases.

---

## `lift`: paired-bootstrap statistical lift

Populated when baseline + candidate candidates are present (auto-detected from two distinct `candidateId`s, or explicit via `baselineCandidateId` + `candidateCandidateId`).

```jsonc
{
  "lift": {
    "baselineMean": 0.58,
    "candidateMean": 0.65,
    "delta": 0.07,
    "ci95": [0.04, 0.10],          // bootstrap CI on the delta
    "pValue": 0.0008,              // paired t-test; null when the delta is a non-zero constant
    "n": 40,                       // paired observations
    "unpairedBaselineRuns": 2,
    "unpairedCandidateRuns": 1,
    "cohensD": 0.41,              // paired Cohen's dz; null when delta variance is zero
    "mde": 0.06,                   // min detectable effect at current n, 80% power
    "requiredN": 38                // paired n needed at 80% power; null when dz is undefined
  }
}
```

Rows pair only when `(experimentId, scenarioId, seed)` matches.
Missing `scenarioId` and duplicate identities fail loudly.
Unmatched rows are reported and excluded from paired statistics.

**Decision rule:**
- `ci95[0] > threshold` → **SHIP.** Lower bound above your delta threshold means the lift is real at 95% confidence.
- `ci95[0] ≤ threshold < ci95[1]` → **INCONCLUSIVE.** Expand the corpus or wait for more data.
- `ci95[1] ≤ threshold` → **HOLD.** No evidence the candidate is better.

The `recommendations` array surfaces exactly this decision (`kind: 'ship' | 'hold' | 'expand-corpus'`): that's what consumers should read.

**Why bootstrap, not t-test alone:** paired bootstrap is distribution-free. Your judge scores are bounded in [0,1] and almost never normal; the bootstrap CI is the honest one.

---

## `failureClasses`: canonical task-failure counts

Populated when a run has a non-success `failureClass` or a measured task score below the failure threshold.
Runs without an explicit class are counted as `unknown`.
The optional `failureMode` remains domain-specific detail on the original run and is never used as a second grouping key.

```jsonc
{
  "failureClasses": [
    { "failureClass": "bad_retrieval", "count": 9, "share": 0.28 },
    { "failureClass": "instruction_following", "count": 4, "share": 0.13 }
  ]
}
```

Use this section to compare failure causes across products without a model call.
Use `failureClusters` when you need a semantic diagnosis within those classes.

---

## `failureClusters`: grouped failure modes

Populated when an `AnalystRegistry` is passed via `analyzeRuns({ analyst })`. The substrate runs each failed run through the registered analysts and groups findings by `analyst_id` / `area`.

```jsonc
{
  "failureClusters": {
    "totalFailures": 11,
    "clusters": [
      { "id": "off-topic-drift", "name": "off-topic-drift",
        "share": 0.45, "exemplars": ["run-12", "run-19", "run-33"] },
      { "id": "over-confidence", "name": "over-confidence",
        "share": 0.27, "exemplars": ["run-3", "run-21"] },
      { "id": "format-mismatch", "name": "format-mismatch",
        "share": 0.18, "exemplars": ["run-41", "run-44"] }
    ]
  }
}
```

**Read first:** the top cluster's `share`. If one cluster is > 40% of failures, fix that pattern before doing anything else.

**Use this when:** triaging a regression. Failure clusters tell you "fix this kind of thing first."

**To wire it:** register analysts in `AnalystRegistry`. See `src/analyst/registry.ts` and `src/analyst/kinds/index.ts` for the four built-in kinds (`failure-mode`, `improvement`, `knowledge-gap`, `knowledge-poisoning`).

---

## `contamination`: canary check

Populated when canary scenarios are passed via `analyzeRuns({ canaryScenarios })`. Each canary carries a sentinel string the agent should never emit; the report counts leaks.

```jsonc
{
  "contamination": {
    "leaks": 0,
    "holdoutAuditPassed": true,
    "details": []
  }
}
```

When `leaks > 0`:

```jsonc
{
  "contamination": {
    "leaks": 2,
    "holdoutAuditPassed": false,
    "details": [
      { "runId": "run-12", "canary": "xyz-secret-canary-123", "matched": "...the secret xyz-secret-canary-123 says..." }
    ]
  }
}
```

**When this fails:** your holdout corpus has leaked into training context. The `lift` number is **unreliable**. Investigate before shipping anything.

---

## `outcomeCorrelation`: closing the loop on real outcomes

Populated when `outcomeSignal: { metric, valueByRunId }` is supplied.

```jsonc
{
  "outcomeCorrelation": {
    "metric": "engagement_rate",
    "n": 80,
    "pearson": 0.72,           // linear correlation
    "spearman": 0.69,          // rank correlation (robust to monotonic nonlinearity)
    "rewardModel": {
      "intercept": 0.04,
      "slope": 1.93,
      "r2": 0.52               // share of outcome variance the judge explains
    }
  }
}
```

This is the layer that says **"does my judge's taste actually predict the metric the business cares about?"**

**Read first:** `spearman`. If it's < 0.3 in absolute value, your judges are scoring something different from what wins downstream. Refit the judges (use the customer's downstream signal as gold) or change the rubric.

**The reward model** is the simple linear `y = intercept + slope * composite`. Use it to:
- Predict the engagement of a new run from its composite score alone.
- Set a `composite` threshold for "must beat X to ship" based on the engagement equivalent.

---

## `release`: pass/warn/fail axes

Always present. Roll-up across three axes: quality lift, contamination, composite distribution.

```jsonc
{
  "release": {
    "status": "pass",
    "axes": [
      { "name": "quality-lift", "status": "pass",
        "detail": "delta=0.070, CI95=[0.040, 0.100], n=40" },
      { "name": "contamination", "status": "pass",
        "detail": "0 canary leak(s)" },
      { "name": "composite-distribution", "status": "pass",
        "detail": "mean=0.683, p50=0.667, p95=1.000 over n=30" }
    ],
    "issues": []
  }
}
```

Overall `status` is `fail` if any axis fails; `warn` if any warn; `pass` otherwise.

**Use this when:** wiring agent-eval into CI. A `status === 'pass'` from `analyzeRuns` on the candidate vs baseline is your green-light gate.

---

## `recommendations`: the actionable layer

Always present. Read this first.

```jsonc
{
  "recommendations": [
    { "priority": "critical", "kind": "ship",
      "title": "Ship: lift 0.070 (95% CI 0.040..0.100)",
      "detail": "Holdout lift exceeds threshold 0.02 with 95% bootstrap confidence (n=40, p=0.0008, d=0.41).",
      "evidencePath": "lift" },
    { "priority": "high", "kind": "investigate",
      "title": "Top failure cluster: off-topic-drift (45% of failures)",
      "detail": "11 runs failed. The largest cluster groups 3 exemplars under 'off-topic-drift'.",
      "evidencePath": "failureClusters.clusters[0]" }
  ]
}
```

| `kind` | When emitted |
|---|---|
| `ship` | lift CI lower bound > threshold |
| `hold` | lift CI upper bound ≤ threshold |
| `expand-corpus` | lift CI straddles threshold: more data needed |
| `fix` | canary contamination detected |
| `recalibrate` | inter-rater κ < 0.5, OR outcome correlation < 0.3 |
| `investigate` | top failure cluster > some-share |

`evidencePath` points back into the report (`"lift"`, `"contamination"`, `"failureClusters.clusters[0]"`) so a UI can deep-link from each recommendation to its evidence.

---

## How `analyzeRuns` populates each section

| Section | Required input |
|---|---|
| `composite`, `perDimension`, `costQuality`, `release`, `recommendations` | `runs` |
| `judges` | `runs` with `outcome.judgeScores` |
| `interRater` | `raterScores` (≥ 2 raters jointly rated some runs) |
| `lift` | two distinct `candidateId`s in `runs` (or explicit baseline/candidate ids) |
| `failureClusters` | `analyst` registry passed in |
| `contamination` | `canaryScenarios` passed in |
| `outcomeCorrelation` | `outcomeSignal` passed in |

All sections beyond the always-present ones are `T | undefined`, never empty objects. If a section is missing, your inputs didn't support it: the report is honest about that.
