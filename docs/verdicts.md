# Verdicts and certifications

`DefaultVerdict` is the shared base type for validator results.
Campaign judges return `JudgeScore`, and release gates return `GateResult`; their fields and score scales differ.
See [release check results](./concepts.md#release-check-results) when interpreting a campaign decision.

In `DefaultVerdict`, `valid` reports whether the validator's pass criteria were met, and `score` is its aggregate in [0, 1].
Optional `scores` and `notes` carry dimensions and explanation.
Optional `certification` records the verification strategy, checker identity, assumptions, and evidence digest.
A certification can accompany a failed or incomplete check.
It does not establish that the result passed or that every required measurement exists.

The certification fields are:

- `strategy`: the [verification strategy](./verification-strategies.md), with its documented failure mode.
- `checker`: a name, version, and optional dependency pins.
- `assumptions`: the producer's list of steps the checker did not verify.
- `evidenceDigest`: the evidence identity; `certificationEvidenceDigest()` hashes its JSON-serialized form with canonical JSON and SHA-256.

These fields record the producer's claims.
Reproduction also requires access to the evidence, checker, dependencies, and execution environment.
An absent certification means no verification strategy is recorded for that verdict.

## Producers

These result types extend `DefaultVerdict`.
Their additional fields distinguish failed checks from incomplete or unmeasured work.

| Producer | Result type | Strategy | Scope | Fields to inspect |
| --- | --- | --- | --- | --- |
| `MultiLayerVerifier.run()` | `VerificationReport` | `composite` | Ordered verification layers | `layers`, `allPass`, and optional `taskScore` |
| `verifyCompletion()` | `CompletionVerdict` | The supplied checker's strategy | Completion requirements matched against produced state | Requirement evidence, `correct`, and `unmeasured` |
| `evaluateTraceContract()` | `ContractVerdict` | `invariant` | Temporal rules over recorded spans | Rule results and assumptions about ordering and predicates |
| `evaluateOracles()` | `OracleReport` | `test` | Declared expected-outcome assertions | `results`, `passCount`, and `failCount` |
| `replayVerify()` | `ReplayVerdict` | `replication` | Failure reproduction and an optional fix under re-execution | Prefix fidelity, signature matches, and both execution arms |
| `verifyFindings()` | `VerifyFindingsRun` | `replication` | Analyst findings checked through replay | `executions`, `counts`, and individual verifications |
| `gradeRepairRow()` | `RepairRowResult` | `test` | A repair against the admitted row's held-out suite | The grade's outcome and funnel evidence |
| `equivalenceVerdict(record)` | `DefaultVerdict` | The record's strategy | Formal-statement equivalence checked by `runEquivalenceCheck()` | Whether the obligation was proved, refuted, or unresolved |

Certification is conditional for several producers:

- `verifyCompletion()` includes it when the supplied checker provides an attestation.
  Inspect requirement evidence to see which checks were assessed.
- `equivalenceVerdict()` includes it for a proved or refuted obligation with an evidence digest.
  A certified refutation has `valid: false`.
- `gradeRepairRow()` includes it only for a `measured` grade.
- `verifyFindings()` includes it only when at least one replay execution ran.
  Non-replayable findings remain in `counts` and are excluded from the score's denominator.
  A score of 1 can therefore coexist with `valid: false` when some findings were not replayable.

Some result shapes use `score: 0` when no task measurement is available.
For `VerificationReport`, use the presence of `taskScore` to identify a complete task measurement; `blendedScore` can describe a partial panel.
An empty oracle set has certification metadata but returns `valid: false` and no executed oracle results.
Read these completeness fields before using scores as task labels or release evidence.

## Reading a score from a model judge

A tied dimension score supplies no ordering between candidates.
`llmJudge({ scoring })` controls how the dimension score is read:

| `scoring` | Measurement | Requirement |
|---|---|---|
| `{ method: 'sampled' }` (default) | The emitted grade | A valid grade response |
| `{ method: 'expectation', whenUnavailable }` | A probability-weighted grade from returned token alternatives | `scale: 'ten'` and provider log probabilities |

With `scale: 'ten'`, the model emits grades from 0 to 10; `llmJudge()` divides them by 10 before returning dimensions and composite.
Expectation scoring finds each grade's token, keeps valid integer alternatives, and renormalizes their returned probabilities before averaging.
Its distribution is limited to those returned alternatives.
Additional precision alone does not establish better calibration or ranking accuracy.

Each emitted grade must occupy one integer token for expectation scoring.
A split `10`, missing grade token, or unavailable log probabilities invokes `whenUnavailable`:

- `'fail'` throws; the campaign records a judge failure.
- `'sampled'` uses the emitted grades for that judge result.

`JudgeScore.scoringMethod` is present when `scoring` was explicitly configured and records the method used.
An expectation request that falls back reports `'sampled'`.
When `scoring` is omitted, sampled scoring is the default and this metadata field is absent.
`JudgeScore.distribution` is present only for expectation scoring and contains the normalized probabilities over returned integer alternatives.
`ensembleJudge()` consumes the resulting composite through its usual interface.

Provider and model support determines whether log probabilities are available.
`LlmCallResult.logprobs` is `null` when none were returned.
The [recorded wire check](../evidence/records/judge-logprob-wire-support.json) documents the endpoints and conditions that were inspected.

## Interpreting certification limits

Read `VERIFICATION_STRATEGIES[strategy].failureMode` alongside the evidence and assumptions.
A judge can reward misleading output; tests cover their suite; a proof can establish the wrong formal statement for the intended task.
A composite certification requires inspection of its component results.
An empty assumptions list is the producer's declaration, not independent verification that no assumptions remain.

See [verification strategies](./verification-strategies.md), [repair grading](./trace-repair-grader.md), and [trajectory replay](./trajectory-replay.md) for the corresponding execution contracts.
