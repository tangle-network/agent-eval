# The experiment subpath

`@tangle-network/agent-eval/experiment` turns an experiment's registration into the object that runs it.

## The covenant

1. **The registered rule is the executed rule.**
   Every rule — row admission, subset selection, estimand, interval, decision table, validity gate, halt, budget, matched budget, reissue — is a typed data node, never a closure or prose.
   `sealExperiment` canonicalizes and hashes the whole tree into one digest.
   Every interpreter takes only a sealed node plus evidence records.
   No execution surface has a parameter for alpha, threshold, metric, or stopping rule, so registered-vs-ran drift is unrepresentable rather than checked.
2. **Refusals live inside artifacts.**
   An inadequate cluster count, a mismatched arm budget, a non-monotone funnel stage, a non-total decision table — each produces a typed verdict object (or a typed error), never a warning sentence beside a number.
3. **A change is a re-seal.**
   `amendExperiment` verifies the current seal, validates the new spec, and appends a `{at, reason, blind[], digest}` entry.
   The digest history is the audit trail; changing what is decided without a new digest is impossible.

## The objects

| object | entry point | what it closes |
| --- | --- | --- |
| Registered-rule AST | `src/experiment/ast.ts` (14 node families) | prose rules; every registered condition compiles to data the seal covers |
| Define / seal / execute | `defineExperiment`, `sealExperiment`, `amendExperiment`, `openSealedExperiment` | hand-written PREREG.md files; the runner executes the sealed rule itself |
| Cluster-aware power | `clusteredPower`, `assertDesignAdequate` | "4 clusters cannot certify any effect size, including 1.0" — learned by running the experiment, now refused before a dollar is spent |
| Denominator chain | `buildFunnel`, `executeAdmissionRule`, `composeFunnels`, `renderFunnelTable` | hand-assembled `20 → 15 → 14 → admitted` chains, formatted differently each run |
| Matched budgets | `verifyMatchedBudgets`, `assertMatchedBudgets` | "realized tokens must agree within 5%" verified by hand |

### Sealing and execution

```ts
import {
  openSealedExperiment,
  sealExperiment,
} from '@tangle-network/agent-eval/experiment'

const sealed = await sealExperiment(spec)      // canonicalize + sha256 over the whole tree
const registered = await openSealedExperiment(sealed) // verifies the digest first

const admission = registered.admit(rows)       // funnel + survivors, from the sealed rule
const gate = registered.gate('power-floor', { kind: 'power-floor', curve })
const halt = registered.halt([gate])           // refuse-spend fires before any contrast
const outcome = registered.decide(quantities)  // the sealed table; non-total tables throw
```

`openSealedExperiment` is the only execution surface.
A rule that is not in the sealed spec cannot run; a rule that is cannot run differently.

### Cluster-aware power refusal

Two floors, one simulation:

- **Closed form, zero spend.** With `C` independent clusters, the exact whole-cluster sign-flip test can never produce a two-sided p below `2^(1-C)`.
  Four clusters give 0.125 and three give 0.25 — both above alpha 0.05, so those designs are refused at any effect size.
  Six clusters is the smallest certifiable count at 0.05.
- **Seeded simulation.** Per-row paired contrasts are drawn under a registered effect model (base win/loss rates, optional noisy clusters), each trial takes a whole-cluster percentile bootstrap, and power is the fraction of trials whose interval excludes zero.

The refusal is a verdict inside the returned artifact (`result.refusal`), with `assertDesignAdequate` as the throwing form.
The `power-floor` validity gate consumes a power curve as evidence and fails when the curve tops out under the registered target.

### The funnel

`buildFunnel` refuses a stage that gains rows, named exclusions that do not sum, and partitions that overdraw their source stage.
`executeAdmissionRule` runs a sealed admission rule over rows and returns the funnel, the survivors, and the partition rows in one object — the chain and the rows can never disagree.
Partitions carry `pooling: 'never'`: a secondary set is reported beside the primary chain and cannot be pooled into it.
The object is its own JSON render; `renderFunnelTable` prints the text table with the reconciliation line (`input = surviving + excluded`).

