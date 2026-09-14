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
