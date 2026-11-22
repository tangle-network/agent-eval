# Connect rubric scores to deployment outcomes

`rubricPredictiveValidity()` measures associations between rubric scores and observations from deployment.
Declare the desired direction for each outcome before reading the results.
Define rubric scores so higher values mean better evaluated behavior.

```ts
import {
  InMemoryOutcomeStore,
  rubricPredictiveValidity,
  type DeploymentOutcome,
  type OutcomeMetricSpec,
} from '@tangle-network/agent-eval/meta-eval'
import type { RunRecord } from '@tangle-network/agent-eval'

async function assessOutcomes(runs: RunRecord[], observations: DeploymentOutcome[]) {
  const outcomes = new InMemoryOutcomeStore()
  for (const observation of observations) await outcomes.append(observation)
  const metrics: OutcomeMetricSpec[] = [
    { id: 'success_rate', direction: 'higher-is-better' },
    { id: 'failure_rate', direction: 'lower-is-better' },
  ]

  return rubricPredictiveValidity({
    runs,
    outcomes,
    outcomeMetrics: metrics,
    rubrics: ['task_quality'],
  })
}
```

Populate `RunRecord.outcome.raw.task_quality` with the captured rubric score.
Append deployment observations with the same `runId` and exact outcome metric keys.
The store accepts finite numbers, including zero.
Omit an unmeasured metric instead of replacing it with zero.

An observation records when and where its outcomes were captured:

```ts
const observation: DeploymentOutcome = {
  runId: 'support-run-42',
  capturedAt: Date.now(),
  metrics: { success_rate: 1, failure_rate: 0 },
  labels: { cohort: 'support' },
  source: 'resolution-events-v1',
}
```

`capturedAt` uses epoch milliseconds.
The matching run supplies the rubric score; this observation supplies the measured deployment outcome.

The default reduction selects the latest finite observation of each requested metric.
A newer row containing another metric cannot supply its value or erase an older observation.
The `mean` and `max` reductions operate on that metric alone.

## Read the report

| Field | Interpretation |
|---|---|
| `pearson`, `spearman` | Association with the recorded outcome, retaining its original sign. |
| `alignedPearson`, `alignedSpearman` | Positive means higher rubric scores associate with better outcomes. |
| `pearsonCi95`, `spearmanCi95` | Bootstrap intervals for the raw associations. |
| `alignedSpearmanCi95` | Spearman interval after applying the declared outcome direction. |
| `verdict` | `aligned` at aligned Spearman ≥ 0.4; `inverse` at ≤ −0.4; otherwise `weak`. |
| `n` | Finite joined run observations for this rubric and outcome. |
| `excludedPairs` | Unestimated pairs, their observation counts, and the reason for exclusion. |
| `rubricsWithoutData` | Declared rubrics with no finite score in the supplied runs. |

A rubric can correlate negatively with failure rate and still receive `aligned`.
The same negative correlation with success rate receives `inverse`.
These labels describe association strength and direction.
They do not grant release authority or establish that changing a rubric weight will improve outcomes.

Pairs require eight observations by default.
`minSamples` can set another integer of at least three.
Insufficient observations and constant scores or outcomes remain explicit exclusions.
Constant observations cannot establish a perfect predictor.
Intervals remain `null` when no bootstrap resample has an estimable correlation.

`joinedSamples + skippedRuns` equals the supplied run count.
A run is joined when at least one finite score and outcome pair exists.
It remains joined even if that pair has too few observations for estimation.
Duplicate run IDs are rejected.

Each run is an independent bootstrap observation.
Repeated observations from the same person or task can violate that assumption.
Aggregate at the independent unit or use a study with an appropriate grouped estimator.

`ranked` selects each rubric's highest direction-aligned association across the declared outcomes.
This ordering is exploratory and can conceal conflicts among outcomes.
Inspect all `pairs` and use a target chosen before analysis for an automated recommendation.
Confirm any proposed change with fresh evidence and fixed scoring rules.

## Choose which measures to climb

`rubricPredictiveValidity()` and `correlationStudy()` describe one association over all the data.
`measureValidityStudy()` asks the question a climb needs: which of many recorded numbers predict an outcome decided later, on changes they were not chosen on, and which few to climb.

