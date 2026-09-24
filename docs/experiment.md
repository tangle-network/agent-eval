# The experiment subpath

`@tangle-network/agent-eval/experiment` registers decision rules as data and provides interpreters bound to a verified seal.

The [`evidence/` registry](../evidence/README.md) stores published measurements and their experiment identities.
Sealing does not execute an agent or publish an evidence record.

## What a seal enforces

1. `sealExperiment()` validates and hashes the specification, including its registered rules and optional claim.
2. `openSealedExperiment()` verifies that digest and captures the rules before returning the execution handle.
   Its decision, interval, gate, and budget methods read their rules from that captured specification.
3. `amendExperiment()` verifies the current seal, validates the replacement specification, and records its digest, reason, time, and declared blindness.

A seal verifies the current specification's identity.
It does not authenticate registration time, amendment history, or the origin of supplied measurements.
The host must retain evidence, invoke the required checks, and honor their refusal results.
Calling `registered.decide()` does not automatically run admission, power, budget, or halt checks.

## The objects

| Object | Entry point | Purpose |
| --- | --- | --- |
| Registered rules | [Rule types](../src/experiment/ast.ts) and [`ExperimentSpec`](../src/experiment/define.ts) | Describe admission, estimation, intervals, and decisions as data. |
| Define / seal / execute | `defineExperiment`, `sealExperiment`, `amendExperiment`, `openSealedExperiment` | Validate, identify, and execute the registered rules. |
| Cluster-aware power | `clusteredPower`, `assertDesignAdequate` | Assess a declared effect under a simulated outcome model and cluster-count policy. |
| Denominator chain | `buildFunnel`, `executeAdmissionRule`, `composeFunnels`, `renderFunnelTable` | Reconcile retained and excluded evidence. |
| Matched budgets | `verifyMatchedBudgets`, `assertMatchedBudgets` | Check realized tokens against a declared tolerance. |
| Randomized served canary | `sealRandomizedCanaryRule`, `decideRandomizedCanary` | Decide fixed-horizon assignment-level lift from checked binary outcomes. |

### Randomized served canary

Use the canary decision when control and candidate receive different live assignments.
The paired promotion rule applies to replayed cases, not this served comparison.

Seal the prospective protocol before the first eligible assignment.
Register eligibility, randomization, both profiles, served revision, checker revision, assignment unit, cluster unit, fixed cutoff, outcome maturity, and minimum lift.
Register one confirmatory family slot before traffic.
The family size sets an additional Bonferroni interval; the nominal 95% headline keeps its original definition.
An independent witness must establish protocol timing and prevent reusing a family slot.
The seal detects edits but cannot authenticate its own creation time or family reservation.

At the fixed assignment cutoff, freeze the complete append-only assignment ledger.
Its roster digest covers every assignment ID, assignment source ID, cluster ID, and arm.
Assignment IDs and assignment source IDs must each be unique, so a retry cannot enter the denominator twice.
At exactly `analysisCutoff + outcomeMaturityMs`, freeze the complete outcome, trace, turn, and billed-cost snapshot.
Retain the assignment ledger tip, observation snapshot digest, and independent attestation source.
The required host verifier checks ledger signatures, authority, registration timing, family reservation, randomizer execution, and the fixed snapshot.
It receives the cohort receipt and sealed protocol, so it can resolve each registered source against the independent services.
It verifies eligibility before assignment and an immutable disposition for every eligible arrival through the cutoff.
It resolves each assignment to the raw trace or checked no-execution record, checker result, settled bill, and served revision.
It also verifies arm-isolated memory and persistent state, or witnessed statelessness, for every assignment design.
The library checks the receipt's identities, counts, digests, and times against the supplied rows and sealed protocol.
An arbitrary verifier that returns success does not establish independent evidence.

Keep every assigned unit in its original arm, including failed executions.
Use outcome `0` only when the registered checker established failure.
Use `null` when a checked outcome is unavailable; missing evidence refuses inference.
A missing trace is valid only with an independent no-execution source, zero turns, zero billed cost, and checked failure.
The library refuses changed served profile, code revision, or checker revision.
It also refuses fewer than 40 clusters, fewer than 20 clusters per arm, a dominant cluster, or zero variance.

