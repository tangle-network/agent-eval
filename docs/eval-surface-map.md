# Eval surface map: which primitive, when

Choose the public entry point by the decision you need to make.
The [README](../README.md#choose-a-workflow) starts with the common product workflows.
This reference covers direct execution controls and specialist modules.

## The run primitives

| Primitive | Import | Use | Returns |
|---|---|---|---|
| [`runCampaign()`](../examples/plan-before-you-spend/) | `/campaign` | Execute and judge a scenarios × repetitions grid through caller-owned dispatch. | `CampaignResult` |
| [`runEval()`](../src/campaign/presets/run-eval.ts) | `/contract` or `/campaign` | Score one surface with campaign defaults. | `CampaignResult` |
| [`runProfileMatrix()`](../examples/profile-matrix/) | `/campaign` | Run the same cases across named agent profiles with provenance and backend checks. | `RunProfileMatrixResult`, including `.records`. |
| [`runOptimization()`](./campaign-proposers.md#write-a-custom-candidate-generator) | `/campaign` | Generate, measure, and select candidates on development cases. | Generations and a winner surface. |
| [`runImprovementLoop()`](./multi-shot-optimization.md) | `/contract` or `/campaign` | Search, compare on final cases, and apply a release gate. | Final comparison, winner, and gate decision. |
| [`compareOptimizationMethods()`](../examples/compare-optimization-methods/) | `/campaign` | Compare selected surfaces from several methods under declared budgets. | Final paired contrasts, uncertainty, and costs. |
| [`runEvalCampaign()`](../src/eval-campaign.ts) | Root | Run with a caller-supplied trace sink and emitter. | Campaign result and records. |
| [`runAgentMatrix()`](../src/matrix/runner.ts) | `/matrix` | Schedule a general Cartesian grid without campaign scoring semantics. | Cell results. |

When variants of the same task run inside one `runCampaign`, give those scenarios the same `seedGroup` so each repetition uses common randomness.
Use `runProfileMatrix` instead when profiles are separate campaign axes.
Set `maxConcurrency` for cases within one profile and `maxProfileConcurrency` for independent profile columns; results retain caller order regardless of completion order.
Every paid-call receipt must match the profile, and a successful moving alias must resolve to one snapshot across the entire profile column.
Failed cells with no served model remain durable with explicit unknown model, cost, and usage fields.
The caller commit and profile config are always part of cache identity; set `dispatchRef` when execution behavior can change without a new commit.
A failed profile cancels active sibling columns before the matrix rejects.

When one external grant cannot run the complete profile matrix, use
`createProfileMatrixPlan`, `runProfileMatrixSegment`, and
`finalizeProfileMatrix` from the same campaign surface.
The plan hashes the complete profiles × scenarios × reps design and assigns
one stable row identity to every cell.
Each segment claims explicit, disjoint rows and can reuse its segment identity
to retry failed cells from Eval's durable campaign cache.
Finalization refuses missing, overlapping, stale, corrupt, or duplicate rows,
then returns the ordinary `runProfileMatrix` result and its distributions.
Coverage reports missing, failed, and zero-score rows separately.

## Claims, evaluator checks, and final evidence

| Concern | Import | Public API |
|---|---|---|
| Declare population and independent units | `/experiment` | `defineEvaluationClaim()`, `summarizeEvaluationUnits()` |
| Register an executable decision | `/experiment` | `defineExperiment()`, `sealExperiment()`, `openSealedExperiment()` |
| Check design adequacy at a practical effect | `/experiment` | `clusteredPower()`, `assertDesignAdequate()` |
| Track final-data reservation and exposure | `/experiment` | `openFinalEvidenceLedger()` |
| Group reusable comparisons by source unit | `/contract` or `/campaign` | The top-level `claim` option. |
| Reserve fresh evidence for confirmation | `/contract` or `/campaign` | Optional `finalEvidence: { ledger, requestId, evaluatorDigest }`. |
| Admit an evaluator against both error limits | `/meta-eval` | `auditEvaluator()` |
| Test a grader with known incorrect items | `/meta-eval` | [`definePlant()`, `seedPlants()`, `catchRate()`](./plants.md) |
| Measure agreement and known bias patterns | `/meta-eval` | `calibrateJudgeContinuous()`, `continuousAgreement()`, `positionalBias()`, `verbosityBias()`, `selfPreference()` |
| Relate scores to declared deployment outcomes | `/meta-eval` | `rubricPredictiveValidity()`, `correlationStudy()`, `calibrationFromPairs()`, `calibrationCurve()` |

The top-level `claim` declares the independent unit for ordinary reusable comparisons.
Include `minimumEffect` when the decision concerns a practical improvement.
Optional `finalEvidence` requires a comparison or certification claim.
It reserves units before search and records exposure before final dispatch.
Its ledger must be shared across related campaigns.
Keep source unit identifiers stable when scenarios or populations are renamed.
The host controls access to private evidence and must preserve author/auditor separation.
[Evaluation integrity](./evaluation-integrity.md) describes these boundaries and the public result shapes.

Outcome associations require an explicit desired direction for predictive validity.
They produce descriptive evidence and experiment hypotheses.
They do not establish a causal benefit from changing a rubric.
See [outcome validity](./outcome-validity.md).

Method comparisons retain `scenarioScores`, `unitScores`, the `units` summary, and `pairedCellN` separately.
`favored: null` means the paired decision did not establish a preferred method.
It does not establish equivalence.
Use the decision diagnostics and intervals to distinguish insufficient evidence from a supported improvement.

## Specialist imports

| Subpath | Use |
|---|---|
| `/traces`, `/trace-attributes` | Store trace evidence, [redact it and check it is safe to share](./redaction.md), [connect observability exporters](./adapters-observability.md), and use canonical measurement attribute names. |
| `/analyst` | Execute declared analysts against recorded evidence. |
| `/reporting`, `/pipelines` | Compare runs, render [research reports](./research-report-methodology.md), and extract recorded failure patterns. |
| `/supervisor-run` | Read recursive run directories and their evidence coverage. |
| `/trace-repair`, `/trajectory-replay` | Execute proposed repairs or replay recorded shell trajectories. |
| `/benchmarks`, `/fuzz` | Adapt benchmark data and explore a declared behavior space. |
| `/builder-eval`, `/multishot`, [`/multishot/golden`](./multishot-golden-records.md) | Evaluate generated applications and multi-turn conversations. |
| `/matrix` | Schedule Cartesian experiment grids. |
| `/rl` | Build reward, preference, and supervised datasets from eligible evidence. |
| `/profile-cell` | Create and validate portable agent-profile identities. |
| `/authenticity`, `/ledger-core` | Check evidence authenticity and maintain canonical hash-chained journals. |
| [`/rollout`](./rollout.md), `/storyboard` | Serialize training rows and render recorded work. |
| `/hosted`, `/wire`, `/adapters/http` | Connect hosted storage or expose evaluation through HTTP and RPC. |

For existing coding-agent transcripts, start with [session intake](./code-agent-intake.md).

Root `Scenario`, `JudgeScore`, and `GateDecision` match `/contract`.
Use root `ProductScenario` and `DimensionJudgeScore` for the product-judging functions.
`HeldOutGate.evaluate()` returns the separate root type `HeldOutGateDecision`.

## What a campaign result reports: the mean and the spread

`CampaignResult.aggregates` carries two maps.
`byJudge` holds one `JudgeAggregate` per judge that produced at least one score.
`byScenario` holds one `ScenarioAggregate` per scenario that produced at least one composite.

Each aggregate reports a mean, a seeded bootstrap `ci95` band, `n`, and a `distribution`.
Here, `n` counts observed scores.
Use registered gates for inference across independent source units; their `pairedCellN` retains the raw paired denominator.
`distribution` is the `SeriesDistribution` value `summarizeNumberSeries` returns: `n`, `min`, `p50`, `p90`, `max`, and `sum` over the exact scores the mean was taken over.
Quantiles use the nearest-rank definition, so every reported quantile is a score the campaign measured.

Read the distribution before you read the mean.
A mean and an interval alone cannot separate a bimodal judge from a tight one, and cannot show the outlier that carried the mean.
Six cells scoring `0, 0, 0, 1, 1, 1` and six cells scoring `0.5` report the same mean; only `min` and `max` tell them apart.

A judge that produced no score has no entry at all.
An absent aggregate is the honest record of an unmeasured judge, and a zero-filled distribution would read as a measured all-zero series.

`SeriesDistribution` is the one distribution summary in this package.
The [insight report](./insight-report.md) explains why its `ScalarDistribution` has a separate shape.

## Planning the cell grid without a run directory

`buildCellSchedule(scenarios, seed, reps)` returns the `(scenario × rep)` fan-out: one `CellScheduleSlot` per cell, with its `cellId` and its per-cell seed.
This function does not access the filesystem.
It can size a design and check cell counts and seeds before a run directory exists.
Scenarios that share a `seedGroup` receive the same per-replicate seeds, which is what makes a paired comparison see common randomness.

Use `planCampaignRun()` to classify cached, pending, and blocked cells.
That call reads the durable cache in a real run directory.
`cellDirectory` and `cellCachePath` name a cell's location once a run directory is chosen.
Use [eval fixtures](./eval-fixtures.md) to load and fingerprint cases from folders before planning their campaign.

## Evidence receipts: `attest`

`attest(report, provenance)` binds a serializable report to its provenance through content hashes.
Provenance records model versions, seeds, the price-table hash, code revision, and input digest.
`verifyAttestation(report, attested)` returns a typed outcome rather than throwing, so a pipeline records why a report failed to verify instead of dying.
`ATTESTATION_ALGORITHM` is the hash-scheme tag every attestation carries, and a verifier rejects an unknown algorithm instead of guessing.
Verification requires an `envelopeHash` that binds the report hash to its provenance.
An absent, malformed, or mismatched envelope makes the attestation invalid.
Signing stays with the consumer: an `AttestedReport` is a stable byte-identical payload to sign, and this package never holds keys.

## Failed cells: receipts and bounded retry

A failed cell writes `<cell>/failure-receipt.json` before the campaign can abort.
The receipt records the stage (`dispatch` or `judge`), the serialized error, the exact cell result, and the settled cost of that cell.
`abortOnCellError: true` stops the campaign on the first failed cell; the default keeps the remaining schedule running and returns the failed cell.

`cellRetry: { attempts, retryable }` opts in to bounded in-run retry.
A failed attempt that `retryable` accepts is dispatched again in the same slot (same `cellId`, same seed) until it succeeds or `attempts` is exhausted.
Use `transientDispatchFailure()` as the predicate to retry only dispatch-stage transport failures (502/503/504, dropped streams, admission rejections) and never judge-stage failures.
Every attempt charges the shared cost ledger, so the final cell's `costUsd` and `costCallIds` cover all attempts.
A retried attempt keeps its receipt at `<cell>/failure-receipt.attempt-<n>.json`, and the final cell records the retry count as `retryAttempts`.
With `abortOnCellError`, the abort fires only when a cell's final attempt fails.
Without `cellRetry`, a failed cell is final: one transient 503 leaves campaign coverage incomplete, and `runImprovementLoop` then refuses the holdout comparison.

## Grade produced state through a judge

Use `extractProducedState()` and `verifyCompletion()` inside a `JudgeConfig` to grade the work an agent produced.
The same judge can run through `runCampaign()` or `runProfileMatrix()`.

```text
runtime events -> extractProducedState(events) -> ProducedState
             -> verifyCompletion(taskGold, state, checker) -> JudgeConfig score
```

The host supplies the correctness checker and the events.
This composition shares campaign execution, capture, and reporting without another runner.
See [product patterns](./product-eval-adoption.md#product-patterns) for host adapters and [knowledge readiness](./knowledge-readiness.md) for required context checks.

### The in-band body contract

Produced events carry their **body in-band**: the grader never reaches into a
product database to recover it:

- `artifact` events carry `content` (the persisted file body).
- `proposal_created` events carry `content` (the `submit_proposal` description) -
  same role, same field name. A title-only filing omits it; a content-less
  proposal is graded presence-only (and, by the completion oracle's rule, does
  not count as a completed deliverable).

Carry deliverable content in the event when the host persists it.
This lets the grader inspect the recorded artifact without querying mutable product storage.
