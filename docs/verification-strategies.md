# Verification strategies: certifying without an answer key

This document covers the verification-strategy family and the blind statement-equivalence protocol (both `src/verification-strategy.ts`), and verdict epistemics (`src/verdict.ts`).
How every executed verifier in this package lands its result in `DefaultVerdict` with a produced certification: [docs/verdicts.md](./verdicts.md).
It is the Wave 5 surface of the charter (`docs/charter.md`): an unsolved problem has no held-out test suite by definition, so the held-out suite must be one member of a strategy family, not the family itself.

The package ships the taxonomy, the record types, and the refusals.
It ships no checker implementation.
A checker is an injected executable boundary that returns a typed outcome, so a consumer binds its own Lean toolchain, invariant harness, replication runner, or judge.
Instruments, never methods.

## The family

Every member has a documented failure mode: the specific way it can certify a wrong result.
A consumer that reads a certification must weigh the member's failure mode, not treat "certified" as one bit.
The registry `VERIFICATION_STRATEGIES` carries each profile at runtime, so a reader can surface the failure mode without this document at hand.

| Member | Determinism | Certifies | Failure mode |
| --- | --- | --- | --- |
| `compile` | deterministic | typecheck / build / lint passed | code that compiles is not code that is correct |
| `test` | deterministic | suite pass-rate against an answer key | certifies nothing outside suite coverage; a stubbed integration reports green |
| `schema` | deterministic | structured output validates | shape is not meaning; a well-formed wrong answer passes |
| `sandbox` | deterministic | sandbox execution exit code | one bit compresses the run; a faked success exits 0 |
| `judge` | probabilistic | LLM judge score | drifts across model versions; Goodhart-gameable by the graded policy |
| `composite` | inherited | weighted blend of members | scalar collapse hides which member carried the score |
| `proof-kernel` | deterministic | a proof assistant's kernel accepted a formal proof | the formalization gap: the kernel never certifies that the formal statement matches the informal claim |
| `invariant` | deterministic | invariant / metamorphic properties held | weak invariants pass everything; a set uncalibrated by seeded bugs is a rubber stamp |
| `replication` | deterministic (given pins) | independent re-execution reproduced the result | re-runs the method, so it never catches an error the method itself carries |
| `agreement` | probabilistic | independently-derived results agree | the shared blind spot: derivers with common corpora or priors agree for the same wrong reason |

Three calibration rules follow from the failure modes.

1. A `proof-kernel` certificate is incomplete until the statement-equivalence obligation below is discharged; the kernel proves theorems about statements, never about intentions.
2. An `invariant` set earns weight only through seeded-bug calibration: demonstrate a mutation the set provably rejects before its pass carries any.
3. An `agreement` certificate is only as strong as its blindness provenance; the two-arm protocol below is the shape that makes the provenance checkable.

## The port shape

Execution binds through one port, `StrategyChecker<Input, Result>`:

- `strategy` — which family member the checker discharges obligations for;
- `identity` — exact checker identity (`CheckerIdentity`): name, version, and content pins, e.g. `{ name: 'lean4', version: '4.33.0', pins: { mathlib: 'db584cd6d46c' } }`;
- `determinism` — the class the checker claims for its outcomes;
- `check(input)` — returns `CheckerOutcome<Result>`: `{ succeeded: true, value }` or `{ succeeded: false, error }` with the full error text.

A checker that ran but could not decide returns `succeeded: false` with the reason.
`succeeded: true` is reserved for a discharged check.

## Verdict epistemics

`DefaultVerdict` carries an optional `certification: VerdictCertification`:

- `strategy` — the family member that certified the verdict;
- `checker` — the exact `CheckerIdentity`;
- `assumptions` — every step the certificate rests on that the checker did not verify; an empty array is an explicit, auditable claim of none;
- `evidenceDigest` — digest of the evidence artifact.

