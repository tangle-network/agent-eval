# Statistical evidence

Repeated runs measure execution variation on the cases you supplied.
A claim about new cases also needs independent observations from its target population.
Repeating one incident 100 times supplies one incident, even when every execution has a distinct identifier.

## Declare the independent unit

Pass `independentUnitByScenarioId` to `defaultProductionGate`, `heldoutSignificance`, or `dimensionRegressions` when scenarios share a source.
The map assigns each scenario to the incident, document, task family, or other unit sampled independently.
Choose this assignment before examining scores.

```ts
import { defaultProductionGate } from '@tangle-network/agent-eval/campaign'

const holdoutScenarios = [
  { id: 'incident:17:original', kind: 'support' },
  { id: 'incident:17:paraphrase', kind: 'support' },
  { id: 'incident:28:original', kind: 'support' },
]

const gate = defaultProductionGate({
  holdoutScenarios,
  independentUnitByScenarioId: new Map([
    ['incident:17:original', 'incident-17'],
    ['incident:17:paraphrase', 'incident-17'],
    ['incident:28:original', 'incident-28'],
  ]),
  deltaThreshold: 0.05,
  criticalDimensions: ['factualAccuracy'],
})
```

This example has two independent units and cannot meet its observation minimum.
More repetitions of these scenarios will not change that count.
The default gate copies the map when it is constructed.
Later mutations cannot change the grouping used by that gate.

Pairing precedes aggregation.
Candidate and baseline must contain the same full cell identifiers and the same selected judges within each cell.
The last numeric suffix identifies a repetition, so colons within scenario identifiers remain valid.
The implementation averages matched cells within each unit, then gives every unit equal weight.
It refuses asymmetric cells, asymmetric selected judges, duplicate cells, non-finite scores, and missing unit assignments.

Reports distinguish the following counts:

| Field | Meaning |
|---|---|
| `n` | Paired observation units used for inference |
| `pairedCellN` | Matched execution cells before grouping |
| `observationUnit` | `registered` when a supplied map defines units; `cell` on an ungrouped fixed-roster path |
| `unitIds` | The units represented in a held-out significance result |

Without a map, fixed-roster significance uses execution cells as observations.
Its uncertainty concerns independently sampled execution outcomes conditional on that roster.
It does not establish generalization to new incidents or task families.
Identifiers and aggregation do not establish independence; the sampling design must justify it.

## Read the interval that decided

`heldoutSignificance().decision` contains the test, interval, observation minimum, and promotion decision.
Pass/fail scores use the shared paired risk-difference rule.
Continuous scores use the shared paired bootstrap or its small-sample test.
`bootstrap` and `medianBootstrap` remain diagnostics when another test decides.

Continuous mean targets require 20 observations for bootstrap eligibility.
Below that count, a reported exact sign-test diagnostic cannot establish a mean effect.
Binary outcomes and explicitly requested median targets use their actual confidence-dependent observation minimum.
The observation minimum establishes estimator eligibility; it does not establish statistical power or representative sampling.
A zero-width bootstrap interval cannot establish improvement under the shared decision rule.

Required dimensions also need sufficient observations and complete coverage.
The default gate reports `not_evaluated` when a required dimension lacks enough units or omits matched cells or scenarios.
`fewRuns`, `missingCellIds`, and `missingScenarioIds` preserve the missing evidence.
An observed regression can still hold the gate while evidence remains incomplete.
Passing the regression guard does not certify every safety property of the candidate.

## Sequential decisions require a conditional-mean assumption

`sequentialPairedGate` consumes one observation per scenario by default in `decide()`.
Its `independentUnitByScenarioId` option groups related scenarios before testing and copies the mapping at construction.
`maxN` counts these independent units.
The report preserves both the consumed count `n` and the available counts `pairedN` and `pairedCellN`.

The statistical guarantee requires each next delta's conditional expectation to remain below the registered null boundary.
Independent sampling with that bound is sufficient.
Shuffling an exchangeable sequence does not establish the condition.
One random sign repeated 100 times has only one independent draw.
After its first observation, later signs reveal no new evidence.

Direct `observe(delta)` callers must perform the required aggregation themselves.
They must also justify the sampling assumption.
`sequentialDecide` stops candidate exploration heuristically; candidate selection and reused incumbent scores prevent a general type-I error guarantee.
The selected candidate still requires fresh held-out evidence.

## Adaptation comparisons pair whole scenarios

`runAdaptationCurve` and `compareAdaptationCurves` are exported from `@tangle-network/agent-eval/rl`.
Scenarios require explicit, unique `scenarioId` values.
The runner validates repetitions, the demonstration grid, and finite scores in `[0,1]`.

Comparisons require identical scenario cohorts and identical demonstration grids.
Missing pairs, duplicate identities, and changing cohorts are errors.
The comparison computes one area per scenario before applying the existing paired estimators.
This preserves dependence across demonstration counts.
Repeated executions improve each scenario mean without increasing the number of independent scenarios.

`perK` intervals describe the curve.
The paired area decisions determine `a_better`, `b_better`, `inconclusive`, or `insufficient_evidence`.
Continuous area outcomes require the bootstrap minimum of 20 paired scenarios.
Binary area outcomes use the shared score-interval rule and can support a decision with fewer observations.
The deciding interval must remain nondegenerate.
`inconclusive` does not establish equivalence.
`firstPassK` describes the first observed crossing and carries no reliability guarantee.

## Perturbation sensitivity is a diagnostic

`runContaminationProbe` reports observed score differences and one global Wilcoxon paired test.
Use `alpha` for that test's significance threshold.
Per-item differences carry no p-values or q-values because the probe defines no calibrated item-level sampling null.

The report retains every observed pair and lists `excludedScenarioIds` when a score floor excludes evidence.
Summaries describe the included population.
Fewer than four included pairs produce `pairedTest: null` while preserving measured means and medians.
Zero included pairs produce null summaries.

A significant drop can reflect changed task difficulty, broken perturbations, or contamination.
`contaminationSuspected` therefore requests investigation; it does not identify the cause.
The global test also relies on independent pairs and the Wilcoxon assumptions for paired differences.