The estimand is candidate minus control checked success probability across **all assigned units**.
The interval uses a cluster sandwich variance and Student-t critical value with `G - 1` degrees of freedom.
A customer cluster may contain sessions in both arms; their covariance remains in one contribution.
Such traffic needs arm-isolated memory and persistent state to avoid treatment spillover into control.
Use customer assignment when that isolation cannot be proved.
This large-cluster approximation requires independent clusters, trustworthy randomization, stable serving, and the fixed observation snapshot.
It is neither an anytime-valid sequence nor an exact small-sample test.

`nominal95Interval` and `headline95Pass` report the fixed live headline.
`familyAdjustedInterval` and `familywisePass` provide the additional repeated-candidate guard.
`successCriterionMet` requires both, but it is only the primary lift criterion.
The product still applies its registered cost and latency guardrails before any release.
Arm coverage counts and billed-cost totals remain visible; missing cost stays `null`, never a measured zero.

```ts
import {
  decideRandomizedCanary,
  sealRandomizedCanaryRule,
} from '@tangle-network/agent-eval/experiment'

const protocol = sealRandomizedCanaryRule({
  experimentId: 'served-agent-2026-09-24',
  populationId: 'eligible-live-requests',
  eligibilityRuleDigest: 'eligibility-revision',
  randomizationSourceId: 'randomizer-receipt-id',
  assignmentLedgerAuthorityId: 'platform-ledger',
  controlProfileDigest: 'control-profile-digest',
  candidateProfileDigest: 'candidate-profile-digest',
  servedCodeRevisionDigest: 'served-revision-digest',
  outcomeCheckerDigest: 'checker-revision-digest',
  confirmatoryFamilyId: 'weekly-live-agent-improvement',
  confirmatoryFamilySize: 1,
  confirmatoryIndex: 1,
  familyReservationSourceId: 'family-ledger-slot-id',
  assignmentUnit: 'session',
  clusterUnit: 'customer',
  stoppingRule: 'fixed-time',
  analysisCutoff: '2026-09-25T06:00:00Z',
  outcomeMaturityMs: 120_000,
  minimumLift: 0,
  minimumClusters: 40,
})

// Witness `protocol` and reserve the family slot before serving traffic.
// The host freezes `cohortReceipt` and `checkedObservations` at the registered times.
const decision = decideRandomizedCanary(
  protocol,
  cohortReceipt,
  checkedObservations,
  verifyPlatformCohortReceipt,
)
if (decision.refusal !== null) throw new Error(decision.refusal)
```

`cohortReceipt` binds the post-cutoff complete roster and the fixed observation snapshot to the prospective protocol.
The deterministic calibration in `src/experiment/randomized-canary.test.ts` used 500 trials per law, 60 customers, and four sessions per customer.
Each customer had a shared pass propensity of 0.25 or 0.65 with equal probability.
Two sessions entered each arm in random order; the positive law added 0.20 to candidate pass probability.
The nominal 95% headline passed 14/500 null trials (2.8%) and 465/500 positive trials (93.0%).
These frequencies only calibrate this stated synthetic law and do not prove coverage for other cluster structures or live traffic.

### Sealing and execution

```ts
import {
  openSealedExperiment,
  sealExperiment,
} from '@tangle-network/agent-eval/experiment'

const sealed = await sealExperiment(spec)
const registered = await openSealedExperiment(sealed)

const admission = registered.admit(rows)
const gate = registered.gate('power-floor', { kind: 'power-floor', curve })
const halt = registered.halt([gate])
if (halt.fired) throw new Error(`Experiment halted: ${halt.failedGates.join(', ')}`)
// Compute quantities from the admitted evidence, then call registered.decide(quantities).
```

This fragment assumes `spec` registers admission, the named gate, and a halt rule.
Malformed specifications and unusable evidence throw typed errors; decision and validity refusals remain in returned artifacts.