```ts
import { sealMeasureValidityPlan } from '@tangle-network/agent-eval/experiment'
import { measureValidityStudy, type MeasuredChange } from '@tangle-network/agent-eval/meta-eval'

const plan = sealMeasureValidityPlan({
  id: 'which-numbers-predict-kept-changes',
  cut: Date.parse('2026-10-01T00:00:00Z'),
  level: 0.05,
  outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
  measures: [{ id: 'review_depth' }, { id: 'test_delta', noise: 0.1, cost: 1 }],
})

const change: MeasuredChange = {
  id: 'change-1842', // the outcome store joins it through DeploymentOutcome.runId
  at: Date.parse('2026-10-03T12:00:00Z'),
  unit: 'repository-17', // the independent unit; intervals resample whole units
  measures: { review_depth: 3, test_delta: 0.4 }, // an absent key is unmeasured
  movements: { test_delta: { before: 0.1, after: 0.5 } }, // optional
}

const report = await measureValidityStudy({ plan, changes: [change /* , ... */], outcomes })
```

Seal the plan before reading changes made after the cut, and keep its digest where an independent reader can see it.
The study refuses a plan whose seal does not verify; the seal proves identity, not when it was made.
[`examples/measure-validity`](../examples/measure-validity/) runs the whole path on generated history.

The cut splits the changes.
A change made before the cut fixes each measure's direction, its standardization and the selected subset, reading only outcomes captured by the cut.
Every reported statistic comes from changes made at or after the cut, with those choices fixed.
`excludedObservations` counts outcomes captured before their change, beyond `maxCaptureLagMs`, or after the cut for a change made before it.