A kernel-checked verdict and a judge-scored verdict can carry the same `{ valid: true, score: 1 }`.
A consumer that cares reads `certification.strategy` and tells them apart.
A consumer that does not read the field sees the exact verdict it always saw; the field is additive and every pre-existing verdict shape remains valid.

The reward-source union `VerifiableRewardSource` (`src/rl/verifiable-reward.ts`) is the same family, so an RL consumer and a certification reader mean the same thing by `proof-kernel`.

## The statement-equivalence protocol

The proof-kernel failure mode gets its own discharge protocol, `defineEquivalenceCheck` (`src/verification-strategy.ts`): the blind two-arm design as a typed primitive.

Two arms derive the formal statement independently, blind to each other and to the outcome.
A bound checker then discharges the obligation that the two statements are equivalent:

- `proved` — the statements match; the formalization gap is closed for this claim;
- `refuted-with-separating-witness` — the statements provably differ, with the witness in hand; **a mismatch is a successful outcome** — it is the formalization gap made visible;
- `unresolved` — the obligation was not discharged; the record keeps the full reason.

The refusals are the design, and each one throws `EquivalenceProtocolError` with a machine-readable `code`:

- an arm that saw the other arm's statement (`arm-saw-other`) or the outcome (`arm-saw-outcome`) invalidates the check — nothing was independently derived;
- a design with any arm count other than 2 (`arm-count`) or with `blind: false` (`not-blind`) is a different protocol, not a parameter choice;
- a refutation without its separating witness (`witness-missing`), a proof carrying one (`witness-on-proved`), an unresolved obligation without its reason (`reason-missing`), and a verdict without its evidence digest (`evidence-missing`) are all refused;
- a checker whose declared strategy differs from the spec's (`checker-strategy-mismatch`) is refused before it runs.

Arm refusals fire before the checker executes: an invalid check must not spend.

## Worked example: the BCWW (4.6) pilot

The pilot this shape reproduces was assembled by hand for the refutation of the BCWW (4.6) inequality, before the substrate carried these types.
Artifacts: `~/bench-cache/bcww-formalization/` (`REPORT.md` is the check-phase report; `PRIORITY.md` records the search-coverage limits).

- Arm A (`armA/Statement.lean`) derived the Lean statement from the paper's LaTeX source (arXiv:1507.05650, display `eqn:cd2`).
- Arm B (`armB/Statement.lean`) derived it from the campaign's artifacts: discovery-lab KB pages plus the standalone verifier source.
- Both arms were blind to each other and committed before the counterexample was read.
- The checker was the Lean kernel: toolchain `leanprover/lean4:v4.33.0`, Mathlib pin `db584cd6d46c` (`check/Check.lean`, no `sorry`).
- Obligation: **proved** — `statement_equivalence` gives the iff at the level of the committed propositions, and the stronger `lhs46_entVec` shows the paper's linear form and the campaign's functional are equal as functions.
- The five-atom counterexample was then kernel-checked against both statements and violates both, with the exact value `(9*log2(3) - 14)/5` bits.
- The certification's assumption list is not empty: the diagonal embedding (classical distribution → quantum state) is argued in prose, not formalized.
  That line is what an honest `VerdictCertification.assumptions` exists to carry.

In this package's terms: `defineEquivalenceCheck({ source: 'proof-kernel', artifact: 'arXiv:1507.05650 inequality (4.6) + five-atom counterexample record', arms: 2, blind: true })`, two `EquivalenceArm` records with `blindness: { toOtherArms: true, toOutcome: true }`, and an `EquivalenceObligation` with `status: 'proved'`, the lean4 `CheckerIdentity`, and the evidence digest of the kernel run.

## What this package refuses to own

- No Lean (or any checker) implementation ships here; the port is the boundary and the consumer binds its own kernel.
- No strategy selection: choosing proof-kernel over agreement for a task is a method decision, and methods live above the substrate (discovery's covenant).
- No certification laundering: a record missing its checker identity, evidence digest, blindness provenance, witness, or reason does not get a weaker record — it gets a thrown `EquivalenceProtocolError`.