Cluster intervals register both `clusterBy` and `value` inside the sealed `IntervalSpec`.
Call `registered.interval('gain95', { kind: 'rows', rows })` to apply those fields.
The row evidence cannot override the registered value field.
Changing the measured field requires a new seal.

For a paired contrast, prepare one difference per pair and register that difference field as `value`.
A pooled pass rate from both arms measures a different quantity.
The [runnable sealed experiment](../examples/sealed-experiment/index.ts) demonstrates the paired path.
Confidence levels, field paths, seeds, and resample counts are validated before sealing and direct computation.

Older cluster interval registrations omitted `value` and require their original package version for execution.
Retain their original bytes and evidence; create a new registration for subsequent measurements.

#### Canonical identities and migration

Readers and writers use RFC 8785 canonical JSON from `ledger-core/canonical`.
Verification refuses missing or unsupported digest schemes.

| Artifact | Required identity | Refusal |
|---|---|---|
| Sealed experiment | `algo: 'sha256-rfc8785'` | `verifySealedExperiment()` returns `false`; `openSealedExperiment()` refuses execution |
| Signed hypothesis | `algo: 'sha256-rfc8785'` | `verifyManifest()` returns `false`; synchronous digest checks and hypothesis evaluation refuse the record |
| Agent profile cell | `agent-profile-cell:sha256-rfc8785:<digest>` | Cell validation refuses any other scheme |
| Report attestation | Report hash and required `envelopeHash` over its provenance | `verifyAttestation()` returns an invalid result with a reason |

The package no longer verifies `sha256-content` records, untagged manifests, bare `agent-profile-cell:sha256:` identifiers, or attestations without provenance envelopes.
Keep those records unchanged as historical artifacts with their original package version.
Create new registrations with `sealExperiment()` or `signManifest()` before collecting new decision evidence.
Use `buildAgentProfileCell()` and `attest()` to produce current identities from independently verified source material.
Never relabel an existing digest or reconstruct a provenance envelope from unverified metadata.
A new digest cannot establish that a registration existed before its evidence was observed.

Use the opened handle when the result must follow a particular registration.
Direct helpers such as `computeInterval()` and `executeDecisionRule()` also accept unsealed rules for development.
They do not establish a link to a registered experiment.

### Cluster-aware power refusal

`clusteredPower()` combines a cluster-count policy with a simulated power curve:

- The exact whole-cluster sign-flip test has a minimum two-sided p-value of `2^(1-C)` for `C` independent clusters.
  At alpha 0.05, this policy requires at least six clusters; four give 0.125 and three give 0.25.
- Seeded simulations draw paired contrasts under the configured win/loss model and apply a whole-cluster percentile bootstrap.
  Power is the fraction of simulated intervals that exclude zero.

The six-cluster floor is a policy for this helper, not a universal requirement for every estimator or fixed-roster evaluation.
The helper computes both results; it does not skip simulation when the cluster-count policy fails.

The refusal is a verdict inside the returned artifact (`result.refusal`), with `assertDesignAdequate` as the throwing form.
Both `clusteredPower` and the registered `power-floor` gate require `minimumEffect`.
The gate evaluates a supplied curve; it does not run the simulation itself.
The effect must appear exactly in the supplied grid; the API does not interpolate.
Adequacy requires target power at that effect.
`maxPower` describes the grid and cannot establish adequacy at a smaller effect.

```ts
import { assertDesignAdequate, clusteredPower } from '@tangle-network/agent-eval/experiment'

const power = clusteredPower({
  clusterSizes: Array.from({ length: 24 }, () => 3),
  effects: [0.05, 0.1, 0.2],
  minimumEffect: 0.1,
  targetPower: 0.8,
  seed: 17,
})

assertDesignAdequate(power)
```

Simulation effects are expected paired contrasts within signal clusters.
The zero-effect model requires equal `baseWinRate` and `baseLossRate`.
Configured noisy clusters retain zero expected contrast, so they dilute the pooled population effect.
Power remains conditional on this outcome model, the registered sampling structure, and the simulated test.
The [statistical evidence guide](./statistical-evidence.md) explains unit counts, adaptation comparisons, and sequential assumptions.