| Field | Meaning |
|---|---|
| `coverage` | Per measure: changes, measured changes and share, before and after the cut. An absent value is unmeasured, never zero. |
| `pairs[].label` | `predicts`: the pooled test passes and so does the within-unit test where it can be estimated. `predicts-pooled-only`: the pooled test passes and the within-unit test does not, so the ranking may come from differences between units rather than between changes. `not-shown`: tested and not admitted. `insufficient`: not tested. |
| `pairs[].reason` | Why a pair is not `predicts`: `below-minimum-count` (fewer than `minJoined`, default 100, joined changes after the cut), `too-few-units` (fewer than `minUnits`, default 20), `too-little-variation` (fewer than `minMinority`, default 20, joined changes after the cut differ from the measure's most common value: the smaller class of a two-valued measure), `no-pre-cut-direction`, `constant-after-cut`, `not-significant`, `direction-reversed` (the interval lies wholly past the null), `within-unit-not-shown`. |
| `pairs[].postCut.association` | The pooled statistic: AUC for a binary outcome, Spearman for a continuous one, aligned so above the null favors the better outcome; whole-unit standard error, percentile interval and one-sided p-value from `clusteredAssociation()`. |
| `pairs[].postCut.withinUnit` | The same statistic computed inside each unit and weighted by its comparable pairs; null when fewer than `minUnits` units hold a pair of changes with different outcomes. |
| `hypothesis` | Every p-value is one-sided in the direction fixed before the cut. |
| `tested`, `withinUnitTested` | Pairs in the pooled and within-unit false-discovery families. |
| `pairs[].leadTimeMs` | Outcome capture time minus change time over the joined changes after the cut. |
| `pairs[].movement` | With before and after values: `sensitivity` (share of changes that moved beyond the measure's declared `noise`) and `agreement` (balanced agreement between the movement's direction and the better outcome, 0.5 under no relation), each with a whole-unit interval. `insensitive` marks a measure that predicts across items but does not move under change. |
| `selections[]` | Per outcome: `climb`, a subset chosen before the cut by greedy forward selection on the equal-weight composite; `guards`, admitted measures not climbed (`redundant`, `no-gain`, `size-limit`); `excluded`, measures that are insensitive, move against the outcome, or predict only across units (`pooled-only`); `composite`, the subset's statistic before and after the cut. |

The selection reads only changes before the cut.
A candidate whose absolute rank correlation with a climbed measure reaches `maxRedundancy` (default 0.9) is a redundant guard; another must add at least `minGain` (default 0.01) to the composite's statistic.
The composite's post-cut score reads the changes admission read, so it describes the chosen subset; the next batch is its independent check.

Keep guards unoptimized.
`guardDrift({ report, outcome, batch, tolerance })` reads a later batch against the before-cut references: a climbed measure whose rise over the mean of its guards has a lower bound above `tolerance`, in before-cut scale units, is `drift`.
Guards are measured at change time, so the check runs before the outcome arrives; pass the outcome store to also report the outcome's shift.

Each test is one-sided in the direction fixed before the cut, so a measure whose direction reversed is never admitted.
When the same units appear on both sides of the cut, a coincidence among those units can choose the direction and then confirm it on the pooled statistic; the within-unit statistic cannot be moved by such a coincidence, which is why `predicts` requires it where it can be estimated.

Known limit: an outcome defined by overlap with the change's own content, such as "a later fix touched the same lines", grows with the change's size, so a size measure predicts it by exposure rather than by quality.
Record a stricter outcome that does not depend on size, such as a later fix that names the change, and report it beside the overlap outcome; a measure that predicts only the overlap outcome is predicting exposure.

Prediction is not causation.
An admitted measure forecasts the outcome of changes like these; it does not show that raising the measure raises the outcome, and a climbed measure can be moved without the work it used to reflect.
Records that show cause assign changes at random or interleave them, so the measure moves for reasons unrelated to the outcome.
The report carries this in `claim`.

## Propose an experiment against one target

```ts
import { PredictiveValidityResearcher } from '@tangle-network/agent-eval/rl'
import { InMemoryOutcomeStore } from '@tangle-network/agent-eval/meta-eval'

const outcomes = new InMemoryOutcomeStore()
const researcher = new PredictiveValidityResearcher({
  outcomes,
  targetOutcome: { id: 'success_rate', direction: 'higher-is-better' },
  rubrics: ['task_quality'],
})
```

Supply observed outcomes before calling `runValidityCheck(runs)`.
Pass the resulting failure groups to `proposeChange(failures)`.
The researcher uses its declared target even if another outcome has a stronger association.
It proposes increased-weight experiments for aligned associations and reversal or replacement experiments for inverse associations.
Both require an aligned Spearman interval that excludes zero.
Weak or uncertain associations produce requests for calibration evidence.
Missing estimates produce requests for more outcome observations.

The proposals contain their association, interval, sample count, and target direction.
They contain no predicted improvement because a correlation does not identify a causal treatment effect.
`applyChange()` appends proposals to a plan.
`evaluateChange()` declines promotion because the caller owns experiment execution.

`runRLCampaign()` accepts the same outcome specifications through `outcomeMetrics` when `outcomeStore` is supplied.
Supply both options together; incomplete or empty declarations fail before campaign execution.
Its summary reports direction-aligned association and preserves missing estimates.
The target declaration remains fixed while the campaign runs.

The researcher copies its target declaration, rubric list, and cached reports.
Changing callback arguments, returned reports, or proposal payloads cannot rewrite its cached evidence.

## Store observations without losing failures

`InMemoryOutcomeStore` and `FileSystemOutcomeStore` copy observations at ingestion and retrieval.
Changing a caller's metric or label object cannot rewrite stored evidence.
The filesystem store rereads observations so another instance's later writes remain visible.
Use one writer per directory; operations on that writer are serialized.

A nonexistent directory is an empty store.
An unreadable file, malformed JSON, or invalid outcome record throws `OutcomeStoreError`.
The error carries its operation, path, source line when available, and original cause.
Read errors never become empty studies or partial successful results.
Repair the source and retry the read.

For trace data, `correlationStudy()` accepts outcome names and reports descriptive associations without a desired direction.
It shares the metric reduction, bootstrap, and exclusion behavior.
It excludes observations captured before the run started.
`maxCaptureLagMs` optionally bounds the elapsed time from run start through outcome capture, including both endpoints.

## Inspect calibration by score range

Use `calibrationFromPairs()` when scores and outcomes are already joined.
It accepts readonly observations directly.

```ts
import { calibrationFromPairs } from '@tangle-network/agent-eval/meta-eval'

const calibration = calibrationFromPairs([
  { evalScore: 1, outcome: 0 },
  { evalScore: 1, outcome: 0 },
], 'predicted-success', 'observed-success')

console.log(calibration?.ece) // 1: confident predictions, observed failures.
```

Direct input rejects nonfinite pairs with the offending index.
It does not silently discard them from the denominator.
`calibrationCurve()` performs the join for trace and outcome stores using the latest finite observation of the named outcome metric.
It reports each bin's count, mean score, mean outcome, and absolute gap.
`ece` weights each bin's gap by its share of the finite joined observations.
Both quantities must use comparable numerical scales for this difference to measure calibration.

The `range` option clips scores before binning and retains every joined observation.
The reported calibration error then describes the clipped scores; retain that transformation with the result.
Constant scores form one bin, so a consistently wrong predictor still receives a measured calibration error.
Equal-frequency binning produces the requested number of bins, capped by the observation count.
Bin counts differ by at most one, except when all scores share one value.
Equal-width binning omits empty bins.
On either path, bin counts sum to the reported `n`.

Fewer than two finite pairs returns `null`.
Both entry points validate metric identities, binning options, and range bounds.
Invalid requests fail even when no evidence is available.
The store entry point validates before reading evidence.
