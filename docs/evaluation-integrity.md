# Evaluation claims and automated improvement

Use reusable evaluations to guide development and select candidates.
Declare stronger evidence requirements when a result must support a broader claim.
`selfImprove()` returns its selected surface and measured lift even when its release gate remains inconclusive.

The package separates three questions:

| Question | Evidence | Public entry |
| --- | --- | --- |
| Did this change help on these cases? | Paired scores, failures, cost, and case coverage. | `defineAgentEval()` or `selfImprove()` from `/contract`. |
| Does the improvement extend to new tasks? | Representative independent tasks, a declared effect, and an appropriate comparison. | Optional `claim` on campaign comparisons; registered rules from `/experiment`. |
| Can fresh final evidence support this adaptive decision? | A frozen comparison, retained access boundaries, and a durable exposure record. | Optional `finalEvidence` on the same comparison. |

These controls reuse the existing execution path, paired estimators, sealed experiments, and locked journal.
They do not add another optimizer or agent runner.

## Declare the comparison without consuming data

```ts
import { defineEvaluationClaim } from '@tangle-network/agent-eval/experiment'

const claim = defineEvaluationClaim({
  use: 'comparison',
  population: {
    id: 'support-incidents',
    description: 'Support incidents from the deployed product',
  },
  samplingFrame: 'A random sample of incidents from the declared collection window',
  independentUnit: 'source.incidentId',
  generalization: 'new-units',
  minimumEffect: 0.05,
})
```

Pass `claim` to `selfImprove()`, `runImprovementLoop()`, or `compareOptimizationMethods()`.
It remains independent of final-evidence storage.
`minimumEffect` is optional because development reports and absolute-rate measurements need not test an improvement threshold.
When omitted, each existing comparison keeps its documented decision threshold.

`independentUnit` names a field path in each scenario or evidence row.
Variants from one incident must carry the same source identity.
For new-unit claims, automatic `selfImprove()` partitions keep those variants together.
Fixed-roster claims retain source units in reports without requiring disjoint sources between development partitions.
Explicit partitions for new-unit claims must not share source units between development and final evaluation.

The default self-improvement gate averages paired cells within registered units.
Method comparison first averages repetitions within each scenario, then averages scenarios within each source unit.
It weights source units equally.
Results retain `scenarioScores`, `unitScores`, `units`, and `pairedCellN` so callers can inspect each denominator.
Custom gates receive the same measured evidence and remain responsible for their own decision rules.

`fixed-roster` describes the specified cases.
Repeated executions can measure execution variability on that roster.
They do not establish task diversity or performance on unseen users.
Claim metadata records the intended scope; it does not authenticate sampling or turn an exploratory result into certification.

## Interpret small and inconclusive results

There is no universal task count that proves an improvement.
The effect, outcome type, dependence, confidence level, and decision procedure determine what the evidence supports.

Paired binary decisions use the shared score interval and exact discordance check.
A sufficiently large binary gain can pass with fewer than 20 independent pairs.
Continuous mean decisions require the existing bootstrap path's 20-pair eligibility threshold.
That implementation threshold does not establish adequate power or guarantee interval coverage for every distribution.
The smaller-sample sign test answers a different question about directional or median change.

Method rankings describe observed lift.
`favored: null` means the evidence does not establish a favored method; it does not establish equivalence.
Each score and pairwise contrast retains its full `decision`, including the estimator, threshold, minimum, and sufficiency.
An inconclusive gate leaves the selected candidate available for further development or a narrower evaluation.

Use `clusteredPower()` or a registered `power-floor` gate before an expensive population-level comparison.
Both assess power at the declared `minimumEffect`.
High power at a much larger effect cannot substitute for power at the improvement that matters.

## Opt into fresh final evidence

```ts
import { openFinalEvidenceLedger } from '@tangle-network/agent-eval/experiment'

const finalEvidence = {
  ledger: openFinalEvidenceLedger({ path: '.agent-eval/final-evidence.jsonl' }),
  requestId: 'support-comparison-2026-09-13',
  evaluatorDigest, // Content identity of the actual evaluator and its configuration.
}

// Pass both claim and finalEvidence to the existing comparison entrypoint.
```

Ordinary regression and development evaluations remain reusable.
Supply this policy when freshness is part of the evidence supporting a particular final comparison.
It requires a comparison or certification claim and measured final execution.

The campaign reserves source units before candidate search.
It records exposure before dispatching the baseline, selected candidates, or an optional neutralized control.
Failed or interrupted final execution still consumes that evidence.
An already exposed request cannot start another final measurement.

The ledger permits exact retries of reservation and exposure writes.
Campaign entrypoints refuse a replayed exposure so competing workers cannot each start a new measurement.
Read retained campaign artifacts after exposure; a fresh request ID does not restore freshness.

Source unit identities are unique across the shared ledger, including across population labels.
The ledger also rejects the same dataset digest under another request.
Use one persistent ledger for related decisions and preserve stable source identities.
Opening another empty ledger or inventing new lineage identities cannot establish independent evidence.