### The funnel

`buildFunnel` refuses a stage that gains rows, named exclusions that do not sum, and partitions that overdraw their source stage.
`registered.admit(rows)` applies the sealed admission rule and returns the funnel, survivors, and partition rows together.
The standalone `executeAdmissionRule(rule, rows)` also accepts an unsealed rule.
Partitions carry `pooling: 'never'`: report each secondary set separately from the primary chain.
The object is its own JSON render; `renderFunnelTable` prints the text table with the reconciliation line (`input = surviving + excluded`).

### Matched budgets

`verifyMatchedBudgets` compares realized per-arm tokens under the registered tolerance and returns a verdict whose `refusal` field carries `onFail: 'refuse-contrast'` when arms diverge.
Use this check when the claim requires matched token use.
An unequal-budget comparison answers a different question and must retain the resource difference in its interpretation.

## Acceptance: the three preregistrations

The [acceptance suite](../tests/experiment/preregistration-acceptance.test.ts) encodes three historical preregistrations as sealed specifications.
It checks their recorded decisions against fixed evidence:

- **killtest-20260810**: all four validity gates fail on the recorded evidence.
  The failures are the rep-4 oracle flip, 2-row population drift, zero-call control, and 0.692 power ceiling.
  The halt rule refuses spend, matching the recorded `$0.00, contrast never run`.
  The obligation node routes a positive interval without the registered control to `blocked-pending-registered-control`, never to `thesis-survives`.
- **freelunch-20260810**: the admission funnel reproduces `48 > 43 > 35 > 35 > 32` with the 3-row secondary partition.
  The uniform-pass budget reproduces uniform n=2; the amendment-6 ledger under the same sealed rule refuses pass 2.
  The report-only decision reproduces `3/64` and `2/32`.
- **tbench-20260808 milestone 2**: round-robin selection reproduces the recorded 20-row subset in pick order.
  The m3 subset filters the sealed m2 draw to 16 rows.
  The decision table on the recorded interval reproduces `not-certified-at-this-n`.

## What is composed, not duplicated

The statistical machinery underneath is re-exported from its existing homes; this subpath adds registration and refusal, not estimator forks.

| family | home |
| --- | --- |
| `pairedBootstrap`, `mcnemar`/`mcnemarPower`/`mcnemarRequiredN`, `pairedRiskDifference*`, `holm`, `benjaminiHochberg`, `eProcess`, `wilson`, `mulberry32`, sample-size helpers | [`src/statistics/index.ts`](../src/statistics/index.ts) |
| `pairedEvalueSequence` (anytime-valid) | `src/sequential.ts` |
| `powerPreflight` (variance-based MDE refusal) | `src/campaign/gates/power-preflight.ts` |
| `sequentialPairedGate`, `sequentialDecide` (manifest-bound) | `src/campaign/gates/sequential.ts` |
| `heldoutSignificance`, `pairHoldout` | `src/campaign/gates/statistical-heldout.ts` |
| `paretoSignificanceGate`, `buildEvidenceVector` | `src/campaign/gates/promotion-policy.ts` |
| `pairArms`, `comparePairedArms`, `pairRunRecords` | `src/paired-arms.ts` |
| `hashJson`, `manifestContentDigest`, `signManifest`, `verifyManifest`, `HypothesisManifest` | `src/pre-registration.ts` |
| `ExperimentTracker` (run ledger with KEEP/ITERATE/NOISE/REGRESSION) | `src/experiment-tracker.ts` |

`HypothesisManifest` stays as the lightweight single-metric registration; `sealExperiment` is the full-design registration.
The trace-repair admission machinery (`buildDenominatorChain`, oracle determinism, control policy) keeps its repair vocabulary in `./trace-repair`; this module is the general form new experiments should register against.

## Where this sits

The [charter](./charter.md) describes current package ownership and host responsibilities.
Use [evaluation claims and final evidence](./evaluation-integrity.md) when connecting a registration to an automated improvement workflow.