### Matched budgets

`verifyMatchedBudgets` compares realized per-arm tokens under the registered tolerance and returns a verdict whose `refusal` field carries `onFail: 'refuse-contrast'` when arms diverge.
A contrast between arms that spent differently is not a contrast; the refusal is the artifact that says so.

## Acceptance: the three preregistrations

The module's acceptance suite (`tests/experiment/preregistration-acceptance.test.ts`) re-derives the week's three hand-written preregistrations as sealed specs and reproduces each recorded decision by executing the sealed rules against the recorded evidence:

- **killtest-20260810** — all four validity gates fail on the recorded evidence (the rep-4 oracle flip, the 2-row population drift, the zero-call control, the 0.692 power ceiling) and the halt rule refuses the spend, matching the recorded `$0.00, contrast never run`.
  The obligation node routes a positive interval without the registered control to `blocked-pending-registered-control`, never to `thesis-survives`.
- **freelunch-20260810** — the admission funnel reproduces the recorded `48 > 43 > 35 > 35 > 32` chain with the 3-row secondary partition; the uniform-pass budget reproduces the recorded uniform n=2; the amendment-6 ledger under the same sealed rule refuses pass 2 — the registered-vs-ran divergence the seal makes unrepresentable; the report-only decision reproduces `3/64` and `2/32`.
- **tbench-20260808 milestone 2** — the round-robin selection reproduces the recorded 20-row subset in pick order; the m3 subset filters the SEALED m2 draw (16 rows); the decision table on the recorded interval reproduces `not-certified-at-this-n`.

## What is composed, not duplicated

The statistical machinery underneath is re-exported from its existing homes; this subpath adds registration and refusal, not estimator forks.

| family | home |
| --- | --- |
| `pairedBootstrap`, `mcnemar`/`mcnemarPower`/`mcnemarRequiredN`, `pairedRiskDifference*`, `holm`, `benjaminiHochberg`, `eProcess`, `wilson`, `mulberry32`, sample-size helpers | `src/statistics.ts` |
| `pairedEvalueSequence` (anytime-valid) | `src/sequential.ts` |
| `powerPreflight` (variance-based MDE refusal) | `src/campaign/gates/power-preflight.ts` |
| `sequentialPairedGate`, `sequentialDecide` (manifest-bound) | `src/campaign/gates/sequential.ts` |
| `heldoutSignificance`, `pairHoldout` | `src/campaign/gates/statistical-heldout.ts` |
| `paretoSignificanceGate`, `buildEvidenceVector` | `src/campaign/gates/promotion-policy.ts` |
| `pairArms`, `comparePairedArms`, `pairRunRecords` | `src/paired-arms.ts` |
| `canonicalize`, `hashJson`, `signManifest`, `verifyManifest`, `HypothesisManifest` | `src/pre-registration.ts` |
| `ExperimentTracker` (run ledger with KEEP/ITERATE/NOISE/REGRESSION) | `src/experiment-tracker.ts` |

`HypothesisManifest` stays as the lightweight single-metric registration; `sealExperiment` is the full-design registration.
The trace-repair admission machinery (`buildDenominatorChain`, oracle determinism, control policy) keeps its repair vocabulary in `./trace-repair`; this module is the general form new experiments should register against.

## Where this sits

This is Wave 2 of the [charter](./charter.md): the experiment subpath, built after the kill test that re-derived the three preregistrations as decision-rule objects (verdict: extended — ten node families beyond the seed AST, no opaque node, no rule dropped).
Wave 3 wires these objects to the live-sandbox seam; the improvement receipt (Wave 4) serializes a sealed experiment's digest, gates, and refusal outcomes into one attested file.
