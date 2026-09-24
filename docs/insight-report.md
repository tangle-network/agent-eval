# Read an InsightReport

`analyzeRuns()` summarizes captured `RunRecord` evidence and returns an `InsightReport`.
`selfImprove()` includes the same report in `result.insight`.
Analysis makes no model calls unless you supply an analyst that uses one.

```ts
import { analyzeRuns } from '@tangle-network/agent-eval/contract'
import type { RunRecord } from '@tangle-network/agent-eval'

export async function compareCapturedRuns(runs: RunRecord[]) {
  return analyzeRuns({
    runs,
    split: 'holdout',
    baselineCandidateId: 'baseline',
    candidateCandidateId: 'candidate',
    decisionThreshold: 0.02,
  })
}
```

Pass both candidate IDs to preserve the intended comparison direction, including regressions.
Without both IDs, the analyzer infers a comparison only when exactly two candidates exist.
It then treats the lower-scoring candidate as the baseline.
That inference cannot establish whether a specific change regressed.

Use `summarizeExecution({ runs })` when traces contain runtime facts without task-quality labels.
It returns `execution` and `costProvenance` without interpreting release readiness.

The [offline example](../examples/analyze-existing-runs/) shows a complete call.
The [report types](../src/contract/insight-report.ts) and [analysis options](../src/contract/analyze-runs.ts) define the current API.

## Match sections to evidence

| Section | Input and scope |
|---|---|
| `n` | Number of validated input runs. |
| `execution` | Recorded durations, tokens, models, execution errors, and terminal outcomes. |
| `composite` | Finite scores from the selected split. |
| `perDimension`, `judges` | Recorded `outcome.judgeScores`; empty maps when absent. |
| `costQuality` | Known observed or estimated costs, their provenance, and candidate cost/quality points. |
| `lift` | Scored baseline/candidate rows sharing pairing identities. |
| `interRater` | Supplied `raterScores`, with at least two raters and jointly rated runs. |
| `failureClasses` | Explicit non-success classes or measured scores below the analyzer's failure threshold. |
| `failureClusters` | Findings from the supplied `AnalystRegistry` on failed runs. |
| `contamination` | Supplied `canaryScenarios`, searched within captured text outputs. |
| `outcomeCorrelation` | Supplied `outcomeSignal`, joined to at least three finite run scores. |
| `priorPeriodComparison` | Supplied `baselineRuns`, compared as an unpaired prior window. |
| `release`, `recommendations` | Diagnostic rules applied to the populated sections. |

Optional sections are absent when their required inputs are unavailable.
Some supplied inputs can produce empty sections, such as no failure clusters among successful tasks.
An absent section does not establish that its check passed.

`split: 'auto'` selects holdout if any run has a holdout score; otherwise it selects search.
Set `split` explicitly when you know which scores the report should use.
Inspect `composite.n`: it can be smaller than `n` when some runs have no score for that split.

## Read execution and missing values

`execution` describes what ran.
A successful process can still produce an incorrect task result.
A child tool error can also occur in a run whose root outcome is `succeeded`.

`terminalOutcomes` reads `RunRecord.terminalOutcome`.
Missing terminal evidence counts as `unknown`.
`executionErrors` reads producer-reported error counts independently.
Its `fraction` uses `reportingRuns` as the denominator and becomes `null` when no run reports error telemetry.
The `byTerminalOutcome` table separates reported errors, reported zeroes, and unreported error telemetry for each terminal outcome.
It describes their co-occurrence; it does not establish recovery or causation.

Optional token categories and queue time carry their own distribution counts.
For any `ScalarDistribution`, `n: 0` means no finite measurement was available.
Its mean, percentiles, standard deviation, minimum, and maximum are then `null`, with an empty histogram.
A measured zero has a positive count and a value of zero.

Keep orchestration `aggregateUsage` separate from direct token usage.
An aggregate span can repeat usage already captured in model-call traces.
Adding both totals can count the same work twice.

## Inspect quality and cost distributions

`composite` describes the scored input corpus, including both candidates when both are supplied.
It is not the candidate's mean alone.
Use `lift.baselineMean` and `lift.candidateMean` for the paired comparison.
`composite.tailRuns` identifies the lowest-scoring runs for inspection.
Histogram peaks can suggest subgroups; inspect cases before attributing them to distinct agent behaviors.

Judge details use this recorded shape:

```ts
const judgeScores = {
  perJudge: {
    'field-check': { accuracy: 0.75 },
  },
  perDimMean: { accuracy: 0.75 },
  composite: 0.75,
}
```

Store it as `RunRecord.outcome.judgeScores` alongside the relevant search or holdout score.
`perDimension` summarizes dimensions; `judges` reports per-judge counts and means.
Different judge means can reflect different coverage, scales, or criteria.
Compare shared cases before attributing a difference to miscalibration.

`costQuality.provenance` separates observed USD, estimated USD, lower-bound floors, and uncaptured costs.
Lower-bound and uncaptured rows are excluded from the cost distribution and Pareto calculation.
`lowerBound.floorUsd` sums the proven floors of runs whose total is unknown; it is never a total.
Read `knownFraction` and `costQuality.degraded` before comparing costs.
A frontier only compares the observed candidate points; it does not identify the best possible system.

