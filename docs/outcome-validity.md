# Connect rubric scores to deployment outcomes

`rubricPredictiveValidity()` measures associations between rubric scores and observations from deployment.
Declare the desired direction for each outcome before reading the results.
Higher rubric scores always mean better evaluated behavior.

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
Its optional capture window includes only observations captured after the run started.

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
Constant scores form one bin, so a consistently wrong predictor still receives a measured calibration error.
Equal-frequency binning produces the requested number of bins, capped by the observation count.
Bin counts differ by at most one, except when all scores share one value.
Equal-width binning omits empty bins.
On either path, bin counts sum to the reported `n`.

Fewer than two finite pairs returns `null`.
Both entry points validate metric identities, binning options, and range bounds.
Invalid requests fail even when no evidence is available.
The store entry point validates before reading evidence.