`FinalEvidenceLedger` returns typed outcomes.
Inspect `succeeded` before reading `value`.
Failures distinguish conflicting use, invalid input, and unavailable or damaged storage.
Campaign errors preserve these categories through `FinalEvidenceError.kind`.

The filesystem implementation uses the existing hash-chained journal, process locks, durable writes, and required trusted head.
Preserve both the journal and its `.head` file.
The head detects truncation while it remains trusted.
An actor who can replace both files can replace the recorded history.

The host owns answer-file permissions, model context, credentials, and author/evaluator separation.
The ledger records exposure; it cannot prove that earlier undisclosed access never occurred.

## Seal the rule and measured field

Attach the same `claim` to `defineExperiment()` before calling `sealExperiment()`.
Cluster intervals register both the source unit and measured field:

```ts
const interval = {
  kind: 'cluster-bootstrap' as const,
  clusterBy: 'source.incidentId',
  value: 'pairedDelta',
  resamples: 2000,
  seed: 7,
  level: 0.95,
  method: 'percentile' as const,
}

// Register interval in the experiment's intervals map before sealing.
// Then execute registered.interval('lift', { kind: 'rows', rows }).
```

New-unit claims reject intervals that resample a different field.
Registered binomial intervals require one unique `unitId` per trial for new-unit claims.
Opened seals capture validated rules before asynchronous execution.
Caller mutation cannot change the opened experiment's rules.

Only current canonical digest schemes can execute.
Retain historical artifacts with their original identities; re-register current work under the supported format.
See [registered experiments](./experiment.md) for the complete rule language.

## Audit an evaluator's errors

Use `auditEvaluator()` from `/meta-eval` when admitting a new checker or model judge.
Provide actual judgments of independently verified good and bad controls.
Each observation names its source unit, evidence reference, expected decision, observed decision, and development exposure.

The audit measures false acceptance and false rejection separately.
A source unit fails a class when any variant in that class is misjudged.
Repeated variants increase case coverage without increasing the independent-unit count.
If a source appeared during evaluator development, every supplied variant from that source is excluded from fresh audit evidence.

The audit uses exact binomial bounds and adjusts the two intervals for simultaneous confidence.
Unknown judgments remain visible and contribute their most adverse possible outcomes to each upper bound.
Admission is possible when both worst-case upper bounds meet policy.
If unresolved outcomes affect the measured error rate, that rate is `null`.
An always-accept checker fails false acceptance; an always-reject checker fails false rejection.

Reports retain inputs, source coverage, exclusions, unknowns, limits, and content digests.
The declared audit authority must differ from the evaluator author.
Different identifiers alone do not prove independence; the host must enforce and record separation.
Audit cases must represent the stated population and a consistent control-generation procedure.
Changing the number or kind of variants changes the meaning of an any-variant error rate.

`auditEvaluator()` measures supplied judgments.
It does not execute models or automatically approve a deployment.
For outcome associations and direct score calibration, use [the outcome-validity tools](./outcome-validity.md).

## Test whether self-improvement is useful

These integrity checks establish execution and measurement behavior.
They do not establish that a particular optimizer improves agents across domains.
The [historical evidence audit](./design/self-improvement-evidence-audit.md) records prior gains, nulls, regressions, and their limits.

For a benefit experiment, define the user behavior and useful effect before search.
Compare the starting agent, a direct edit or simple search baseline, and the proposed improvement method at equal actual resources.
Give every method the same allowed preparation, feedback, tools, and candidate surface.
Retain all attempts, costs, failures, selected candidates, and final comparisons.

Before interpreting a null result, verify that candidate generation executed and the evaluator distinguishes plausible improvements from regressions.
Measure improvement under the conditions where the method claims an advantage.
Use fresh tasks when the conclusion concerns unseen tasks.
Treat a result on a fixed product workflow as evidence for that workflow.
Repeat across distinct domains before making a broad claim.

The [offline example](../examples/evaluation-integrity/) exercises these public APIs and exports its report without paid calls.
It verifies the integration with deterministic fixtures; it is not an optimizer-benefit study.

## Source and design rationale

The book motivates the distinctions; the API and policies are project design choices.

| Source | Applied idea |
| --- | --- |
| [Chapter 4: purposes of holdout](https://mlbenchmarks.org/04-holdout-method.html#whats-the-holdout-method-for) | Development feedback, selection, and capability measurement require different evidence. |
| [Chapter 3: detecting differences](https://mlbenchmarks.org/03-detecting-differences.html#comparing-similar-models) | Pair comparisons and evaluate precision against the actual effect and independent observations. |
| [Chapter 5: test-set reuse](https://mlbenchmarks.org/05-test-set-reuse.html) | Preserve development feedback while tracking adaptive final-data exposure. |
| [Chapter 11: confounded evaluations](https://mlbenchmarks.org/11-evaluating-language-models.html#confounded-evaluations) | Give methods comparable preparation before judging their adaptation potential. |
| [Chapter 14: judge agreement](https://mlbenchmarks.org/14-evaluation-frontier.html#agreement-alone-is-not-enough) | Measure consequential evaluator errors; agreement alone does not establish correct rankings. |

The [complete review](./design/mlbenchmarks-book-review.md) records all available chapters, repository evidence, and remaining research questions.