Campaign aggregates use `SeriesDistribution`; insight reports use `ScalarDistribution`.
The latter adds report fields such as histograms and optional run examples.
An empty campaign number series returns `null`; an empty report distribution retains its slot with `n: 0` and null statistics.
Both preserve the distinction between missing measurements and measured zeroes.

## Interpret paired lift

Rows pair on `(experimentId, scenarioId, seed)`.
Missing scenario IDs and duplicate identities within an arm fail validation.
Scored rows without a partner remain in `unpairedBaseline` and `unpairedCandidate` counts and are excluded from the paired statistics.
Unscored rows are also excluded; check the input and score counts separately.

For repeated tasks from one source, supply `independentUnitByScenarioId` as a map from every scored scenario ID to its independent unit.
The analyzer pairs runs first, averages matched scores within each declared unit, and weights units equally.
Raw score distributions and unmatched-run counts remain unchanged.
Repeated runs measure variation on those tasks; they do not create new independent tasks.

| Lift field | Meaning |
|---|---|
| `baselineMean`, `candidateMean`, `delta` | Paired means and candidate-minus-baseline difference after any unit aggregation. |
| `ci95` | Paired bootstrap interval for the mean difference. |
| `n` | Paired observations used for inference; independent units when declared. |
| `pairedRunN`, `independentUnitIds` | Raw matched count and unit IDs, present when units are declared. |
| `minimumRequired`, `decisionEligible` | Bootstrap sample floor and whether the count reaches it. |
| `pValue` | Paired t-test diagnostic; `null` for a nonzero constant difference. |
| `cohensD` | Paired Cohen's dz; `null` when difference variance is zero. |
| `mde` | Approximate detectable effect in standardized units at 80% power. |
| `requiredN` | Approximate sample size using the observed standardized effect; `null` when it cannot be estimated. |

The analyzer's bootstrap decision floor is 20 paired observations.
Below it, a positive interval remains descriptive and the lift recommendation requests more evidence.
Reaching the floor only establishes sample-count eligibility.
A zero-width interval still cannot produce a lift-based ship recommendation.
An eligible, nonzero-width interval must exceed `decisionThreshold`, which defaults to `0.02` in score units.

Bootstrap inference depends on representative, independent observations and adequate sample size.
It cannot repair selection bias, leaked final cases, or a miscalibrated judge.
Do not compare standardized `mde` directly with raw score lift.
Treat `requiredN` as an exploratory approximation, not a prospective power calculation for a target chosen before the study.

## Use recommendations as diagnostics

`recommendations` links findings to report sections through `evidencePath`.
Its `ship` kind can refer to lift or an improved prior-period metric.
Other findings can coexist with it, including a failed canary check.
Read the complete report before acting.

`release` rolls up quality lift, canary matches, and composite score thresholds.
An unavailable axis is `not_evaluated` and makes the overall status at least `warn`.
The quality-lift axis uses positive lift; recommendation thresholds can differ.
These built-in thresholds are report heuristics, not your product's complete release policy.

For automated promotion, use the campaign gate and inspect its contributing checks.
`selfImprove().gateDecision` comes from that gate.
See [concepts](./concepts.md#the-five-release-decisions) and the [held-out gate example](../examples/held-out-gate/).
A reusable claim can declare independent units and a practical effect.
Optional final-evidence tracking records fresh confirmation; see [evaluation integrity](./evaluation-integrity.md).

## Investigate failures and disagreement

`failureClasses` counts explicit non-success classes and scores below `0.5`.
A low-scoring run without a non-success class is counted as `unknown`.
Its `share` uses all input runs as the denominator.
Domain-specific `failureMode` stays on the original record.

`failureClusters` runs registered analysts on those failed runs.
It groups findings by area, with analyst ID as fallback.
Each cluster's `share` counts affected failed runs, including those beyond the five displayed exemplars.
Multiple findings in one cluster count once per run.
A run can belong to several clusters, so cluster shares can sum above one.
Cluster shares use `totalFailures`, unlike the corpus denominator in `failureClasses`.
Empty findings can mean analysts skipped or failed; inspect registry logs and hooks when coverage is uncertain.
See the [custom analyst example](../examples/custom-trace-analyst/) for registration.

`interRater` uses runs scored by every supplied rater.
Check `jointlyRated` before interpreting agreement over the broader corpus.
Kappa and ICC assess agreement; Pearson and Spearman assess correlation.
Review the largest disagreement cases and validate any judge changes on independent examples.
Choose acceptance thresholds for the decision's actual error costs.

## Check canaries and downstream outcomes

The canary check searches strings in `metadata.output`, falling back to `metadata.text`.
Other output layouts need conversion before analysis.
A match establishes that captured output contains a sentinel; investigate how it arrived there.
A zero-leak result does not prove isolation, especially when outputs were not captured.
The section does not report output-coverage counts.

`outcomeCorrelation` joins finite `outcomeSignal.valueByRunId` values to run scores.
Its Pearson and Spearman values describe association in that supplied sample.
The linear `rewardModel` is fitted and evaluated on those same observations.
Validate it on separate data before using it to predict outcomes or set a release threshold.
Weak correlation can reflect noise, limited range, confounding, or the wrong rubric.
It does not identify the cause by itself.

Use [outcome validity](./outcome-validity.md) for declared outcome directions, explicit exclusions, and association intervals.
Use `baselineRuns` for an unpaired prior-period comparison of available metrics.
Period differences can reflect traffic, task mix, or capture changes; they do not isolate the effect of a deployment.
