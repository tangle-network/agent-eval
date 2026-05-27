# `InsightReport` — the decision packet

The single shape every analysis call returns. `selfImprove()` embeds it in `SelfImproveResult.insight`; `analyzeRuns()` returns it directly. The hosted-tier wire format carries it on `EvalRunEvent.insightReport?`.

Every section is **opt-in based on what your data supports** — the function never invents signal. If your runs don't carry judge scores, `judges` is empty. If there's no baseline/candidate split, `lift` is undefined. The shape is consistent; population is honest.

This page walks every section with a real (synthetic) example and explains how to act on it.

---

## At a glance

```ts
interface InsightReport {
  n: number                              // runs analyzed
  composite: ScalarDistribution          // always
  perDimension: Record<string, ScalarDistribution>   // when judgeScores carry dimensions
  costQuality: { cost: ScalarDistribution; pareto: ParetoFigureSpec }   // always
  judges: Record<string, JudgeInsight>   // when runs carry judge scores
  interRater?: InterRaterInsight         // when raterScores supplied
  lift?: LiftInsight                     // when baseline + candidate present
  failureClusters?: FailureClusterInsight    // when AnalystRegistry wired
  contamination?: ContaminationInsight   // when canaryScenarios supplied
  outcomeCorrelation?: OutcomeCorrelationInsight   // when outcomeSignal supplied
  release: ReleaseSummary                // always
  recommendations: Recommendation[]      // always — read this FIRST
}
```

---

## `n` + `composite` + `perDimension` — distributional summary

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

**Read first:** the `composite.mean`. If it's < 0.5, your agent has a ceiling problem, not a tuning problem.

**Read next:** `perDimension`. If `clarity` is high but `concision` is low, your prompts get the right ideas in too many words — different fix than "wrong ideas."

**Use the histogram for:** finding bimodal failure modes. A bin with `count > 0` near zero and another > 0 near 1 means your agent has two distinct behaviors, not one noisy one.

---

## `costQuality` — cost-vs-quality Pareto

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

**Render with:** any chart library — `points` is plain JSON. Hosted-tier dashboards render this as a scatter with the frontier highlighted.

---

## `judges` — per-judge mean

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

## `interRater` — multi-rater agreement + disagreement triage

Populated when `analyzeRuns({ raterScores })` is supplied — typically via `fromFeedbackTable()`.

```jsonc
{
  "interRater": {
    "raters": 3,
    "jointlyRated": 30,
    "kappa": 0.71,
    "perPair": {
      "alice::bob":   0.78,
      "alice::carol": 0.65,
      "bob::carol":   0.69
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

**Read first:** the mean `kappa`. < 0.5 means raters disagree on what "good" looks like — surface the disagreement cases at the next review meeting.

**Use this when:** building per-rater LLM judges. Each rater's individual scores are the gold signal you calibrate against. Once a calibrated LLM matches the human ≥85%, you can auto-grade and escalate only the disagreement cases.

---

## `lift` — paired-bootstrap statistical lift

Populated when baseline + candidate candidates are present (auto-detected from two distinct `candidateId`s, or explicit via `baselineCandidateId` + `candidateCandidateId`).

```jsonc
{
  "lift": {
    "baselineMean": 0.58,
    "candidateMean": 0.65,
    "delta": 0.07,
    "ci95": [0.04, 0.10],          // bootstrap CI on the delta
    "pValue": 0.0008,              // paired t-test
    "n": 40,                       // paired observations
    "cohensD": 0.41,
    "mde": 0.06,                   // min detectable effect at current n, 80% power
    "requiredN": 38                // n needed for observed delta at 80% power
  }
}
```

**Decision rule:**
- `ci95[0] > threshold` → **SHIP.** Lower bound above your delta threshold means the lift is real at 95% confidence.
- `ci95[0] ≤ threshold < ci95[1]` → **INCONCLUSIVE.** Expand the corpus or wait for more data.
- `ci95[1] ≤ threshold` → **HOLD.** No evidence the candidate is better.

The `recommendations` array surfaces exactly this decision (`kind: 'ship' | 'hold' | 'expand-corpus'`) — that's what consumers should read.

**Why bootstrap, not t-test alone:** paired bootstrap is distribution-free. Your judge scores are bounded in [0,1] and almost never normal; the bootstrap CI is the honest one.

---

## `failureClusters` — grouped failure modes

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

**To wire it:** register analysts in `AnalystRegistry`. See `src/analyst/registry.ts` and `src/analyst/kinds.ts` for the four built-in kinds (`failure-mode`, `improvement`, `knowledge-gap`, `knowledge-poisoning`).

---

## `contamination` — canary check

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

## `outcomeCorrelation` — closing the loop on real outcomes

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

## `release` — pass/warn/fail axes

Always present. Roll-up across three axes — quality lift, contamination, composite distribution.

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

## `recommendations` — the actionable layer

Always present. Read this first.

```jsonc
{
  "recommendations": [
    { "priority": "critical", "kind": "ship",
      "title": "Ship — lift 0.070 (95% CI 0.040..0.100)",
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
| `expand-corpus` | lift CI straddles threshold — more data needed |
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

All sections beyond the always-present ones are `T | undefined`, never empty objects. If a section is missing, your inputs didn't support it — the report is honest about that.
